/**
 * dsh-deferred-approvals Host 半回归测试（零依赖，Node >= 18）。
 *
 * 运行：node test/run.mjs   （在插件目录下；退出码 0 = 全过）
 *
 * 覆盖：挂起改写、决定送达三分支（中断 / steer / followup）、一次性授权与指纹、
 * 决定台账（pending cancel 的确定答复）、撤销/过期后的迟到决定、双击幂等、
 * 会话归属校验、同类规则批量批准与自动放行、/state 暴露 decided。
 */
import { apply } from '../index.js'

const handlers = new Map()
const disposers = []
const routes = []
const agents = new Map()
let tool

function on(event, fn, opts) {
  if (!handlers.has(event)) handlers.set(event, [])
  handlers.get(event).push({ fn, opts })
}

const ctx = {
  logger: { info() {}, warn() {} },
  on,
  effect(fn) {
    const d = fn()
    disposers.push(d)
    return d
  },
  get() {
    return undefined
  },
  tools: {
    register(t) {
      tool = t
    },
  },
  systemPrompt: {
    section() {
      return {}
    },
  },
  agents: {
    roots() {
      return []
    },
    get(id) {
      return agents.get(id)
    },
  },
  inject(_deps, fn) {
    fn({
      connection: {
        fetch: {
          register(r) {
            routes.push(r)
          },
        },
      },
      effect(f) {
        return f()
      },
    })
  },
}

apply(ctx, { requireLiveClient: false, interruptOnDecision: true })

function fire(event, ...args) {
  const list = handlers.get(event) ?? []
  if (list.length === 0) throw new Error(`no handler for ${event}`)
  return list[0].fn(...args)
}
const pre = (exec) => fire('tools/pre-execute', exec, () => undefined)
const post = (exec) => fire('tools/post-execute', exec, { kind: 'accept' }, async () => ({ kind: 'accept' }))
const approval = (req) => fire('approval/request', req, () => 'native')

async function attempt(callId, args, { open = false } = {}) {
  const agent = agents.get('s1')
  pre({ callId, agent, name: 'pwsh', arguments: args })
  const outcome = await approval({ agent, callId, toolName: 'pwsh', reason: 'r', displayReason: 'd' })
  if (!open) await post({ callId, agent, name: 'pwsh' })
  return outcome
}

const decideRoute = routes.find((r) => r.path === '/api/deferred-approvals/decide')
const stateRoute = routes.find((r) => r.path === '/api/deferred-approvals/state')

async function decide(id, decision, note, sessionId) {
  const body = { id, decision }
  if (note !== undefined) body.note = note
  if (sessionId !== undefined) body.sessionId = sessionId
  const res = await decideRoute.fetch(
    new Request('http://localhost/decide', { method: 'POST', body: JSON.stringify(body) }),
  )
  return res.json()
}

async function stateSnapshot() {
  const res = await stateRoute.fetch(new Request('http://localhost/state'))
  return res.json()
}

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('ok  -', msg)
  else {
    failures += 1
    console.error('FAIL-', msg)
  }
}

const agent = {
  session: { id: 's1' },
  status: 'running',
  rec: { cancel: [], steer: [], followup: [] },
  cancel(...a) {
    this.rec.cancel.push(a)
  },
  steer(...a) {
    this.rec.steer.push(a)
  },
  followup(...a) {
    this.rec.followup.push(a)
  },
}
agents.set('s1', agent)

const ARGS = { command: 'Write-Host hi', sandbox_permissions: 'danger-full-access', justification: 'j' }
const ARGS2 = { command: 'other cmd', sandbox_permissions: 'danger-full-access', justification: 'j' }

// 1) 挂起
assert((await attempt('c1', ARGS, { open: true })) === 'rejected', 'approval deferred -> rejected')
const rewritten = await post({ callId: 'c1', agent, name: 'pwsh' })
assert(rewritten.kind === 'block' && rewritten.feedback[0].text.includes('审批已挂起'), 'result rewritten to 挂起 notice')
assert(rewritten.feedback[0].text.includes('不要因为等待过久而撤销'), 'notice tells model not to cancel while waiting')

// 2) 决定送达：running + 无工具执行 -> 中断思考
const d1 = await decide('A1', 'once')
assert(d1.ok === true, 'decide once ok')
assert(agent.rec.cancel.length === 1, 'running model was interrupted (cancel called once)')
assert(agent.rec.cancel[0][1]?.keepInbox === true, 'interrupt keeps inbox')
assert(agent.rec.followup.length >= 1, 'notice delivered via followup after interrupt')
const notice1 = agent.rec.followup.at(-1)[0].content[0].text
assert(notice1.includes('用户已批准 #A1'), 'approval notice text delivered')
assert(notice1.includes('宿主已中断'), 'interruption explained to model')

// 2b) 双击幂等：同一决定重复提交不重复授权、不重复打扰模型
const followupsBeforeDup = agent.rec.followup.length
const dup = await decide('A1', 'once')
assert(dup.ok === true && dup.unchanged === true, 'repeat decide is idempotent (ok + unchanged)')
assert(agent.rec.followup.length === followupsBeforeDup, 'no duplicate notice on repeat decide')

// 3) 相同参数重试（仅 justification 不同）自动放行
assert((await attempt('c2', { ...ARGS, justification: 'other' })) === 'allowed-once', 'grant consumed on retry (justification ignored)')

// 4) pending cancel 对已批准待办给出确定答复
const cancelOut = await tool.execute({ action: 'cancel', id: '#A1' }, { agent: { session: { id: 's1' } } })
assert(cancelOut.includes('已被用户批准') && cancelOut.includes('不要撤销'), 'cancel on approved item says 已批准/不要撤销: ' + cancelOut.slice(0, 40))

// 5) 有工具在执行 -> 不中断，退回 steer；且错误会话归属被拒
await attempt('c3', ARGS2, { open: true })
const wrongSession = await decide('A2', 'deny', 'nope', 'other-session')
assert(wrongSession.ok === false && wrongSession.error === 'not-found', 'decide with wrong sessionId rejected')
assert(agent.rec.steer.length === 0 && agent.rec.cancel.length === 1, 'rejected cross-session decide has no side effects')
const d2 = await decide('A2', 'deny', 'nope', 's1')
assert(d2.ok === true, 'decide deny with correct sessionId ok')
assert(agent.rec.cancel.length === 1, 'no interrupt while a tool is executing')
assert(agent.rec.steer.length === 1, 'steered instead of interrupted')
await post({ callId: 'c3', agent, name: 'pwsh' })

// 6) 迟到放行：模型撤销后用户仍点了批准
await attempt('c4', ARGS2)
const cancelA3 = await tool.execute({ action: 'cancel', id: 'A3' }, { agent: { session: { id: 's1' } } })
assert(cancelA3.includes('已撤销待办 #A3'), 'model cancelled A3')
const d3 = await decide('A3', 'once')
assert(d3.ok === true && d3.late === true, 'late approve on cancelled item honored')
const lateNotice = agent.rec.followup.at(-1)[0].content[0].text
assert(lateNotice.includes('刚被你撤销') && lateNotice.includes('自动放行'), 'late approval notice explains context')
assert((await attempt('c5', ARGS2)) === 'allowed-once', 'late grant works on retry')

// 7) 迟到拒绝会撤销此前的放行
const d4 = await decide('A3', 'deny', 'changed mind')
assert(d4.ok === true && d4.late === true, 'late deny honored')
assert((await attempt('c6', ARGS2)) === 'rejected', 'late deny revoked the grant -> re-pended (A4)')

// 8) idle 模型：直接 followup，不中断
agent.status = 'idle'
const cancelBeforeIdle = agent.rec.cancel.length
const d5 = await decide('A4', 'deny')
assert(d5.ok === true, 'decide on idle agent ok')
assert(agent.rec.cancel.length === cancelBeforeIdle, 'no interrupt for idle agent')
assert(agent.rec.followup.length >= 2, 'idle delivery via followup')

// 9) list 展示最近决定
const listOut = await tool.execute({ action: 'list' }, { agent: { session: { id: 's1' } } })
assert(listOut.includes('最近已处理的待办'), 'list shows recent decisions')
assert(listOut.includes('用户已批准'), 'list shows 已批准 entry')

// 9b) /state 暴露 decided（供面板显示“最近已处理”）
const snap = await stateSnapshot()
assert(Array.isArray(snap.decided) && snap.decided.length > 0, '/state exposes decided array')
const a1Decided = snap.decided.find((e) => e.id === 'A1')
assert(a1Decided && a1Decided.decision === 'once' && a1Decided.sessionId === 's1', '/state decided entry for A1 carries decision + sessionId')

// 10) 本对话允许同类：批量批准 + 后续同类自动放行
agent.status = 'running'
assert((await attempt('c7', ARGS)) === 'rejected', 'c7 pended as A5')
assert((await attempt('c8', { ...ARGS, command: 'another' })) === 'rejected', 'c8 pended as A6')
const d6 = await decide('A5', 'session')
assert(d6.ok === true && d6.ruleId, 'session rule created')
const afterSession = await tool.execute({ action: 'list' }, { agent: { session: { id: 's1' } } })
assert(/#A6[^\n]*已随同类放行/.test(afterSession), 'A6 batch-approved and recorded as decided')
assert(!/#A6[^\n]*剩余/.test(afterSession), 'A6 no longer pending')
assert((await attempt('c9', { ...ARGS, command: 'rule pass' })) === 'allowed-once', 'same-class call auto-passed by rule')

// 11) 未知 id
const d7 = await decide('A99', 'once')
assert(d7.ok === false && d7.error === 'not-found', 'unknown id -> not-found')

for (const d of disposers) if (typeof d === 'function') d()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
