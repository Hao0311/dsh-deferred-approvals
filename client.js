/**
 * dsh-deferred-approvals — 非阻塞审批（Client 半）。
 *
 * 入口在输入框底部那行操作条（模型选择/权限管理那一行，conversation.input.right）：
 * 有待办时显示橙色小点 + “待审批 N”，点开从该行向上弹出审批弹窗；弹窗可手动关闭，
 * 关闭后输入框照常使用（输入框从始至终不被接管/隐藏）。会话列表里对应对话会显示
 * 原生审批同款的橙色状态点（通过发布一条 kind='approval' 的待处理交互实现）。
 *
 * 数据来自 Host 半注册的 /api/deferred-approvals/* 路由（同源 fetch，走浏览器 cookie 鉴权），
 * 可见时每 2.5 秒轮询一次。
 */

window.__ModuleLoader__.load({
  id: 'dsh-deferred-approvals',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'deferred-approvals'
    const API = '/api/deferred-approvals'
    const POLL_MS = 2500

    const zh = {
      label: '待审批',
      title: '待审批',
      pendingCount: '待审批 {count}',
      rulesCount: '已放行 {count} 类',
      empty: '当前没有挂起的审批。',
      allowOnce: '允许一次',
      allowClass: '本对话允许同类',
      deny: '拒绝',
      dismiss: '忽略',
      note: '备注（可选，会转给模型）',
      revoke: '撤销',
      rulesTitle: '本对话已放行',
      ruleUses: '已自动放行 {count} 次',
      remaining: '剩余约 {minutes} 分钟',
      expired: '已过期',
      busy: '处理中…',
      reason: '理由',
      close: '关闭',
      decidedTitle: '最近已处理',
      decidedCount: '已处理 {count} 项',
      decOnce: '已批准',
      decSession: '已放行同类',
      decDeny: '已拒绝',
      decDismiss: '已忽略',
      decExpired: '已过期',
      decCancelled: '已撤销',
      decidedNow: '刚刚',
      decidedAgo: '{minutes} 分钟前',
    }

    const en = {
      label: 'Pending approvals',
      title: 'Pending approvals',
      pendingCount: '{count} pending approval(s)',
      rulesCount: '{count} class(es) allowed',
      empty: 'No pending approvals.',
      allowOnce: 'Allow once',
      allowClass: 'Allow this class for this conversation',
      deny: 'Deny',
      dismiss: 'Dismiss',
      note: 'Note (optional, forwarded to the model)',
      revoke: 'Revoke',
      rulesTitle: 'Allowed for this conversation',
      ruleUses: 'auto-allowed {count} time(s)',
      remaining: '~{minutes} min left',
      expired: 'expired',
      busy: 'Working…',
      reason: 'Reason',
      close: 'Close',
      decidedTitle: 'Recently decided',
      decidedCount: '{count} decided',
      decOnce: 'allowed once',
      decSession: 'class allowed',
      decDeny: 'denied',
      decDismiss: 'dismissed',
      decExpired: 'expired',
      decCancelled: 'cancelled',
      decidedNow: 'just now',
      decidedAgo: '{minutes} min ago',
    }

    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole))
    }

    async function fetchJSON(path, options) {
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    const EMPTY = { items: [], rules: [], decided: [], serverNow: 0 }

    const DECISION_KEYS = {
      once: 'decOnce',
      session: 'decSession',
      deny: 'decDeny',
      dismiss: 'decDismiss',
      expired: 'decExpired',
      cancelled: 'decCancelled',
    }

    const store = {
      data: new Map(),
      listeners: new Set(),
      refresh: undefined,
      get(sessionId) {
        return this.data.get(sessionId) ?? EMPTY
      },
      set(sessionId, value) {
        if (value === undefined) this.data.delete(sessionId)
        else this.data.set(sessionId, value)
        for (const listener of this.listeners) listener()
      },
      clear() {
        this.data.clear()
        for (const listener of this.listeners) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    const MODE_LABELS = {
      'read-only': '只读',
      'workspace-write': '工作区写入',
      'danger-full-access': '完全访问',
    }

    function modeLabel(mode) {
      if (!mode) return ''
      return MODE_LABELS[mode] ?? mode
    }

    function groupState(body) {
      const grouped = new Map()
      const ensure = (sessionId) => {
        let entry = grouped.get(sessionId)
        if (entry === undefined) {
          entry = { items: [], rules: [], decided: [], serverNow: body.serverNow ?? 0 }
          grouped.set(sessionId, entry)
        }
        return entry
      }
      for (const item of body.items ?? []) ensure(item.sessionId).items.push(item)
      for (const rule of body.rules ?? []) ensure(rule.sessionId).rules.push(rule)
      for (const entry of body.decided ?? []) ensure(entry.sessionId).decided.push(entry)
      for (const entry of grouped.values()) {
        entry.items.sort((a, b) => a.createdAt - b.createdAt)
        entry.rules.sort((a, b) => a.createdAt - b.createdAt)
        entry.decided.sort((a, b) => b.at - a.at)
      }
      return grouped
    }

    function createChip(tr) {
      return function DeferredApprovalsChip(props) {
        const t = typeof props.t === 'function' ? props.t : tr
        const sessionId = props.sessionId
        const [state, setState] = React.useState(() => store.get(sessionId))
        const [open, setOpen] = React.useState(false)
        const [note, setNote] = React.useState('')
        const [busyId, setBusyId] = React.useState('')
        const [error, setError] = React.useState('')
        const alive = React.useRef(true)
        const rootRef = React.useRef(null)
        const dialogRef = React.useRef(null)
        // 已自动弹过（或用户手动关掉）的待办 id：只有新出现的待办才会再次自动弹出。
        const seenItems = React.useRef(new Set())
        const itemsRef = React.useRef([])
        itemsRef.current = state.items ?? []

        /**
         * 关闭面板：把当前待办记为已读，之后只有新审批到达才再自动弹到最上层。
         * Esc / 点空白 / 关闭按钮 / 再点 chip 都走这里，保持手动可关闭。
         */
        const closePanel = React.useCallback(() => {
          for (const item of itemsRef.current) seenItems.current.add(item.id)
          setOpen(false)
        }, [])

        React.useEffect(() => {
          alive.current = true
          setState(store.get(sessionId))
          const unsubscribe = store.subscribe(() => {
            if (alive.current) setState(store.get(sessionId))
          })
          return () => {
            alive.current = false
            unsubscribe()
          }
        }, [sessionId])

        // 原生 <dialog> 会进入 top layer，不受侧边栏/输入框的层叠上下文和 overflow 裁剪影响。
        React.useEffect(() => {
          const dialog = dialogRef.current
          if (!dialog) return undefined
          const onClose = () => closePanel()
          dialog.addEventListener('close', onClose)
          return () => dialog.removeEventListener('close', onClose)
        }, [closePanel])

        React.useEffect(() => {
          const dialog = dialogRef.current
          if (!dialog) return undefined
          try {
            if (open && !dialog.open) dialog.showModal()
            else if (!open && dialog.open) dialog.close()
          } catch {
            /* showModal 失败时保持关闭，不影响输入框 */
          }
          return undefined
        }, [open])

        React.useEffect(() => {
          if (open && (state.items ?? []).length === 0 && (state.rules ?? []).length === 0 && (state.decided ?? []).length === 0)
            closePanel()
        }, [open, state, closePanel])

        // 收到新的审批待办时直接弹到最上层（原生 <dialog> top layer），不用再点一下。
        // 只对「没见过」的待办弹一次；用户关掉后同一批不会反复弹，新审批到达才会再弹。
        React.useEffect(() => {
          const fresh = (state.items ?? []).filter((item) => !seenItems.current.has(item.id))
          if (fresh.length === 0) return
          for (const item of fresh) seenItems.current.add(item.id)
          setOpen(true)
        }, [state])

        const decide = async (id, decision) => {
          if (busyId) return
          setBusyId(id)
          setError('')
          try {
            const result = await fetchJSON(`${API}/decide`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id, decision, note, sessionId }),
            })
            if (!result?.ok) setError(result?.error ?? 'failed')
            setNote('')
            await store.refresh?.()
          } catch (cause) {
            setError(String(cause?.message ?? cause))
          } finally {
            setBusyId('')
          }
        }

        const revoke = async (ruleId) => {
          if (busyId) return
          setBusyId(ruleId)
          setError('')
          try {
            await fetchJSON(`${API}/revoke`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ruleId }),
            })
            await store.refresh?.()
          } catch (cause) {
            setError(String(cause?.message ?? cause))
          } finally {
            setBusyId('')
          }
        }

        const items = state.items ?? []
        const rules = state.rules ?? []
        const decided = state.decided ?? []
        if (items.length === 0 && rules.length === 0 && decided.length === 0) return null
        const headline = (tFn) =>
          items.length > 0
            ? format(tFn('pendingCount'), { count: items.length })
            : rules.length > 0
              ? format(tFn('rulesCount'), { count: rules.length })
              : format(tFn('decidedCount'), { count: decided.length })

        const offset = (state.serverNow ?? 0) - Date.now()
        const now = Date.now() + offset
        const chip = h(
          'button',
          {
            type: 'button',
            onClick: () => {
              if (open) {
                closePanel()
                return
              }
              for (const item of itemsRef.current) seenItems.current.add(item.id)
              setOpen(true)
            },
            'aria-expanded': open,
            title: t('title'),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              height: '24px',
              padding: '0 8px',
              borderRadius: '999px',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-1)',
              color: items.length > 0 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)',
              fontSize: '11px',
              lineHeight: '1',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flex: 'none',
            },
          },
          h('span', {
            key: 'dot',
            style: {
              width: '7px',
              height: '7px',
              borderRadius: '999px',
              flex: 'none',
              background: items.length > 0 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-idle-primary)',
            },
          }),
          h(
            'span',
            { key: 'text' },
            headline(t),
          ),
        )

        const button = (label, onClick, options = {}) =>
          h(
            'button',
            {
              type: 'button',
              disabled: Boolean(busyId),
              onClick,
              style: {
                height: '26px',
                padding: '0 10px',
                borderRadius: '6px',
                border: options.primary ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l2)',
                background: options.primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                color: options.primary
                  ? 'var(--dsw-alias-bg-base)'
                  : options.danger
                    ? 'var(--dsw-alias-state-error-primary)'
                    : 'var(--dsw-alias-label-primary)',
                fontSize: '12px',
                lineHeight: '1',
                cursor: busyId ? 'default' : 'pointer',
                opacity: busyId ? 0.6 : 1,
                whiteSpace: 'nowrap',
              },
            },
            label,
          )

        const itemBlock = (item) => {
          const remaining = Math.max(0, Math.round((item.expiresAt - now) / 60000))
          return h(
            'div',
            {
              key: item.id,
              style: {
                borderTop: '1px solid var(--dsw-alias-border-l1)',
                padding: '10px 0',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
              h(
                'span',
                { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontWeight: 600 } },
                `#${item.id} · ${item.toolName}${item.mode ? ` · ${modeLabel(item.mode)}（仅本次调用）` : ''}`,
              ),
              h(
                'span',
                {
                  style: {
                    color: remaining > 0 ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-error-primary)',
                    fontSize: '11px',
                  },
                },
                remaining > 0 ? format(t('remaining'), { minutes: remaining }) : t('expired'),
              ),
            ),
            item.summary
              ? h(
                  'code',
                  {
                    style: {
                      display: 'block',
                      color: 'var(--dsw-alias-label-primary)',
                      background: 'var(--dsw-alias-bg-layer-2)',
                      border: '1px solid var(--dsw-alias-border-l1)',
                      borderRadius: '6px',
                      padding: '6px 8px',
                      fontSize: '12px',
                      lineHeight: '18px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: '96px',
                      overflow: 'auto',
                    },
                  },
                  item.summary,
                )
              : null,
            item.reason
              ? h(
                  'div',
                  { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' } },
                  `${t('reason')}：${item.reason}`,
                )
              : null,
            h(
              'div',
              { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' } },
              button(t('allowOnce'), () => decide(item.id, 'once'), { primary: true }),
              button(t('allowClass'), () => decide(item.id, 'session')),
              button(t('deny'), () => decide(item.id, 'deny'), { danger: true }),
              button(t('dismiss'), () => decide(item.id, 'dismiss')),
              busyId === item.id
                ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' } }, t('busy'))
                : null,
            ),
          )
        }

        const ruleBlock = (rule) =>
          h(
            'div',
            {
              key: rule.id,
              style: {
                borderTop: '1px solid var(--dsw-alias-border-l1)',
                padding: '8px 0',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
              },
            },
            h(
              'span',
              { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '12px' } },
              `${rule.toolName}${rule.mode ? ` · ${modeLabel(rule.mode)}` : ''}`,
            ),
            h(
              'span',
              { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
              h(
                'span',
                { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' } },
                format(t('ruleUses'), { count: rule.uses }),
              ),
              button(t('revoke'), () => revoke(rule.id), { danger: true }),
            ),
          )

        const dialog = h(
          'dialog',
          {
            ref: dialogRef,
            className: 'dsh-deferred-approvals-dialog',
            onClick: (event) => {
              // 点击 backdrop（dialog 自身）关闭。
              if (event.target === dialogRef.current) closePanel()
            },
            style: {
              position: 'fixed',
              left: '50%',
              bottom: '96px',
              transform: 'translateX(-50%)',
              margin: 0,
              width: 'min(560px, 92vw)',
              maxHeight: 'min(70vh, 620px)',
              overflowY: 'auto',
              background: 'var(--dsw-alias-bg-overlay)',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '12px',
              boxShadow: '0 18px 48px rgba(0, 0, 0, 0.4)',
              padding: '12px 16px 14px',
              color: 'var(--dsw-alias-label-primary)',
              boxSizing: 'border-box',
            },
          },
          h('style', null, 'dialog.dsh-deferred-approvals-dialog::backdrop{background:rgba(0,0,0,.42)}'),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px', paddingBottom: '6px' } },
            h('span', {
              style: { width: '8px', height: '8px', borderRadius: '999px', background: 'var(--dsw-alias-state-warn-primary)', flex: 'none' },
            }),
            h(
              'span',
              { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontWeight: 600, flex: '1' } },
              headline(t),
            ),
            button(t('close'), () => closePanel()),
          ),
          items.length === 0
            ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', padding: '8px 0' } }, t('empty'))
            : items.map(itemBlock),
          items.length > 0
            ? h('input', {
                value: note,
                onChange: (event) => setNote(event.target.value),
                placeholder: t('note'),
                style: {
                  width: '100%',
                  boxSizing: 'border-box',
                  marginTop: '8px',
                  height: '28px',
                  borderRadius: '6px',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  color: 'var(--dsw-alias-label-primary)',
                  padding: '0 8px',
                  fontSize: '12px',
                },
              })
            : null,
          error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '11px', marginTop: '6px' } }, error) : null,
          rules.length > 0
            ? h(
                'div',
                { style: { marginTop: '10px' } },
                h(
                  'div',
                  {
                    style: {
                      color: 'var(--dsw-alias-label-secondary)',
                      fontSize: '11px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.4px',
                    },
                  },
                  t('rulesTitle'),
                ),
                rules.map(ruleBlock),
              )
            : null,
          decided.length > 0
            ? h(
                'div',
                { style: { marginTop: '10px' } },
                h(
                  'div',
                  {
                    style: {
                      color: 'var(--dsw-alias-label-secondary)',
                      fontSize: '11px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.4px',
                    },
                  },
                  t('decidedTitle'),
                ),
                decided.slice(0, 8).map((entry) => {
                  const minutes = Math.max(0, Math.round((now - entry.at) / 60000))
                  const when = minutes < 1 ? t('decidedNow') : format(t('decidedAgo'), { minutes })
                  return h(
                    'div',
                    {
                      key: `d-${entry.id}`,
                      style: {
                        display: 'flex',
                        gap: '8px',
                        alignItems: 'baseline',
                        padding: '3px 0',
                        fontSize: '12px',
                        color: 'var(--dsw-alias-label-secondary)',
                        flexWrap: 'wrap',
                      },
                    },
                    h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, `#${entry.id} · ${entry.toolName}`),
                    h('span', {}, t(DECISION_KEYS[entry.decision] ?? 'decCancelled')),
                    h('span', { style: { fontSize: '11px' } }, when),
                  )
                }),
              )
            : null,
        )

        return h('div', { ref: rootRef, style: { display: 'inline-flex', alignItems: 'center' } }, chip, dialog)
      }
    }

    return {
      inject: ['slots', 'locale', 'uiSession'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deferred-approvals: dictionaries')
        const tr = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (key) => zh[key] ?? key
        const publishInteraction = ctx.uiSession.registerPendingInteraction(() => -1)
        const published = new Map() // sessionId -> { key, remove }
        let counter = 0
        let refreshing = false

        function ensurePublished(sessionId) {
          if (published.has(sessionId)) return
          counter += 1
          const key = `deferred-approval:${sessionId}:${counter}`
          // kind='approval' 仅为复用原生审批的会话状态点（侧边栏橙色小点 + “等待审批”标签），
          // deferredApproval 标记用于和原生 PendingApproval 区分；本插件不注册 composer 接管，
          // 输入框始终由原生组件渲染。
          const interaction = { kind: 'approval', deferredApproval: true, key, sessionId }
          const remove = publishInteraction(interaction, async () => {})
          published.set(sessionId, { key, remove })
        }

        function unpublish(sessionId) {
          const entry = published.get(sessionId)
          if (entry === undefined) return
          published.delete(sessionId)
          try {
            entry.remove()
          } catch {
            /* 已移除 */
          }
        }

        function unpublishAll() {
          for (const sessionId of [...published.keys()]) unpublish(sessionId)
        }

        async function refresh() {
          if (refreshing) return
          refreshing = true
          try {
            const body = await fetchJSON(`${API}/state`)
            if (!body?.ok) return
            const grouped = groupState(body)
            const sessions = new Set([...grouped.keys(), ...store.data.keys()])
            for (const sessionId of sessions) {
              const next = grouped.get(sessionId)
              const previous = store.data.get(sessionId)
              if (next === undefined) {
                if (previous !== undefined) store.set(sessionId, undefined)
                continue
              }
              if (
                previous === undefined ||
                previous.items.length !== next.items.length ||
                previous.rules.length !== next.rules.length ||
                previous.serverNow !== next.serverNow
              ) {
                store.set(sessionId, next)
              }
            }
            for (const sessionId of grouped.keys()) {
              if ((grouped.get(sessionId)?.items.length ?? 0) > 0) ensurePublished(sessionId)
            }
            for (const sessionId of [...published.keys()]) {
              if ((grouped.get(sessionId)?.items.length ?? 0) === 0) unpublish(sessionId)
            }
          } catch {
            /* Host 半未加载或路由未就绪时静默 */
          } finally {
            refreshing = false
          }
        }

        store.refresh = refresh

        ctx.effect(() => {
          void refresh()
          const timer = setInterval(() => {
            if (document.visibilityState === 'visible') void refresh()
          }, POLL_MS)
          const onVisible = () => {
            if (document.visibilityState === 'visible') void refresh()
          }
          document.addEventListener('visibilitychange', onVisible)
          return () => {
            clearInterval(timer)
            document.removeEventListener('visibilitychange', onVisible)
            unpublishAll()
            store.refresh = undefined
            store.clear()
          }
        }, 'deferred-approvals: state polling')

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'deferred-approvals',
              order: 10,
              locale: NS,
              label: () => tr('label'),
            },
            createChip(tr),
          ),
        )
      },
    }
  },
})
