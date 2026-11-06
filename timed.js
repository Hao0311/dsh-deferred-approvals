/**
 * dsh-timed-questions — 纯配置 bundle + 自维护检查。
 *
 * 主功能在 `cordis.patch.yml`：覆盖 standard 预设，把 `tool-ask-user` 切成 timed 模式。
 * 因为 DSH 的 config 是整块替换，这份副本会随 DSH 升级变旧。插件本体负责：
 *
 * 1. 启动时对比「官方 shipped standard 预设」与本包副本；发现漂移就按官方最新清单
 *    自动重新生成（保留 mode: timed / timeout），不需要人记得这件事；
 * 2. 漂移时向模型注入一条运行时上下文，让它提醒用户“重启 DSH 后新会话才会用上新预设”；
 * 3. 自动生成失败时注入“请手动运行 check-preset-drift.mjs --regenerate”的提醒。
 *
 * 注意：本进程的预设组合在插件加载前已经读走，所以重新生成只对下一次启动生效。
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const PATCH_PATH = join(PLUGIN_DIR, 'cordis.patch.yml')
const ASK_USER_NAME = "name: '@deepseek-ai/dsh-tool-ask-user'"
const DEFAULT_TIMEOUT = 20
const DEFAULT_DSH_ROOTS = ['C:/Users/guolz/nodejs/node_modules/@deepseek-ai/dsh']

const HEADER = [
  '# 让内置 ask_user_question 使用 timed 模式：提问不再无限阻塞，',
  '# 超时返回 pending，问题卡片保留、随时可答，回答以用户消息送回。',
  '# 本 bundle 覆盖 standard 预设的 preset-standard 行（config 整体替换），',
  '# 升级 DSH 后由 index.js 自动对比并重新生成本文件；也可手动：',
  '#   node check-preset-drift.mjs --regenerate',
  '- insert:',
  '    - id: deferred-approvals',
  "      name: 'dsh-deferred-approvals'",
  '- id: preset-standard',
  "  name: '@deepseek-ai/dsh-agent-preset'",
  '  config:',
  '    id: standard',
  '    order: 1',
  '    plugins:',
]

export const inject = ['systemPrompt']

function readLines(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.length > 0)
}

function pluginsIndex(lines) {
  const index = lines.findIndex((line) => line.trim() === 'plugins:')
  if (index < 0) throw new Error(`plugins: not found in ${lines[0] ?? '(empty)'}`)
  return index
}

function pluginListLines(lines) {
  return lines.slice(pluginsIndex(lines) + 1)
}

function pluginIds(lines) {
  const found = []
  for (const line of lines) {
    const match = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
    if (match) found.push(match[1])
  }
  return found
}

function injectedBlock(timeout) {
  return ['            config:', '              mode: timed', `              timeout: ${timeout}`]
}

function currentTimeout(lines) {
  for (const line of lines) {
    const match = /^\s*timeout:\s*(\d+)\s*$/.exec(line)
    if (match) return Number(match[1])
  }
  return DEFAULT_TIMEOUT
}

function stripTimedConfig(lines) {
  const nameIndex = lines.findIndex((line) => line.trim() === ASK_USER_NAME)
  if (nameIndex < 0) throw new Error('tool-ask-user row not found in our patch')
  const injected =
    lines[nameIndex + 1]?.trim() === 'config:' && (lines[nameIndex + 2] ?? '').trim().startsWith('mode: timed')
  return injected ? lines.slice(0, nameIndex + 1).concat(lines.slice(nameIndex + 4)) : lines
}

function onlyIn(a, b) {
  return a.filter((value) => !b.includes(value))
}

/** 官方预设路径：优先环境变量，其次从进程入口推，最后用本机默认路径。 */
export function findDshRoot(argvEntry = process.argv[1]) {
  const candidates = []
  if (process.env.DSH_INSTALL_ROOT) candidates.push(process.env.DSH_INSTALL_ROOT)
  if (argvEntry) {
    const entryDir = dirname(argvEntry)
    if (entryDir.endsWith('lib')) candidates.push(resolve(entryDir, '..'))
    let current = entryDir
    for (let i = 0; i < 6 && current && current !== dirname(current); i += 1) {
      candidates.push(join(current, 'node_modules', '@deepseek-ai', 'dsh'))
      current = dirname(current)
    }
  }
  candidates.push(...DEFAULT_DSH_ROOTS)
  for (const root of candidates) {
    if (existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml'))) return root
  }
  return undefined
}

/** 对比官方插件清单与我们的副本（已剔除 timed 配置）。两边的输入都可以带 `plugins:` 头。 */
export function comparePluginLists(shippedLines, ourLines) {
  const shipped = normalizeList(shippedLines)
  const oursBase = stripTimedConfig(normalizeList(ourLines))
  if (JSON.stringify(shipped) === JSON.stringify(oursBase)) {
    return { drift: false, added: [], removed: [], changed: 0 }
  }
  const shippedIds = pluginIds(shipped)
  const ourIds = pluginIds(oursBase)
  const added = onlyIn(shippedIds, ourIds)
  const removed = onlyIn(ourIds, shippedIds)
  const changed =
    added.length === 0 && removed.length === 0
      ? shipped.filter((line, index) => oursBase[index] !== line).length
      : 0
  return { drift: true, added, removed, changed }
}

function normalizeList(lines) {
  const index = lines.findIndex((line) => line.trim() === 'plugins:')
  return index < 0 ? lines : lines.slice(index + 1)
}

/** 用官方清单重新生成 patch 文本（保留 timed 配置）。 */
export function buildPatchText(shipped, timeout) {
  const nameIndex = shipped.findIndex((line) => line.trim() === ASK_USER_NAME)
  if (nameIndex < 0) throw new Error('tool-ask-user row not found in shipped preset')
  const lines = [...HEADER]
  for (let i = 0; i < shipped.length; i += 1) {
    lines.push(shipped[i])
    if (i === nameIndex) lines.push(...injectedBlock(timeout))
  }
  const text = lines.join('\n') + '\n'
  // 结构自检：重新生成后必须与官方清单一致（剔除 timed 配置），且 timed 配置在位。
  const rebuilt = text.split(/\r?\n/).filter((line) => line.length > 0)
  const rebuiltList = pluginListLines(rebuilt)
  const check = comparePluginLists(shipped, rebuiltList)
  if (check.drift) throw new Error('generated patch does not match the shipped preset')
  const askUser = currentTimeout(rebuilt)
  if (!askUser) throw new Error('generated patch lost the timed timeout')
  return text
}

export function apply(ctx) {
  const warn = (...args) => {
    try {
      ctx.logger?.warn?.('[timed-questions]', ...args)
    } catch {
      /* 忽略日志失败 */
    }
  }

  const status = { checked: false, drift: false, regenerated: false, error: undefined, added: [], removed: [] }
  try {
    const dshRoot = findDshRoot()
    const shippedPath = dshRoot
      ? join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
      : undefined
    if (!shippedPath || !existsSync(shippedPath) || !existsSync(PATCH_PATH)) {
      status.error = 'official preset or our cordis.patch.yml not found'
    } else {
      const shipped = pluginListLines(readLines(shippedPath))
      const ours = readLines(PATCH_PATH)
      const diff = comparePluginLists(shipped, ours)
      status.checked = true
      status.drift = diff.drift
      status.added = diff.added
      status.removed = diff.removed
      if (diff.drift) {
        const timeout = currentTimeout(ours)
        const text = buildPatchText(shipped, timeout)
        /* 稳定性修复（2026-11-06 审计 P1）：临时文件+rename 原子替换，
           防写一半被杀/磁盘满时损坏 cordis.patch.yml（预设丢失） */
        writeFileSync(`${PATCH_PATH}.tmp`, text, 'utf8')
        renameSync(`${PATCH_PATH}.tmp`, PATCH_PATH)
        status.regenerated = true
        warn(
          `preset copy drifted (${diff.added.length} added, ${diff.removed.length} removed); regenerated ${PATCH_PATH}; restart DSH for new sessions to pick it up`,
        )
      }
    }
  } catch (error) {
    status.error = String(error?.message ?? error)
    warn('preset drift check failed:', status.error)
  }

  // 只在需要提醒时注入一条运行时上下文，让模型在对话里转告用户。
  if (status.drift || status.error) {
    const text = status.regenerated
      ? `DSH 自带的 standard 预设与 dsh-timed-questions 的本地副本不一致，已自动重新生成副本（${PATCH_PATH}）。请提醒用户：需要重启 DSH 后，新会话才会用上最新的预设。`
      : `DSH 自带的 standard 预设与 dsh-timed-questions 的本地副本不一致，且自动更新失败（${status.error}）。请提醒用户手动运行 node check-preset-drift.mjs --regenerate。`
    ctx.effect(
      () =>
        ctx.systemPrompt.context({
          name: 'timed-questions:preset-drift',
          order: 116,
          text,
        }),
      'timed-questions: drift notice',
    )
  }
}
