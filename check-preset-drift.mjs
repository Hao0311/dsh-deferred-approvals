#!/usr/bin/env node
/**
 * dsh-timed-questions 的预设漂移检查 / 重新生成。
 *
 * 背景：dsh-timed-questions 的 cordis.patch.yml 是对 standard 预设的整份覆盖
 * （DSH 的 config 语义是整体替换）。DSH 升级后官方预设可能新增/移除/修改插件行，
 * 这份副本就会变旧。本脚本把官方 shipped 预设与我们的副本逐行对比，并可一键重新生成。
 *
 * 用法（PowerShell）：
 *   node check-preset-drift.mjs              # 只检查，漂移时退出码 2
 *   node check-preset-drift.mjs --regenerate # 用官方最新清单重新生成（保留 timed 配置）
 *
 * 可选参数：
 *   --dsh-root <dir>     dsh 安装目录（默认 C:/Users/guolz/nodejs/node_modules/@deepseek-ai/dsh）
 *   --plugin-dir <dir>   本插件目录（默认脚本所在目录）
 *   --timeout <秒>       timed 提问的默认等待秒数（默认读现有副本里的值，读不到用 20）
 *   --out <file>         重新生成时写到指定文件（默认覆盖本插件的 cordis.patch.yml）
 *
 * 重新生成后需要重启 DSH（或重新安装 bundle）才会在 loader 里生效；新会话才会用到。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULTS = {
  dshRoot: 'C:/Users/guolz/nodejs/node_modules/@deepseek-ai/dsh',
  pluginDir: SELF_DIR,
  timeout: 20,
}

const HEADER = [
  '# 让内置 ask_user_question 使用 timed 模式：提问不再无限阻塞，',
  '# 超时返回 pending，问题卡片保留、随时可答，回答以用户消息送回。',
  '# 本 bundle 覆盖 standard 预设的 preset-standard 行（config 整体替换），',
  '# 所以升级 DSH 后若 shipped 预设新增插件，需要重新生成这个 cordis.patch.yml。',
  '# 检查/重新生成：node check-preset-drift.mjs [--regenerate]',
  '- insert:',
  "    - id: deferred-approvals",
  "      name: 'dsh-deferred-approvals'",
  '- id: preset-standard',
  "  name: '@deepseek-ai/dsh-agent-preset'",
  '  config:',
  '    id: standard',
  '    order: 1',
  '    plugins:',
]

function readArgs(argv) {
  const opts = { ...DEFAULTS, regenerate: false, out: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    switch (key) {
      case '--dsh-root':
        opts.dshRoot = value
        i += 1
        break
      case '--plugin-dir':
        opts.pluginDir = value
        i += 1
        break
      case '--timeout':
        opts.timeout = Number(value)
        i += 1
        break
      case '--out':
        opts.out = value
        i += 1
        break
      case '--regenerate':
        opts.regenerate = true
        break
      case '--help':
      case '-h':
        console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0])
        process.exit(0)
        break
      default:
        if (key.startsWith('--')) throw new Error(`unknown option: ${key}`)
    }
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error('--timeout must be a positive number')
  return opts
}

function readLines(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.length > 0)
}

function pluginsIndex(lines) {
  const index = lines.findIndex((line) => line.trim() === 'plugins:')
  if (index < 0) throw new Error('plugins: not found')
  return index
}

const ASK_USER_NAME = "name: '@deepseek-ai/dsh-tool-ask-user'"

function injectedBlock(timeout) {
  return ['            config:', '              mode: timed', `              timeout: ${timeout}`]
}

function ourPlugins(lines) {
  const inner = lines.slice(pluginsIndex(lines) + 1)
  const nameIndex = inner.findIndex((line) => line.trim() === ASK_USER_NAME)
  if (nameIndex < 0) throw new Error('tool-ask-user row not found in our patch')
  const hasInjected =
    inner[nameIndex + 1]?.trim() === 'config:' && (inner[nameIndex + 2] ?? '').trim().startsWith('mode: timed')
  return hasInjected ? inner.slice(0, nameIndex + 1).concat(inner.slice(nameIndex + 4)) : inner
}

function currentTimeout(lines) {
  for (const line of lines) {
    const match = /^\s*timeout:\s*(\d+)\s*$/.exec(line)
    if (match) return Number(match[1])
  }
  return DEFAULTS.timeout
}

function pluginIds(lines) {
  const found = []
  for (const line of lines) {
    const match = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
    if (match) found.push(match[1])
  }
  return found
}

function onlyIn(a, b) {
  return a.filter((value) => !b.includes(value))
}

function regenerate(opts, shipped) {
  const nameIndex = shipped.findIndex((line) => line.trim() === ASK_USER_NAME)
  if (nameIndex < 0) throw new Error('tool-ask-user row not found in shipped preset')
  const lines = [...HEADER]
  for (let i = 0; i < shipped.length; i += 1) {
    lines.push(shipped[i])
    if (i === nameIndex) lines.push(...injectedBlock(opts.timeout))
  }
  // 结构性校验：剥掉 !!js 自定义 tag 后用 yaml 解析，确认插件数与 timed 配置。
  const require = createRequire(import.meta.url)
  const YAML = require(join(opts.dshRoot, 'node_modules', 'yaml'))
  const parsed = YAML.parse(lines.join('\n').replace(/!!js\s+/g, ''))
  const preset = parsed[1]
  if (!preset || preset.id !== 'preset-standard') throw new Error('generated patch: preset-standard row missing')
  const ask = preset.config.plugins.find((row) => row.id === 'tool-ask-user')
  if (!ask || ask.config?.mode !== 'timed' || ask.config?.timeout !== opts.timeout) {
    throw new Error('generated patch: tool-ask-user timed config missing')
  }
  return lines.join('\n') + '\n'
}

function main() {
  const opts = readArgs(process.argv.slice(2))
  const shippedPath = join(opts.dshRoot, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
  const ourPath = join(opts.pluginDir, 'cordis.patch.yml')
  const shipped = readLines(shippedPath).slice(pluginsIndex(readLines(shippedPath)) + 1)
  const ours = readLines(ourPath)
  const timeout = currentTimeout(ours)

  if (opts.regenerate) {
    const text = regenerate({ ...opts, timeout }, shipped)
    const out = opts.out ?? ourPath
    writeFileSync(out, text, 'utf8')
    const textLines = text.split(/\r?\n/).filter((line) => line.length > 0)
    console.log(`[regenerated] ${out}`)
    console.log(
      `  rows: ${pluginIds(textLines.slice(pluginsIndex(textLines) + 1)).length}, tool-ask-user: mode=timed, timeout=${timeout}s`,
    )
    console.log('  restart DSH (or reinstall the bundle) for the loader to pick it up; new sessions only')
    return
  }

  const oursBase = ourPlugins(ours)
  const shippedIds = pluginIds(shipped)
  const ourIds = pluginIds(oursBase)

  if (JSON.stringify(shipped) === JSON.stringify(oursBase)) {
    console.log('[ok] no drift: our preset copy equals the shipped standard preset (timed config excluded)')
    console.log(`  plugins: ${shippedIds.length}, tool-ask-user: mode=timed, timeout=${timeout}s`)
    return
  }

  console.log('[drift] our preset copy differs from the shipped standard preset')
  const newRows = onlyIn(shippedIds, ourIds)
  const goneRows = onlyIn(ourIds, shippedIds)
  if (newRows.length > 0) console.log(`  shipped only (new/renamed upstream rows): ${newRows.join(', ')}`)
  if (goneRows.length > 0) console.log(`  ours only (removed upstream rows): ${goneRows.join(', ')}`)
  if (newRows.length === 0 && goneRows.length === 0) {
    const changed = shipped.filter((line, index) => oursBase[index] !== line).length
    console.log(`  same plugin ids but content differs (${changed} line(s))`)
  }
  console.log('  run with --regenerate to rebuild from the shipped preset (keeps timed config)')
  process.exitCode = 2
}

try {
  main()
} catch (error) {
  console.error(`[error] ${error?.message ?? error}`)
  process.exitCode = 1
}
