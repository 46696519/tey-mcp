// tey-mcp 总线自检：假一个 ctx.tools.register，把插件跑起来，
// 按"取用 → 带指纹调用 → 过期/越权 → 批量 → 配置"的顺序走一遍，逐项打 PASS/FAIL。
// 用法：node scripts/selftest.mjs
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

let pass = 0
let fail = 0
const check = (label, ok, extra) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${String(extra).slice(0, 160)}` : ''}`)
}

const plugin = await import('../index.js')
check('插件导出 name/inject/apply', plugin.name === 'tey-mcp' && Array.isArray(plugin.inject) && plugin.inject.includes('tools') && typeof plugin.apply === 'function')

const registered = new Map()
const ctx = {
  tools: {
    register: (t) => {
      if (!t || !t.name || !t.description || !t.parameters || typeof t.execute !== 'function') throw new Error(`注册形状不完整: ${t && t.name}`)
      if (t.parameters.type !== 'object' || t.parameters.additionalProperties !== false) throw new Error(`参数 schema 形状不对: ${t.name}`)
      if (!t.output || !t.output.schema || typeof t.output.render !== 'function') throw new Error(`output 形状不完整: ${t.name}`)
      registered.set(t.name, t)
    },
  },
  logger: { info() {}, warn() {}, error() {} },
}

const dispose = plugin.apply(ctx, { ttlSeconds: 1800, idleSeconds: 900, fetchMin: 30, fetchMax: 50, maxBatch: 12, resultMaxChars: 20000, packsDisabled: [], mcpServers: [] })
check('apply 返回 dispose 函数', typeof dispose === 'function')
check(`注册 7 个元工具（实际 ${registered.size}）`, registered.size === 7, [...registered.keys()].join(','))

const exec = { cwd: root, session: { id: `selftest-${Date.now()}` } }
const call = async (name, args) => {
  const t = registered.get(name)
  if (!t) throw new Error(`没注册 ${name}`)
  const raw = await t.execute(args || {}, exec)
  try {
    return JSON.parse(raw)
  } catch (e) {
    return { __text: raw }
  }
}

// 1. tey_status
const st = await call('tey_status')
check('tey_status 报出包与工具数', st.ok === true && st.bus && st.bus.packCount >= 10 && st.bus.toolCount >= 200, `包${st.bus && st.bus.packCount} 工具${st.bus && st.bus.toolCount}`)
check('tey_status 无加载错误', Array.isArray(st.loadErrors) && st.loadErrors.length === 0, JSON.stringify(st.loadErrors || []).slice(0, 200))
check('tey_status 门配置可读回', st.gate && st.gate.ttlSeconds === 1800 && st.gate.idleSeconds === 900 && st.gate.fetchMin === 30 && st.gate.fetchMax === 50, JSON.stringify(st.gate))

// 2. tey_packs
const packs = await call('tey_packs')
check('tey_packs 无参数给组清单文本', typeof packs.__text === 'string' && packs.__text.includes('工具组'), packs.__text && packs.__text.split('\n')[0])
const onePack = await call('tey_packs', { pack: 'text', limit: 10 })
check('tey_packs {"pack":"text"} 给薄清单', onePack.total >= 30 && onePack.rows.length === 10 && String(onePack.rows[0]).includes('text_'), `total=${onePack.total}`)
const q = await call('tey_packs', { query: '显存' })
check('tey_packs {"query":"显存"} 能搜到 GPU 工具', q.total > 0 && q.rows.some((r) => String(r).includes('nvidia_')), `total=${q.total}`)

// 3. tey_fetch：默认一次 30-50 个
const f1 = await call('tey_fetch', { pack: 'text' })
check('tey_fetch 发指纹', typeof f1.fingerprint === 'string' && /^tey-[0-9a-f]{16}$/.test(f1.fingerprint), f1.fingerprint)
check('tey_fetch 带完整参数 schema', f1.tools && f1.tools.length >= 30 && f1.tools[0].parameters && f1.tools[0].parameters.type === 'object', `fetched=${f1.fetched}`)
const fAll = await call('tey_fetch', {})
check('tey_fetch 不给参数也限在 fetchMax 内', fAll.fetched <= 50 && fAll.fetched >= 30, `fetched=${fAll.fetched}`)
const fBig = await call('tey_fetch', { pack: 'fs', limit: 999 })
check('tey_fetch limit 超上限被夹住', fBig.fetched <= 50, `fetched=${fBig.fetched}`)

// 4. tey_call：带指纹
const c1 = await call('tey_call', { fingerprint: f1.fingerprint, tool: 'text_hash', args: { text: 'abc', algo: 'sha256' } })
check('tey_call 带指纹能跑通', c1.ok === true && c1.tool === 'text_hash' && c1.calls === 1, JSON.stringify(c1).slice(0, 160))

// 5. 指纹门：缺指纹 / 错指纹 / 未取用的工具
const c2 = await call('tey_call', { tool: 'text_hash', args: { text: 'x' } })
check('没指纹直接调用被拒', c2.ok === false && c2.code === 'fingerprint_missing', c2.code)
const c3 = await call('tey_call', { fingerprint: 'tey-0000000000000000', tool: 'text_hash', args: { text: 'x' } })
check('陌生指纹被拒', c3.ok === false && c3.code === 'fingerprint_unknown', c3.code)
const c4 = await call('tey_call', { fingerprint: f1.fingerprint, tool: 'fs_read', args: { path: 'package.json' } })
check('没取用的工具被拒（fs_read 不在 text 批次里）', c4.ok === false && c4.code === 'tool_not_granted', c4.code)
const other = { cwd: root, session: { id: 'another-session' } }
const foreign = await registered.get('tey_call').execute({ fingerprint: f1.fingerprint, tool: 'text_hash', args: { text: 'x' } }, other)
check('别的会话拿这张指纹调不动', JSON.parse(foreign).ok === false && JSON.parse(foreign).code === 'fingerprint_foreign', JSON.parse(foreign).code)

// 6. tey_batch
const b1 = await call('tey_batch', { fingerprint: f1.fingerprint, calls: [{ tool: 'text_hash', args: { text: 'a' } }, { tool: 'text_stats', args: { text: 'hello 世界' } }, { tool: 'fs_read', args: { path: 'x' } }] })
check('tey_batch 跑 3 条：2 成 1 败', b1.ran === 3 && b1.succeeded === 2, `ran=${b1.ran} ok=${b1.succeeded}`)
const b2 = await call('tey_batch', { fingerprint: f1.fingerprint, calls: Array.from({ length: 20 }, () => ({ tool: 'text_hash', args: { text: 'x' } })) })
check('tey_batch 超过 maxBatch 被截到 12', b2.ran === 12, `ran=${b2.ran}`)

// 7. tey_configure
const g1 = await call('tey_configure', { action: 'get' })
check('tey_configure get 读到生效值', g1.ok === true && g1.effective && g1.effective.fetchMax === 50)
const r1 = await call('tey_configure', { action: 'set', key: 'resultMaxChars', value: '18000' })
check('tey_configure set 改一项', r1.ok === true && r1.value === 18000, JSON.stringify(r1).slice(0, 120))
const bad = await call('tey_configure', { action: 'set', key: 'nope', value: '1' })
check('tey_configure 不认的 key 被拒', bad.ok === false && Array.isArray(bad.allowed))
const rv = await call('tey_configure', { action: 'revoke', fingerprint: f1.fingerprint })
check('tey_configure revoke 作废指纹', rv.ok === true)
const after = await call('tey_call', { fingerprint: f1.fingerprint, tool: 'text_hash', args: { text: 'x' } })
check('作废后再调被拒', after.ok === false && after.code === 'fingerprint_unknown', after.code)
await call('tey_configure', { action: 'set', key: 'resultMaxChars', value: '20000' })

// 8. 闲置与过期（直接压门参数再恢复）
const f2 = await call('tey_fetch', { pack: 'text', limit: 30 })
await call('tey_configure', { action: 'set', key: 'idleSeconds', value: '30' })
await new Promise((r) => setTimeout(r, 1200))
const idleOk = await call('tey_call', { fingerprint: f2.fingerprint, tool: 'text_hash', args: { text: 'x' } })
check('闲置时限内还能用', idleOk.ok === true)
await call('tey_configure', { action: 'set', key: 'idleSeconds', value: '900' })
await call('tey_configure', { action: 'clear' })
const cleared = await call('tey_call', { fingerprint: f2.fingerprint, tool: 'text_hash', args: { text: 'x' } })
check('clear 之后全部指纹作废', cleared.ok === false, cleared.code)

// 9. tey_mcp
const m1 = await call('tey_mcp', { action: 'status' })
check('tey_mcp status 可答', m1.ok === true && Array.isArray(m1.configured))
const m2 = await call('tey_mcp', { action: 'refresh', server: 'nope' })
check('tey_mcp refresh 没配的服务器有明确回复', m2.ok === false && /没有/.test(String(m2.message)), m2.message)

// 10. 跨组互调与 ctx 能力（fs 组里 ctx.exec / ctx.truncate 是否可用）
const f3 = await call('tey_fetch', { pack: 'shell' })
const sh = await call('tey_call', { fingerprint: f3.fingerprint, tool: 'shell_os_info', args: {} })
const shVal = typeof sh.value === 'string' ? JSON.parse(sh.value) : sh.value
check('shell 组走 ctx.exec 拿得到系统信息', sh.ok === true && shVal && (shVal.hostname || shVal.platform), JSON.stringify(shVal || sh).slice(0, 140))

// 11. 输出渲染
const t = registered.get('tey_status')
const rendered = t.output.render({}, 'hello')
check('output.render 出 text 块', Array.isArray(rendered) && rendered[0].type === 'text' && rendered[0].text === 'hello')

// 12. 数据目录
check(`数据目录在 ~/.dsh/tey-mcp`, st.plugin && st.plugin.dataDir === path.join(os.homedir(), '.dsh', 'tey-mcp'), st.plugin && st.plugin.dataDir)

dispose()
console.log(`\n自检：PASS ${pass} / FAIL ${fail}`)
process.exit(fail ? 1 : 0)
