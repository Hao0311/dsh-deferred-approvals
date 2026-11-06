/**
 * dsh-deferred-approvals（合并版入口）— 非阻塞交互：审批挂起 + 定时提问。
 *
 * 两个半边合在一个 bundle 里，装一次、占一个目录、一条依赖：
 *   - `approvals.js`：Host 半，审批请求挂起为待办、模型继续干活、用户点完允许/拒绝后
 *     通过宿主事件把决定送回模型（详见文件头注释）。
 *   - `timed.js`：覆盖 standard 预设，把 `ask_user_question` 切成 timed 模式（超时返回
 *     pending、问题卡片保留、回答后作为用户消息送回），并在每次启动时对比官方预设、
 *     发现漂移就自动重新生成 `cordis.patch.yml`。
 *
 * 两者都只依赖 `ctx` 服务（tools / approval / agents / systemPrompt，可选 connection），
 * 不依赖任何 `@deepseek-ai/*` 包；`cordis.patch.yml` 里同时带本 bundle 的 insert 行与
 * standard 预设覆盖，升级 DSH 后由 `timed.js` 自动重新生成。
 */

import { apply as applyApprovals } from './approvals.js'
import { apply as applyTimedQuestions } from './timed.js'

export const name = 'deferred-approvals'
export const inject = ['tools', 'approval', 'agents', 'systemPrompt']

/**
 * @param ctx - 插件上下文（Cordis）。
 * @param rawConfig - 本行的 `config`（审批半边认 ttl / 授权时长等键；定时提问半边忽略）。
 */
export function apply(ctx, rawConfig) {
  applyApprovals(ctx, rawConfig)
  applyTimedQuestions(ctx)
}
