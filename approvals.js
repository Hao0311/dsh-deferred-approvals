/**
 * dsh-deferred-approvals — 非阻塞审批（Host 半）。
 *
 * 目标：审批不再阻塞模型。工具调用需要用户授权时，本插件在审批瀑布最外层
 * 拦截请求：登记为「待办」、立刻给这次调用一个“未执行”的结算结果，模型
 * 同一个回合继续做别的工作；之后用户在界面上点允许/拒绝，插件再把决定以
 * 用户消息送回模型，批准过的调用重试时自动放行（一次性授权）。
 *
 * 关键机制（均为现有公开 API，不依赖任何 @deepseek-ai/* 包）：
 * - `approval/request` 瀑布监听（prepend），抢在 Web 转发层之前拿到请求；
 * - `tools/pre-execute` 记录 callId → 参数指纹，用于一次性授权与同类判定；
 *   同时跟踪“正在执行的工具”：用户做决定时若模型正在长考（本会话无工具在跑），
 *   中断当前思考、立刻送达通知，避免慢模型长考几分钟后基于“没人批准”误撤销待办
 *   （`interruptOnDecision`，默认开；有工具在跑时不中断，退回下一步边界送达）；
 * - `pending` 工具与“最近决定”台账：撤销/查询时能明确区分“已批准 / 已拒绝 / 已过期”，
 *   用户在卡片刚消失时补点的决定也会被尊重（迟到放行）；
 * - `tools/post-execute` 改写被挂起调用的结果文案，指令模型继续干活、完成后撤销；
 * - `agent.steer` / `agent.followup` 把用户决定送回模型；
 * - `ctx.connection.fetch.register` 注册 Client 面板用的 /api 路由。
 *
 * 使用前提：会话审批策略为 `ask`（插件会把显式设为 `never` 的根会话改成 ask），
 * 否则审批服务在瀑布之前就直接拒绝，插件收不到请求。
 *
 * 已知限制：待办只存在 Host 内存里；DSH 重启后丢失（审批本来就是一次性的）。
 */

import { createHash, randomUUID } from 'node:crypto'

const API_BASE = '/api/deferred-approvals'

const DEFAULTS = {
  /** 待办审批有效期（分钟），到期自动作废且不唤醒模型。 */
  ttlMinutes: 15,
  /** 「允许一次」后一次性授权的有效分钟数。 */
  grantMinutes: 5,
  /** 没有在线客户端时的待办软上限；有客户端时不设限。 */
  softCapAway: 20,
  /** 是否把显式设为 `never` 的根会话审批策略切回 `ask`。
   *  默认 `false`：原生不需要审批时，本插件也不制造审批。 */
  forceAskPolicy: false,
  /** 没有在线 Web 客户端时是否交回原生审批（阻塞或 ACP 应答）。 */
  requireLiveClient: true,
  /**
   * 不接管的工具名。默认空：连 `plugin_manager`（装/禁插件）也走挂起——
   * 挂起后模型继续，用户批准后重试一次即可，不会阻塞。留这个配置只为特殊场景。
   */
  excludeTools: [],
  /** 扫描过期/清理内存的间隔。 */
  sweepMs: 20000,
  /**
   * 用户做出决定时，若模型正在思考（本会话没有工具在执行），中断当前思考、立即送达通知。
   * 否则决定只能等到当前这步 LLM 流结束后才可见——慢模型长考 1~3 分钟期间会一直
   * 以为“没人批准”，进而误撤销待办。设为 false 退回“下一步边界送达”。
   */
  interruptOnDecision: true,
}

export const name = 'deferred-approvals'
export const inject = ['tools', 'approval', 'agents', 'systemPrompt']

/**
 * @param ctx - 插件上下文（Cordis）。
 * @param rawConfig - 该行 `config`（可选，未导出 Config 时不校验）。
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const log = (...args) => {
    try {
      ctx.logger?.info?.('[deferred-approvals]', ...args)
    } catch {
      /* 日志失败不影响功能 */
    }
  }
  const warn = (...args) => {
    try {
      ctx.logger?.warn?.('[deferred-approvals]', ...args)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  const state = {
    items: new Map(), // 待办 id -> item
    byFingerprint: new Map(), // 指纹 -> 待办 id（只含 pending）
    callInfo: new Map(), // callId -> 参数快照
    deferredCalls: new Map(), // callId -> 改写文案所需的元数据
    grants: new Map(), // 指纹 -> { sessionId, expiresAt }
    rules: new Map(), // ruleId -> 本对话放行规则
    offline: new Map(), // sessionId -> 待送达文本数组
    audit: [], // 最近的决定记录（调试用）
    executing: new Map(), // callId -> { sessionId, at }：正在执行的工具（决定送达前判断能否安全中断）
    decided: new Map(), // id -> 最近决定快照（pending cancel/list 与“卡片刚消失时的迟到点击”用）
    seq: 0,
  }

  //region ---------------------------------------------------------------- 决策与状态

  function normalizeConfig(config) {
    const merged = { ...DEFAULTS }
    if (config && typeof config === 'object') {
      for (const key of Object.keys(DEFAULTS)) {
        if (config[key] !== undefined) merged[key] = config[key]
      }
    }
    merged.ttlMinutes = positiveNumber(merged.ttlMinutes, DEFAULTS.ttlMinutes)
    merged.grantMinutes = positiveNumber(merged.grantMinutes, DEFAULTS.grantMinutes)
    merged.softCapAway = Math.max(1, Math.floor(positiveNumber(merged.softCapAway, DEFAULTS.softCapAway)))
    merged.sweepMs = Math.max(5000, Math.floor(positiveNumber(merged.sweepMs, DEFAULTS.sweepMs)))
    merged.excludeTools = Array.isArray(merged.excludeTools) ? merged.excludeTools.map(String) : []
    merged.interruptOnDecision = merged.interruptOnDecision !== false
    return merged
  }

  function positiveNumber(value, fallback) {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  function hasLiveClient() {
    try {
      const gateway = ctx.get('typertGateway')
      return typeof gateway?.hasLiveClient === 'function' ? gateway.hasLiveClient() === true : false
    } catch {
      return false
    }
  }

  function audit(kind, item, detail) {
    state.audit.push({ kind, id: item?.id, tool: item?.toolName, detail, at: Date.now() })
    if (state.audit.length > 100) state.audit.splice(0, state.audit.length - 100)
  }

  function itemCount(sessionId) {
    let n = 0
    for (const item of state.items.values()) if (!sessionId || item.sessionId === sessionId) n += 1
    return n
  }

  /** 本会话当前是否有工具在执行（决定送达时：有则不中断，只走下一步边界）。 */
  function hasExecutingTool(sessionId) {
    for (const info of state.executing.values()) {
      if (info.sessionId === sessionId) return true
    }
    return false
  }

  function normalizeId(value) {
    return typeof value === 'string' ? value.trim().replace(/^#/, '') : ''
  }

  /** 记一次已处理结果（批准/拒绝/忽略/过期/撤销），供 pending 工具给出确定答复。 */
  function rememberDecision(item, decision, note) {
    if (!item?.id) return
    state.decided.set(item.id, {
      id: item.id,
      sessionId: item.sessionId,
      toolName: item.toolName,
      mode: item.mode,
      fingerprint: item.fingerprint,
      classKey: item.classKey,
      decision,
      note: typeof note === 'string' ? note : '',
      at: Date.now(),
    })
    while (state.decided.size > 200) {
      const oldest = state.decided.keys().next().value
      state.decided.delete(oldest)
    }
  }

  function minutesAgo(at) {
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60000))
    return minutes < 1 ? '刚刚' : `约 ${minutes} 分钟前`
  }

  function decidedLabel(entry) {
    switch (entry.decision) {
      case 'once':
        return '用户已批准'
      case 'session':
        return '已随同类放行'
      case 'deny':
        return '用户已拒绝'
      case 'dismiss':
        return '用户已忽略'
      case 'expired':
        return '已过期作废'
      case 'cancelled':
        return '已被撤销'
      default:
        return entry.decision
    }
  }

  function removeItem(item) {
    if (!item) return
    state.items.delete(item.id)
    if (state.byFingerprint.get(item.fingerprint) === item.id) state.byFingerprint.delete(item.fingerprint)
  }

  function expireOldest() {
    let oldest = undefined
    for (const item of state.items.values()) {
      if (item.status !== 'pending') continue
      if (oldest === undefined || item.createdAt < oldest.createdAt) oldest = item
    }
    if (oldest !== undefined) {
      removeItem(oldest)
      audit('superseded', oldest, 'cap')
    }
  }

  function createPending(agent, request) {
    const sessionId = agent.session.id
    const info = state.callInfo.get(request.callId)
    const fingerprint = info?.fingerprint ?? `call:${request.callId ?? randomUUID()}`
    const classKey = info?.classKey ?? `${request.toolName}|`
    const existingId = state.byFingerprint.get(fingerprint)
    if (existingId !== undefined) {
      const existing = state.items.get(existingId)
      if (existing && existing.status === 'pending') return { item: existing, duplicate: true }
      state.byFingerprint.delete(fingerprint)
    }

    const cap = hasLiveClient() ? Infinity : cfg.softCapAway
    while (itemCount() >= cap) expireOldest()

    const now = Date.now()
    const id = `A${++state.seq}`
    const item = {
      id,
      sessionId,
      toolName: request.toolName,
      callId: request.callId,
      reason: typeof request.reason === 'string' ? request.reason.slice(0, 500) : '',
      displayReason: request.displayReason,
      summary: info?.summary ?? '',
      mode: info?.mode ?? '',
      justification: info?.justification ?? '',
      fingerprint,
      classKey,
      status: 'pending',
      createdAt: now,
      expiresAt: now + cfg.ttlMinutes * 60000,
    }
    state.items.set(id, item)
    state.byFingerprint.set(fingerprint, id)
    return { item, duplicate: false }
  }

  function ruleFor(sessionId, classKey) {
    for (const rule of state.rules.values()) {
      if (rule.sessionId === sessionId && rule.classKey === classKey) return rule
    }
    return undefined
  }

  function grantFor(sessionId, fingerprint) {
    const grant = state.grants.get(fingerprint)
    if (!grant) return undefined
    if (grant.sessionId !== sessionId || grant.expiresAt <= Date.now()) {
      state.grants.delete(fingerprint)
      return undefined
    }
    return grant
  }

  function snapshot(sessionId) {
    const items = []
    for (const item of state.items.values()) {
      if (item.status !== 'pending') continue
      if (sessionId && item.sessionId !== sessionId) continue
      items.push({
        id: item.id,
        sessionId: item.sessionId,
        toolName: item.toolName,
        reason: item.reason,
        displayReason: item.displayReason,
        summary: item.summary,
        mode: item.mode,
        justification: item.justification,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
      })
    }
    items.sort((a, b) => a.createdAt - b.createdAt)
    const rules = []
    for (const rule of state.rules.values()) {
      if (sessionId && rule.sessionId !== sessionId) continue
      rules.push({
        id: rule.id,
        toolName: rule.toolName,
        mode: rule.mode,
        createdAt: rule.createdAt,
        uses: rule.uses,
      })
    }
    rules.sort((a, b) => a.createdAt - b.createdAt)
    // 最近已处理：让界面也能显示“你刚点的决定被如何处置”（与 pending 工具的台账同源）。
    const decided = []
    const cutoff = Date.now() - cfg.ttlMinutes * 60000
    for (const entry of state.decided.values()) {
      if (sessionId && entry.sessionId !== sessionId) continue
      if (entry.at < cutoff) continue
      decided.push({
        id: entry.id,
        sessionId: entry.sessionId,
        toolName: entry.toolName,
        mode: entry.mode,
        decision: entry.decision,
        at: entry.at,
      })
    }
    decided.sort((a, b) => b.at - a.at)
    if (decided.length > 10) decided.length = 10
    return {
      serverNow: Date.now(),
      ttlMinutes: cfg.ttlMinutes,
      grantMinutes: cfg.grantMinutes,
      items,
      rules,
      decided,
    }
  }

  //endregion

  //region ---------------------------------------------------------------- 送信给模型

  /**
   * 构造一条“宿主事件”消息。source.kind 刻意不是 `user`：这样 Chat 会把它渲染成
   * 上下文通知（inject），而不是用户气泡——审批决定来自宿主与用户点击，不是对话内容。
   */
  function makeUserMessage(text) {
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'deferred-approval' },
    }
    return deepFreeze(message)
  }

  function deepFreeze(value) {
    if (value === null || typeof value !== 'object') return value
    for (const key of Object.keys(value)) deepFreeze(value[key])
    return Object.freeze(value)
  }

  function pushOffline(sessionId, text) {
    const list = state.offline.get(sessionId) ?? []
    list.push(text)
    state.offline.set(sessionId, list)
  }

  function deliver(sessionId, text) {
    if (!text) return 'skipped'
    let agent
    try {
      agent = ctx.agents.get(sessionId)
    } catch {
      agent = undefined
    }
    if (agent === undefined) {
      pushOffline(sessionId, text)
      return 'offline'
    }
    try {
      if (agent.status === 'idle') {
        agent.followup(makeUserMessage(text))
        return 'followup'
      }
      // 模型在跑：决定一做出就该立刻可见。若本会话没有工具在执行（正在长考），
      // 中断当前思考再投递；否则退回到下一步边界送达，避免杀掉运行中的工具。
      if (cfg.interruptOnDecision && !hasExecutingTool(sessionId)) {
        try {
          agent.cancel({ kind: 'hook', reason: 'deferred-approvals: user decision' }, { keepInbox: true })
          log('interrupted running agent to deliver decision', sessionId)
          agent.followup(
            makeUserMessage(
              text + '\n（宿主已中断你刚才进行中的思考以及时送达本通知；被截断的思考已保留在历史里，属正常现象。）',
            ),
          )
          return 'interrupted'
        } catch (error) {
          warn('interrupt failed, falling back to steer', error?.message ?? error)
        }
      }
      try {
        agent.steer(makeUserMessage(text))
      } catch {
        agent.followup(makeUserMessage(text))
      }
      return 'steered'
    } catch (error) {
      warn('deliver failed', error?.message ?? error)
      pushOffline(sessionId, text)
      return 'offline'
    }
  }

  function flushOffline(sessionId) {
    const list = state.offline.get(sessionId)
    if (!list || list.length === 0) return
    state.offline.delete(sessionId)
    for (const text of list) deliver(sessionId, text)
  }

  //endregion

  //region ---------------------------------------------------------------- 审批拦截

  ctx.on(
    'approval/request',
    async function deferredApproval(request, next) {
      try {
        if (!shouldDefer(request)) {
          warn(
            'approval delegated to native (blocking):',
            request?.toolName ?? '?',
            '| callId=' + String(request?.callId ?? '-'),
            '| reason=' + delegationReason(request),
          )
          return next()
        }
        const sessionId = request.agent.session.id
        const info = state.callInfo.get(request.callId)

        if (info) {
          const grant = grantFor(sessionId, info.fingerprint)
          if (grant) {
            state.grants.delete(info.fingerprint)
            audit('auto-grant-once', { id: 'grant', toolName: request.toolName }, info.fingerprint)
            return 'allowed-once'
          }
          const rule = ruleFor(sessionId, info.classKey)
          if (rule) {
            rule.uses += 1
            audit('auto-grant-session', { id: rule.id, toolName: request.toolName }, info.classKey)
            return 'allowed-once'
          }
        }

        const created = createPending(request.agent, request)
        state.deferredCalls.set(request.callId, {
          at: Date.now(),
          itemId: created.item.id,
          duplicate: created.duplicate,
        })
        audit('deferred', created.item, created.duplicate ? 'duplicate' : undefined)
        return 'rejected'
      } catch (error) {
        warn('approval intercept failed', error?.message ?? error)
        return next()
      }
    },
    { prepend: true },
  )

  function shouldDefer(request) {
    if (!request || !request.agent) return false
    if (!request.callId) return false
    // 注意：这里不能拿 forceAskPolicy 当开关。forceAskPolicy 只决定“是否改会话策略”，
    // 而“要不要接管这次审批”取决于原生是否真的发生了审批（能走到这里就是发生了）。
    if (cfg.excludeTools.includes(request.toolName)) return false
    if (cfg.requireLiveClient && !hasLiveClient()) return false
    return true
  }

  /** 记录“为什么把这次审批交回原生阻塞路径”，方便排查漏挂起。 */
  function delegationReason(request) {
    if (!request || !request.agent) return 'no-agent'
    if (!request.callId) return 'no-callId'
    if (cfg.excludeTools.includes(request.toolName)) return 'excluded-tool'
    if (cfg.requireLiveClient && !hasLiveClient()) return 'no-live-client'
    return 'unknown'
  }

  //endregion

  //region ---------------------------------------------------------------- 参数快照 / 结果改写

  ctx.on('tools/pre-execute', function captureCall(exec, next) {
    try {
      if (exec && exec.callId && exec.agent) {
        const args = exec.arguments
        const mode = args && typeof args === 'object' && typeof args.sandbox_permissions === 'string' ? args.sandbox_permissions : ''
        const justification =
          args && typeof args === 'object' && typeof args.justification === 'string' ? args.justification : ''
        state.callInfo.set(exec.callId, {
          at: Date.now(),
          name: exec.name,
          sessionId: exec.agent.session.id,
          fingerprint: fingerprintOf(exec.name, args),
          classKey: `${exec.name}|${mode}`,
          mode,
          justification,
          summary: summarize(exec.name, args),
        })
        state.executing.set(exec.callId, { sessionId: exec.agent.session.id, at: Date.now() })
      }
    } catch (error) {
      warn('capture call failed', error?.message ?? error)
    }
    return next()
  })

  ctx.on('tools/post-execute', async function rewriteDeferredResult(exec, result, next) {
    const callId = exec?.callId
    if (callId) state.executing.delete(callId)
    const decision = await next()
    /* 稳定性修复（2026-11-06 审计 P1）：exec 可能为空/无 callId（上方用可选链即为此），
       此处曾裸解引用 exec.callId，post-execute 钩子会抛异常 */
    const meta = callId ? state.deferredCalls.get(callId) : undefined
    if (!meta) return decision
    state.deferredCalls.delete(callId)
    if (decision.kind !== 'accept') return decision
    const item = state.items.get(meta.itemId)
    return { kind: 'block', feedback: [{ type: 'text', text: deferredNotice(item, meta, exec) }] }
  })

  function deferredNotice(item, meta, exec) {
    const id = item?.id ?? '?'
    const toolName = item?.toolName ?? exec.name
    const mode = item?.mode ? ` · ${item.mode}` : ''
    if (meta.duplicate) {
      return `[审批已挂起] #${id} ${toolName}${mode} 仍在等待用户，本次未执行。不要重复重试同一调用；继续做别的工作，或结束本回合等待宿主事件。`
    }
    return [
      `[审批已挂起] #${id} ${toolName}${mode} 未执行，用户可在后台审批。`,
      '不要等待也不要反复重试：先做其它工作；若这是唯一要做的事，直接结束本回合等待宿主事件（用户批准后你会被立即唤醒，届时再核对重试）。',
      `只有已用其它方式完成/明确不再需要时，才调用 pending(action="cancel", id="${id}", reason="...") 撤销；不要因为等待过久而撤销。`,
    ].join('\n')
  }

  function fingerprintOf(toolName, args) {
    /* 安全修复（2026-11-06 审计 P1）：数组参数曾折叠成 {}，不同数组参数共享同一指纹，
       会把一次授权放大到所有同工具数组调用；保留数组内容参与哈希 */
    const copy = args && typeof args === 'object' ? (Array.isArray(args) ? [...args] : { ...args }) : {}
    // 只比较“会产生同样效果”的参数：说明文字、理由、超时都不改变授权对象本身。
    delete copy.justification
    delete copy.description
    delete copy.timeoutMs
    return `${toolName}:${createHash('sha256').update(stableStringify(copy)).digest('hex').slice(0, 32)}`
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
    if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }

  function summarize(toolName, args) {
    if (!args || typeof args !== 'object') return ''
    if (typeof args.command === 'string') return args.command
    if (typeof args.path === 'string') return args.path
    if (typeof args.file_path === 'string') return args.file_path
    if (typeof args.url === 'string') return args.url
    try {
      return stableStringify(args)
    } catch {
      return ''
    }
  }

  function truncate(text, max) {
    const value = typeof text === 'string' ? text : String(text ?? '')
    return value.length > max ? `${value.slice(0, max)}…` : value
  }

  //endregion

  //region ---------------------------------------------------------------- 用户决定

  function decideItem(id, decision, note, sessionId) {
    const key = normalizeId(id)
    const noteText = typeof note === 'string' ? note.trim().slice(0, 500) : ''
    const now = Date.now()
    // sessionId 为可选增强：带了就校验归属（防跨会话误点），旧客户端不带则放行（平滑过渡）。
    const owned = (entry) => !sessionId || entry.sessionId === sessionId
    const item = state.items.get(key)

    if (item && item.status === 'pending' && !owned(item)) return { ok: false, error: 'not-found' }
    if (!item || item.status !== 'pending') {
      // 迟到的决定：待办刚被模型撤销/过期，但用户在还没刷新掉的卡片上点了按钮——尊重用户点击。
      const remembered = state.decided.get(key)
      if (!remembered || !owned(remembered) || now - remembered.at > cfg.grantMinutes * 60000) {
        return { ok: false, error: 'not-found' }
      }
      return decideRemembered(remembered, decision, noteText, now)
    }

    if (decision === 'dismiss') {
      rememberDecision(item, 'dismiss', noteText)
      removeItem(item)
      audit('dismissed', item)
      return { ok: true }
    }
    if (decision === 'deny') {
      rememberDecision(item, 'deny', noteText)
      removeItem(item)
      audit('denied', item)
      deliver(item.sessionId, denyNotice(item, noteText))
      return { ok: true }
    }
    if (decision === 'once') {
      state.grants.set(item.fingerprint, { sessionId: item.sessionId, expiresAt: now + cfg.grantMinutes * 60000 })
      rememberDecision(item, 'once', noteText)
      removeItem(item)
      audit('allowed-once', item)
      deliver(item.sessionId, approveOnceNotice(item, noteText))
      return { ok: true }
    }
    if (decision === 'session') {
      const { rule, others } = grantSessionRule(item, now)
      rememberDecision(item, 'session', noteText)
      removeItem(item)
      for (const other of others) {
        rememberDecision(other, 'session', noteText)
        removeItem(other)
      }
      const batch = [item, ...others]
      audit('allowed-session', item, rule.id)
      deliver(item.sessionId, approveSessionNotice(item, rule, batch))
      return { ok: true, ruleId: rule.id }
    }
    return { ok: false, error: 'bad-decision' }
  }

  function grantSessionRule(primary, now) {
    const rule = {
      id: `R${++state.seq}`,
      sessionId: primary.sessionId,
      toolName: primary.toolName,
      mode: primary.mode,
      classKey: primary.classKey,
      createdAt: now,
      uses: 0,
    }
    state.rules.set(rule.id, rule)
    const others = []
    for (const other of [...state.items.values()]) {
      if (
        other.id !== primary.id &&
        other.status === 'pending' &&
        other.sessionId === primary.sessionId &&
        other.classKey === primary.classKey
      ) {
        others.push(other)
      }
    }
    return { rule, others }
  }

  /** 待办已不在 pending 时（刚被撤销/过期/已处理）的迟到决定：仍然尊重用户这次点击。 */
  function decideRemembered(entry, decision, note, now) {
    const prior = entry.decision
    // 双击/重复提交同一决定：幂等返回，不重复授权、不重复打扰模型。
    if (prior === decision) return { ok: true, late: true, unchanged: true }
    if (decision === 'dismiss') {
      entry.decision = 'dismiss'
      entry.note = note
      entry.at = now
      audit('dismissed-late', entry)
      return { ok: true, late: true }
    }
    if (decision === 'deny') {
      // 用户最新意图优先：撤掉此前留下的放行。
      state.grants.delete(entry.fingerprint)
      for (const rule of [...state.rules.values()]) {
        if (rule.sessionId === entry.sessionId && rule.classKey === entry.classKey) state.rules.delete(rule.id)
      }
      entry.decision = 'deny'
      entry.note = note
      entry.at = now
      audit('denied-late', entry, note)
      deliver(entry.sessionId, denyNotice(entry, note))
      return { ok: true, late: true }
    }
    if (decision === 'once') {
      state.grants.set(entry.fingerprint, { sessionId: entry.sessionId, expiresAt: now + cfg.grantMinutes * 60000 })
      entry.decision = 'once'
      entry.note = note
      entry.at = now
      audit('allowed-once-late', entry)
      deliver(entry.sessionId, lateApproveNotice(entry, prior))
      return { ok: true, late: true }
    }
    if (decision === 'session') {
      const { rule, others } = grantSessionRule(entry, now)
      for (const other of others) {
        rememberDecision(other, 'session', note)
        removeItem(other)
      }
      entry.decision = 'session'
      entry.note = note
      entry.at = now
      audit('allowed-session-late', entry, rule.id)
      deliver(entry.sessionId, approveSessionNotice(entry, rule, [entry, ...others]))
      return { ok: true, ruleId: rule.id, late: true }
    }
    return { ok: false, error: 'bad-decision' }
  }

  function lateApproveNotice(entry, prior) {
    const mode = entry.mode ? ` · ${entry.mode}` : ''
    const context =
      prior === 'cancelled'
        ? '——虽然该待办刚被你撤销'
        : prior === 'expired'
          ? '——虽然该待办已过期'
          : ''
    return `[宿主事件] 用户批准了 #${entry.id}（${entry.toolName}${mode}）${context}；一次性授权已记录（${cfg.grantMinutes} 分钟内有效）。若原操作仍需执行，用相同参数重试即可自动放行；已完成则不要重做。`
  }

  function revokeRule(ruleId) {
    const rule = state.rules.get(typeof ruleId === 'string' ? ruleId : '')
    if (!rule) return { ok: false, error: 'not-found' }
    state.rules.delete(rule.id)
    audit('rule-revoked', { id: rule.id, toolName: rule.toolName })
    return { ok: true }
  }

  function approveOnceNotice(item, note) {
    const mode = item.mode ? ` · ${item.mode}` : ''
    return `[宿主事件] 用户已批准 #${item.id}（${item.toolName}${mode}，一次性授权${note ? `；备注：${note}` : ''}）。先核对是否仍需要：需要就用相同参数重试（宿主自动放行），已完成则不要重做。`
  }

  function approveSessionNotice(item, rule, batch) {
    const mode = rule.mode ? ` · ${rule.mode}` : ''
    const ids = batch.map((entry) => `#${entry.id}`).join('、')
    return `[宿主事件] 用户已放行本对话的同类操作（${rule.toolName}${mode}），并批准 ${ids}。需要就重试（宿主自动放行），已完成/不需要的不要重做。`
  }

  function denyNotice(item, note) {
    const mode = item.mode ? ` · ${item.mode}` : ''
    return `[宿主事件] 用户拒绝了 #${item.id}（${item.toolName}${mode}）${note ? `：${note}` : ''}。该操作未执行，请换方式或调整方案。`
  }

  //endregion

  //region ---------------------------------------------------------------- 模型侧工具

  const pendingTool = {
    name: 'pending',
    description:
      '查看或撤销挂起的审批待办（挂起=未执行、不阻塞）。list 会一并列出最近已批准/拒绝/撤销的待办；已用其它方式完成或不再需要时，调用 action="cancel" 撤销对应待办（id 见结果里的 #A1）。若该待办刚被用户决定，cancel 会直接告诉你结果而不是误撤。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'cancel'],
          description: 'list 查看当前会话的待办、最近决定与已放行规则；cancel 按 id 撤销一个待办。',
        },
        id: {
          type: 'string',
          description: 'cancel 时必填：待办编号，例如 "A1"（带不带 # 均可）。',
        },
        reason: {
          type: 'string',
          description: '撤销原因（一句话，便于事后审计）。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : String(value ?? '') }]
      },
    },
    isConcurrencySafe() {
      return true
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id
      if (!sessionId) return '当前调用没有会话，无法管理待办。'
      if (args.action === 'list') return listPendingText(sessionId)
      if (args.action === 'cancel') {
        const id = normalizeId(args.id)
        const item = state.items.get(id)
        if (item && item.status === 'pending' && item.sessionId === sessionId) {
          const reason = typeof args.reason === 'string' ? args.reason.slice(0, 200) : undefined
          rememberDecision(item, 'cancelled', reason)
          removeItem(item)
          audit('cancelled-by-model', item, reason)
          return `已撤销待办 #${item.id}（${item.toolName}）。用户不会再看到这条请求。`
        }
        const decided = state.decided.get(id)
        if (decided && decided.sessionId === sessionId && Date.now() - decided.at <= cfg.ttlMinutes * 60000) {
          return decidedNotice(decided)
        }
        return `没有找到待办 ${id || '(空 id)'}；可能已过期。用 action="list" 可查看最近处理记录。`
      }
      return '未知 action；支持 list / cancel。'
    },
  }

  /** 对一个已处理待办的确定答复——避免模型把“已被批准”误读成“可以撤销”。 */
  function decidedNotice(entry) {
    const ago = minutesAgo(entry.at)
    const mode = entry.mode ? ` · ${entry.mode}` : ''
    switch (entry.decision) {
      case 'once': {
        const grantLive = Date.now() - entry.at <= cfg.grantMinutes * 60000
        return grantLive
          ? `待办 #${entry.id}（${entry.toolName}${mode}）${ago}已被用户批准（一次性授权，${cfg.grantMinutes} 分钟内有效）。不要撤销——若原操作仍需执行，直接用相同参数重试即可自动放行；已完成就不用重做。`
          : `待办 #${entry.id}（${entry.toolName}${mode}）${ago}已被用户批准过，但一次性授权已过期（${cfg.grantMinutes} 分钟）。若原操作仍需执行，重新调用会再次挂起等待用户批准；已完成就不用重做。`
      }
      case 'session':
        return `待办 #${entry.id}（${entry.toolName}${mode}）${ago}已随「本对话允许同类」批准。同类调用重试会自动放行，无需撤销。`
      case 'deny':
        return `待办 #${entry.id}（${entry.toolName}${mode}）${ago}已被用户拒绝${entry.note ? `：${entry.note}` : ''}。无需撤销，请换方式或调整方案。`
      case 'dismiss':
        return `待办 #${entry.id}（${entry.toolName}${mode}）${ago}已被用户忽略关闭（未批准也未拒绝）。如仍需要，重新发起调用会生成新待办。`
      case 'expired':
        return `待办 #${entry.id}（${entry.toolName}${mode}）${ago}已过期自动作废。如仍需要，重新发起调用即可。`
      case 'cancelled':
        return `待办 #${entry.id}（${entry.toolName}${mode}）${ago}已被你撤销${entry.note ? `（原因：${entry.note}）` : ''}。如仍需要，重新发起调用即可。`
      default:
        return `待办 #${entry.id} 已处理（${decidedLabel(entry)}，${ago}）。`
    }
  }

  function listPendingText(sessionId) {
    const items = []
    for (const item of state.items.values()) {
      if (item.status === 'pending' && item.sessionId === sessionId) items.push(item)
    }
    items.sort((a, b) => a.createdAt - b.createdAt)
    const rules = []
    for (const rule of state.rules.values()) if (rule.sessionId === sessionId) rules.push(rule)
    const lines = []
    if (items.length === 0) lines.push('当前没有挂起的审批待办。')
    else {
      lines.push(`当前有 ${items.length} 项挂起的审批待办：`)
      for (const item of items) {
        const remaining = Math.max(0, Math.round((item.expiresAt - Date.now()) / 60000))
        lines.push(`#${item.id} · ${item.toolName}${item.mode ? `（${item.mode}）` : ''} · 剩余约 ${remaining} 分钟`)
        if (item.summary) lines.push(`  操作：${truncate(item.summary, 200)}`)
        if (item.reason) lines.push(`  理由：${truncate(item.reason, 200)}`)
      }
    }
    if (rules.length > 0) {
      lines.push(`本对话已放行 ${rules.length} 类操作：`)
      for (const rule of rules) {
        lines.push(`- ${rule.toolName}${rule.mode ? ` · ${rule.mode}` : ''}（已自动放行 ${rule.uses} 次）`)
      }
    }
    const now = Date.now()
    const decided = []
    for (const entry of state.decided.values()) {
      if (entry.sessionId === sessionId && now - entry.at <= cfg.ttlMinutes * 60000) decided.push(entry)
    }
    decided.sort((a, b) => b.at - a.at)
    if (decided.length > 0) {
      lines.push('最近已处理的待办（用于核对，避免误撤）：')
      for (const entry of decided.slice(0, 5)) {
        lines.push(
          `#${entry.id} · ${entry.toolName}${entry.mode ? `（${entry.mode}）` : ''} · ${decidedLabel(entry)} · ${minutesAgo(entry.at)}`,
        )
      }
    }
    return lines.join('\n')
  }

  ctx.effect(() => ctx.tools.register(pendingTool), 'deferred-approvals: pending tool')

  //endregion

  //region ---------------------------------------------------------------- 系统提示

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'deferred-approvals:policy',
        order: 950,
        text: [
          '## 审批挂起（非阻塞）',
          '需要用户授权的调用会挂起为待办（#A1）并立即返回“未执行”，不会阻塞。',
          '- 不要等待也不要反复重试：继续做其它工作；若这是唯一要做的事，直接结束本回合等待宿主事件（用户批准后你会被立即唤醒）。',
          '- 不要因为等待过久而撤销待办；只有已用其它方式完成/明确不再需要时，才调用 pending(action="cancel", id="A1", reason="...")。',
          '- 若你的思考被宿主中断、紧接着收到批准/拒绝事件，属正常：决定一做出就会即时送达，被截断的思考已保留在历史里。',
          '- 收到批准/拒绝的宿主事件后先核对是否仍需；已完成就不要重做。批准只来自用户，不要自称已获批准。',
        ].join('\n'),
      }),
    'deferred-approvals: policy section',
  )

  //endregion

  //region ---------------------------------------------------------------- 会话策略 / 待办送达

  function applyPolicy(agent) {
    if (!cfg.forceAskPolicy || !agent) return
    try {
      const override = ctx.approval.overrideOf(agent.session)
      if (override === 'never') ctx.approval.setPolicy(agent, 'ask')
    } catch (error) {
      warn('apply approval policy failed', error?.message ?? error)
    }
  }

  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload?.agent
      if (!agent) return
      const roots = ctx.agents.roots()
      if (!roots.includes(agent)) return
      applyPolicy(agent)
      flushOffline(agent.session.id)
    } catch (error) {
      warn('agent/created handling failed', error?.message ?? error)
    }
  })

  try {
    for (const agent of ctx.agents.roots()) applyPolicy(agent)
  } catch (error) {
    warn('initial policy pass failed', error?.message ?? error)
  }

  //endregion

  //region ---------------------------------------------------------------- 过期清理

  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        const now = Date.now()
        for (const item of [...state.items.values()]) {
          if (item.status === 'pending' && item.expiresAt <= now) {
            rememberDecision(item, 'expired', '')
            removeItem(item)
            audit('expired', item)
          }
        }
        for (const [fingerprint, grant] of [...state.grants]) {
          if (grant.expiresAt <= now) state.grants.delete(fingerprint)
        }
        for (const [callId, info] of [...state.callInfo]) {
          if (now - info.at > 3600000) state.callInfo.delete(callId)
        }
        for (const [callId, meta] of [...state.deferredCalls]) {
          if (now - meta.at > 3600000) state.deferredCalls.delete(callId)
        }
        for (const [id, entry] of [...state.decided]) {
          if (now - entry.at > cfg.ttlMinutes * 60000) state.decided.delete(id)
        }
        // 泄漏兜底：post-execute 理应配对出现；6 小时未归还的条目按泄漏清理（宁可不中断，也不误杀长工具）。
        for (const [callId, info] of [...state.executing]) {
          if (now - info.at > 21600000) state.executing.delete(callId)
        }
      } catch (error) {
        warn('sweep failed', error?.message ?? error)
      }
    }, cfg.sweepMs)
    return () => clearInterval(timer)
  }, 'deferred-approvals: sweep')

  //endregion

  //region ---------------------------------------------------------------- Client HTTP 接口

  ctx.inject(['connection'], (connectionCtx) => {
    const fetcher = connectionCtx.connection?.fetch
    if (!fetcher || typeof fetcher.register !== 'function') {
      warn('connection.fetch unavailable; client panel will not load data')
      return
    }
    const routes = [
      {
        path: `${API_BASE}/state`,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => {
          const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
          return jsonResponse(200, { ok: true, ...snapshot(sessionId) })
        },
      },
      {
        path: `${API_BASE}/decide`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const body = await readJson(request)
          if (!body || typeof body.id !== 'string') return jsonResponse(400, { ok: false, error: 'bad-request' })
          const decision = String(body.decision ?? '')
          if (!['once', 'session', 'deny', 'dismiss'].includes(decision)) {
            return jsonResponse(400, { ok: false, error: 'bad-decision' })
          }
          return jsonResponse(
            200,
            decideItem(body.id, decision, body.note, typeof body.sessionId === 'string' ? body.sessionId : ''),
          )
        },
      },
      {
        path: `${API_BASE}/revoke`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const body = await readJson(request)
          if (!body || typeof body.ruleId !== 'string') return jsonResponse(400, { ok: false, error: 'bad-request' })
          return jsonResponse(200, revokeRule(body.ruleId))
        },
      },
    ]
    for (const route of routes) {
      connectionCtx.effect(() => fetcher.register(route), `deferred-approvals: ${route.path}`)
    }
  })

  async function readJson(request) {
    try {
      return await request.json()
    } catch {
      return undefined
    }
  }

  function jsonResponse(status, value) {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  //endregion
}
