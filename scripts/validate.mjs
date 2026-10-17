// tey-mcp 校验台：加载所有工具包，查命名/参数/描述规范，可选冒烟执行。
// 用法：node scripts/validate.mjs [--smoke] [--count] [--pack=fs]
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const packsDir = path.join(root, 'src', 'packs')

const args = process.argv.slice(2)
const wantSmoke = args.includes('--smoke')
const countOnly = args.includes('--count')
const onlyPack = (args.find((a) => a.startsWith('--pack=')) || '').slice(7)

const { Registry } = await import(pathToFileURL(path.join(root, 'src', 'registry.js')).href)
const reg = new Registry()

const errors = []
const warnings = []
const files = fs.readdirSync(packsDir).filter((f) => f.endsWith('.js') && !f.startsWith('_'))

for (const f of files) {
  const id = f.replace(/\.js$/, '')
  if (onlyPack && id !== onlyPack) continue
  const src = fs.readFileSync(path.join(packsDir, f), 'utf8')
  if (/@deepseek-ai\//.test(src)) errors.push(`${f}: 禁止 import @deepseek-ai/*`)
  if (/\brequire\(/.test(src)) warnings.push(`${f}: 出现 require()，请用 import`)
  if (/C:\\+Users/i.test(src)) errors.push(`${f}: 写死了 C:\\Users 路径`)
  const mod = await import(pathToFileURL(path.join(packsDir, f)).href)
  const pack = mod.default || mod.pack
  if (!pack) {
    errors.push(`${f}: 没有 default 导出`)
    continue
  }
  if (String(pack.id) !== id) errors.push(`${f}: 包 id ${pack.id} 与文件名 ${id} 不一致`)
  if (!pack.title) warnings.push(`${f}: 缺 title`)
  if (!pack.summary) warnings.push(`${f}: 缺 summary`)
  if (!Array.isArray(pack.tags) || !pack.tags.length) warnings.push(`${f}: 缺 tags`)
  const tools = Array.isArray(pack.tools) ? pack.tools : []
  if (tools.length < 10) warnings.push(`${f}: 只有 ${tools.length} 个工具（目标 20-40）`)
  for (const t of tools) {
    if (!String(t.name || '').startsWith(`${id}_`)) errors.push(`${f}: 工具名 ${t.name} 应以 ${id}_ 开头`)
    if (!t.desc || t.desc.length > 120) errors.push(`${f}: ${t.name} 描述缺失或超过 120 字`)
    for (const [k, v] of Object.entries(t.params || {})) {
      if (!v || !v.type) errors.push(`${f}: ${t.name}.${k} 缺 type`)
      else if (v.type === 'array' && !v.items) errors.push(`${f}: ${t.name}.${k} array 缺 items`)
      else if (v.type === 'object' && !v.props) errors.push(`${f}: ${t.name}.${k} object 缺 props`)
      if (v && v.desc && v.desc.length > 200) warnings.push(`${f}: ${t.name}.${k} 参数说明超 200 字`)
    }
  }
  const res = reg.addPack(pack)
  if (!res.ok) errors.push(`${f}: ${res.message}`)
}

const counts = reg.packList().map((p) => ({ id: p.id, tools: p.tools, title: p.title }))
const total = counts.reduce((s, p) => s + p.tools, 0)

if (countOnly) {
  console.log(counts.map((c) => `${c.id.padEnd(10)} ${String(c.tools).padStart(4)}  ${c.title}`).join('\n'))
  console.log(`总计 ${total} 个工具 / ${counts.length} 个包`)
} else {
  console.log(`包 ${counts.length} 个，工具 ${total} 个`)
  for (const c of counts) console.log(`  ${c.id.padEnd(10)} ${String(c.tools).padStart(4)}  ${c.title}`)
}

if (reg.loadError.length) for (const e of reg.loadError) warnings.push(`loadError ${e.file || e.dir}: ${e.message}`)

if (wantSmoke) {
  const { runTool, makeCtx } = await import(pathToFileURL(path.join(root, 'src', 'runner.js')).href)
  const ctx = makeCtx({ cwd: root, sessionId: 'validate', config: { resultMaxChars: 4000 }, dataDir: path.join(root, '.validate-tmp'), registry: reg })
  const names = onlyPack ? reg.packs.get(onlyPack).toolNames : [...reg.tools.keys()]
  let ran = 0
  let crashed = 0
  for (const name of names) {
    const tool = reg.get(name)
    const r = await runTool(tool, {}, ctx, { timeoutMs: 15000 })
    ran++
    if (!r.ok && !['bad_args', 'timeout', 'tool_error'].includes(r.code)) {
      crashed++
      errors.push(`smoke ${name}: ${r.code} ${r.message}`)
    } else if (!r.ok && r.code === 'tool_error' && /is not defined|is not a function|is not a constructor|Cannot read|Cannot convert|undefined is not|Invalid time value|Maximum call stack|RangeError|TypeError|ENOENT|EPERM/.test(r.message || '')) {
      crashed++
      errors.push(`smoke ${name}: ${r.message}`)
    }
  }
  console.log(`冒烟：跑了 ${ran} 个（空参数），可疑 ${crashed} 个`)
}

if (warnings.length) {
  console.log(`\n警告 ${warnings.length}:`)
  for (const w of warnings.slice(0, 40)) console.log(`  ! ${w}`)
}
if (errors.length) {
  console.log(`\n错误 ${errors.length}:`)
  for (const e of errors.slice(0, 60)) console.log(`  x ${e}`)
  process.exitCode = 1
} else {
  console.log('\n校验通过')
}
