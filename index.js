// tey-mcp：DeepSeek Harness 工具总线插件。
// 只注册 7 个常驻元工具，几百个真实工具按组收在 src/packs 里，
// 模型先 tey_fetch 取一批（默认 30-50 个）拿一张指纹，再 tey_call / tey_batch 执行；
// 指纹绑会话 + 机器，带过期与闲置时限，过期必须重新取用。外部 MCP 服务器折进同一张表。
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Registry } from './src/registry.js'
import { Gate } from './src/gate.js'
import { makeCtx, runTool } from './src/runner.js'
import { McpBridge } from './src/mcp-bridge.js'
import { json, ensureDir, readJsonSafe, writeJsonSafe, machineId, truncate, int } from './src/util.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PKG = readJsonSafe(path.join(here, 'package.json'), { version: '0.0.0' }) || { version: '0.0.0' }

export const name = 'tey-mcp'
export const inject = ['tools']

const DEFAULTS = {
  ttlSeconds: 1800,
  idleSeconds: 900,
  fetchMin: 30,
  fetchMax: 50,
  maxBatch: 12,
  resultMaxChars: 20000,
  packsDisabled: [],
  mcpServers: [],
}

/** 会话键：尽量拿真实会话 id，拿不到退化成工作区。 */
function sessionOf(exec) {
  const e = exec || {}
  const cands = [
    e.session && e.session.id,
    e.agent && e.agent.session && e.agent.session.id,
    e.header && e.header.sessionId,
    e.header && e.header.id,
    e.sessionId,
  ]
  for (const c of cands) if (typeof c === 'string' && c) return `s:${c}`
  const cwd = cwdOf(exec)
  return cwd ? `w:${cwd}` : 'g:global'
}

function cwdOf(exec) {
  const e = exec || {}
  const cands = [
    e.cwd,
    e.workspace && e.workspace.root,
    e.agent && e.agent.session && e.agent.session.cwd,
    e.header && e.header.cwd,
    e.options && e.options.cwd,
  ]
  for (const c of cands) if (typeof c === 'string' && c) return c
  return ''
}

export function apply(ctx, config) {
  const dataDir = path.join(os.homedir(), '.dsh', 'tey-mcp')
  ensureDir(dataDir)
  const fileCfg = readJsonSafe(path.join(dataDir, 'config.json'), {}) || {}
  const cfg = { ...DEFAULTS, ...(config || {}), ...fileCfg }

  const registry = new Registry()
  const gate = new Gate(cfg)
  const bridge = new McpBridge(cfg.mcpServers || [])
  let bridgeDone = false
  let bridgeError = []

  const loadPromise = (async () => {
    await registry.loadDir(path.join(here, 'src', 'packs'))
    for (const id of cfg.packsDisabled || []) registry.removePack(String(id))
    if (Array.isArray(cfg.mcpServers) && cfg.mcpServers.length) {
      try {
        await bridge.connectAll((pack) => {
          const res = registry.addPack(pack)
          if (!res.ok) bridgeError.push(`${pack.id}: ${res.message}`)
        })
        bridgeDone = true
      } catch (e) {
        bridgeError.push(String(e && e.message))
      }
    }
    return registry.count()
  })().catch((e) => {
    registry.loadError.push({ dir: 'src/packs', message: String(e && e.message) })
    return registry.count()
  })

  const ready = () => registry.loaded

  const reg = (tool) =>
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: { type: 'object', properties: tool.properties || {}, additionalProperties: false },
      timeoutMs: tool.timeoutMs || 120000,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : json(value) }],
      },
      execute: async (args, exec) => {
        try {
          const out = await tool.run(args || {}, exec)
          return typeof out === 'string' ? out : json(out)
        } catch (e) {
          return json({ ok: false, code: 'meta_error', message: String((e && e.message) || e) })
        }
      },
    })

  // ---- 1. tey_status ----
  reg({
    name: 'tey_status',
    description:
      'tey 工具总线总览：总线里有多少工具/哪些组、指纹门配置（有效期与闲置时限）、当前有效指纹、外部 MCP 状态。' +
      '用总线之前先调它一次，知道有哪些组可取。无参数。',
    properties: {},
    async run(_args, exec) {
      await loadPromise
      const sessionKey = sessionOf(exec)
      const counts = registry.count()
      return {
        ok: true,
        plugin: { name: PKG.name, version: PKG.version, dataDir },
        bus: { packCount: counts.packs, toolCount: counts.tools, packs: registry.packList().map((p) => ({ id: p.id, tools: p.tools, title: p.title, tags: p.tags })) },
        gate: {
          ttlSeconds: Math.round(gate.ttlMs / 1000),
          idleSeconds: Math.round(gate.idleMs / 1000),
          fetchMin: gate.fetchMin,
          fetchMax: gate.fetchMax,
          maxBatch: Math.max(1, int(cfg.maxBatch, 12)),
          maxGrantsPerSession: gate.maxGrants,
          machine: machineId(),
        },
        session: { key: sessionKey, cwd: cwdOf(exec) },
        activeFingerprints: gate.list(sessionKey),
        mcp: { configured: (cfg.mcpServers || []).length, connected: bridgeDone, servers: bridge.status(), errors: bridgeError },
        loadErrors: registry.loadError,
        hint: 'tey_packs 查清单 → tey_fetch 取一批（拿 fingerprint）→ tey_call / tey_batch 执行',
      }
    },
  })

  // ---- 2. tey_packs ----
  reg({
    name: 'tey_packs',
    description:
      '列工具总线里的工具组与工具名（薄清单，不含参数）。给 pack 看某一组的全部工具名；给 query 按关键词搜；都不给看组清单。' +
      '取用前用它确认工具名，别凭记忆猜。',
    properties: {
      pack: { type: 'string', description: '组 id，例如 fs / net / nvidia' },
      query: { type: 'string', description: '关键词，匹配工具名与说明' },
      limit: { type: 'integer', description: '最多几条，默认 60' },
      offset: { type: 'integer', description: '分页偏移，默认 0' },
    },
    async run(args, exec) {
      await loadPromise
      if (!args.pack && !args.query) {
        const rows = registry.packList().map((p) => `${p.id.padEnd(10)} ${String(p.tools).padStart(4)}  ${p.title} :: ${p.summary}`)
        return `工具组 ${rows.length} 个 / 工具 ${registry.count().tools} 个\n${rows.join('\n')}\n# 看某组全部工具名：tey_packs {"pack":"fs"}`
      }
      const r = registry.thin({ pack: args.pack, query: args.query, limit: args.limit || 60, offset: args.offset || 0 })
      const rows = r.rows.map((x) => `${x.name.padEnd(26)} ${x.write ? 'W' : ' '} ${x.desc}`)
      return json({ total: r.total, offset: r.offset, shown: rows.length, rows })
    },
  })

  // ---- 3. tey_fetch ----
  reg({
    name: 'tey_fetch',
    description:
      '取一批工具：返回完整参数说明 + 一张 fingerprint。tey_call 必须带这张指纹，没取用的工具不能调用。' +
      '默认一次给 30-50 个（可传 limit）。用法：{"pack":"fs"} 取整组；{"query":"显存"} 按关键词取；' +
      '{"names":["fs_read","fs_grep"]} 指定取；什么都不给就跨组轮转发一批。闲置模型建议一次取 30-50 个再干活。',
    timeoutMs: 60000,
    properties: {
      pack: { type: 'string', description: '组 id，例如 fs / net / nvidia' },
      query: { type: 'string', description: '关键词搜索取用' },
      names: { type: 'array', description: '指定要取的工具名', items: { type: 'string', description: '工具名' } },
      limit: { type: 'integer', description: '这次最多给几个工具，默认 40，上限按配置（默认 50）' },
    },
    async run(args, exec) {
      await loadPromise
      const limit = Math.max(gate.fetchMin, Math.min(Number(args.limit) || gate.fetchMax, gate.fetchMax))
      const hasNames = Array.isArray(args.names) && args.names.length
      let picked
      let reason
      if (args.pack || args.query || hasNames) {
        picked = registry.pick({ pack: args.pack, query: args.query, names: args.names, limit })
        reason = args.pack ? `pack:${args.pack}` : args.query ? `query:${args.query}` : 'names'
      } else {
        // 什么参数都不给：跨组轮转发一批（闲置模型一次拿 30-50 个就能干活）
        const lists = [...registry.packs.values()].map((p) => p.toolNames.slice())
        const names = []
        let moved = true
        while (moved && names.length < limit) {
          moved = false
          for (const list of lists) {
            const n = list.shift()
            if (!n) continue
            moved = true
            names.push(n)
            if (names.length >= limit) break
          }
        }
        picked = registry.pick({ names, limit })
        reason = 'default-spread'
      }
      if (!picked.length) return json({ ok: false, code: 'nothing_to_fetch', message: '没匹配到工具，先 tey_packs 看有什么', hint: { packs: registry.packList().map((p) => p.id) } })
      const sessionKey = sessionOf(exec)
      const grant = gate.issue({ sessionKey, cwd: cwdOf(exec), tools: picked.map((t) => t.name), packs: args.pack ? [args.pack] : [], reason })
      const tools = picked.map((t) => ({ name: t.name, description: t.desc, write: t.write, parameters: t.schema }))
      return {
        ok: true,
        fingerprint: grant.fp,
        issuedAt: new Date(grant.issuedAt).toISOString(),
        expiresAt: new Date(grant.expiresAt).toISOString(),
        ttlSeconds: Math.round((grant.expiresAt - grant.issuedAt) / 1000),
        idleSeconds: Math.round(gate.idleMs / 1000),
        fetched: tools.length,
        note: `带 fingerprint 调 tey_call/tey_batch；过期或闲置作废后要重新 tey_fetch`,
        tools,
      }
    },
  })

  // ---- 4. tey_call ----
  reg({
    name: 'tey_call',
    description:
      '执行总线里的一个工具。必须带 tey_fetch 给的 fingerprint，且工具必须在那次取用的清单里。' +
      '形如 {"fingerprint":"tey-xxxx","tool":"fs_read","args":{"path":"README.md"}}。' +
      '返回 {ok,value}；指纹过期/闲置会返回 code=fingerprint_expired，重新 tey_fetch 即可。',
    timeoutMs: 300000,
    properties: {
      fingerprint: { type: 'string', description: 'tey_fetch 返回的指纹' },
      tool: { type: 'string', description: '工具名，必须在已取用清单里' },
      args: { type: 'object', description: '工具参数对象', props: {} },
    },
    async run(args, exec) {
      await loadPromise
      const sessionKey = sessionOf(exec)
      const check = gate.verify(args.fingerprint, { sessionKey, tool: args.tool })
      if (!check.ok) return json({ ok: false, ...check, next: 'tey_fetch' })
      const ctxRun = makeCtx({ cwd: cwdOf(exec) || process.cwd(), sessionId: sessionKey, config: cfg, dataDir, registry, callTool })
      const r = await runTool(registry.get(args.tool), args.args || {}, ctxRun)
      return r.ok ? json({ ok: true, tool: args.tool, value: r.value, calls: check.grant.calls, expiresAt: new Date(check.grant.expiresAt).toISOString() }) : json({ ok: false, tool: args.tool, ...r })
    },
  })

  // ---- 5. tey_batch ----
  reg({
    name: 'tey_batch',
    description:
      '一次跑多个工具（省往返）。同一个 fingerprint，calls 最多 maxBatch 个（默认 12）。' +
      '形如 {"fingerprint":"tey-xxxx","calls":[{"tool":"fs_read","args":{"path":"a.md"}},{"tool":"fs_grep","args":{"pattern":"TODO"}}]}。' +
      '按顺序执行，单个失败不影响其余，结果逐条返回。',
    timeoutMs: 600000,
    properties: {
      fingerprint: { type: 'string', description: 'tey_fetch 返回的指纹' },
      calls: { type: 'array', description: '调用列表，每项是 JSON 文本 {"tool":"...","args":{...}}', items: { type: 'string', description: '一次调用的 JSON' } },
      stopOnError: { type: 'boolean', description: '遇到失败就停，默认 false' },
    },
    async run(args, exec) {
      await loadPromise
      const sessionKey = sessionOf(exec)
      const ctxRun = makeCtx({ cwd: cwdOf(exec) || process.cwd(), sessionId: sessionKey, config: cfg, dataDir, registry, callTool })
      const items = (Array.isArray(args.calls) ? args.calls : []).slice(0, Math.max(1, Number(cfg.maxBatch) || 12)).map((raw) => {
        if (typeof raw === 'string') {
          try {
            return JSON.parse(raw)
          } catch (e) {
            return { __bad: raw }
          }
        }
        return raw
      })
      const results = []
      for (const item of items) {
        if (!item || item.__bad !== undefined || !item.tool) {
          results.push({ ok: false, tool: String((item && item.tool) || ''), code: 'bad_call', message: `这一条不成形: ${JSON.stringify(item).slice(0, 120)}` })
          continue
        }
        const check = gate.verify(args.fingerprint, { sessionKey, tool: item.tool })
        if (!check.ok) {
          results.push({ ok: false, tool: item.tool, ...check })
          if (args.stopOnError) break
          continue
        }
        const r = await runTool(registry.get(item.tool), item.args || {}, ctxRun)
        results.push({ tool: item.tool, ...r })
        if (args.stopOnError && !r.ok) break
      }
      const okCount = results.filter((r) => r.ok).length
      return json({ ok: okCount === results.length, fingerprint: args.fingerprint, ran: results.length, succeeded: okCount, results })
    },
  })

  // ---- 6. tey_mcp ----
  reg({
    name: 'tey_mcp',
    description:
      '外部 MCP 服务器（NVIDIA RAG、任意 FastMCP/stdio/streamable-http）桥接。action=status 看连接；' +
      'refresh 重连并列工具（会折进总线，之后用 tey_fetch {"pack":"mcp-名字"} 取用）；' +
      'tools 列某服务器工具；call 直连一次 {"server":"rag","tool":"search","args":{...}}。',
    timeoutMs: 300000,
    properties: {
      action: { type: 'string', description: 'status | refresh | tools | call', enum: ['status', 'refresh', 'tools', 'call'], required: true },
      server: { type: 'string', description: '服务器名（refresh/tools/call 要填）' },
      tool: { type: 'string', description: 'call 时的工具名' },
      args: { type: 'object', description: 'call 时的参数', props: {} },
    },
    async run(args, exec) {
      await loadPromise
      const action = args.action
      if (action === 'status') {
        return json({ ok: true, configured: cfg.mcpServers || [], servers: bridge.status(), packs: registry.packList().filter((p) => p.external) })
      }
      if (action === 'refresh') {
        if (!args.server) return json({ ok: false, message: 'refresh 要填 server' })
        const spec = (cfg.mcpServers || []).find((s) => String(s.name) === String(args.server))
        if (!spec) return json({ ok: false, message: `配置里没有这个 server：${args.server}`, configured: (cfg.mcpServers || []).map((s) => s.name) })
        try {
          const pack = await bridge.connectOne(spec)
          registry.removePack(pack.id)
          const res = registry.addPack(pack)
          return json({ ok: res.ok, pack: pack.id, tools: pack.tools.length, added: res.added || 0, message: res.message })
        } catch (e) {
          return json({ ok: false, message: String((e && e.message) || e) })
        }
      }
      if (action === 'tools') {
        const packId = `mcp-${String(args.server || '').toLowerCase()}`
        const p = registry.packs.get(packId)
        if (!p) return json({ ok: false, message: `还没连上 ${args.server}，先 tey_mcp {"action":"refresh","server":"${args.server}"}` })
        return json({ pack: packId, tools: p.toolNames })
      }
      if (action === 'call') {
        if (!args.server || !args.tool) return json({ ok: false, message: 'call 要填 server 与 tool' })
        try {
          const value = await bridge.call(args.server, args.tool, args.args || {}, 120000)
          return truncate(value, cfg.resultMaxChars)
        } catch (e) {
          return json({ ok: false, message: String((e && e.message) || e) })
        }
      }
      return json({ ok: false, message: `未知 action: ${action}` })
    },
  })

  // ---- 7. tey_configure ----
  reg({
    name: 'tey_configure',
    description:
      '调总线自己的运行参数（存 ~/.dsh/tey-mcp/config.json，重启也生效）：ttlSeconds 指纹有效期、idleSeconds 闲置时限、' +
      'fetchMin/fetchMax 一次取几个工具、maxBatch 批量上限、resultMaxChars 返回截断、packsDisabled 关组。' +
      'action=get 看当前值；set 改一项 {"key":"fetchMax","value":"40"}；revoke 作废一张指纹；clear 作废全部。',
    properties: {
      action: { type: 'string', description: 'get | set | revoke | clear', enum: ['get', 'set', 'revoke', 'clear'], required: true },
      key: { type: 'string', description: 'set 时的参数名' },
      value: { type: 'string', description: 'set 时的值（数字给数字文本，数组用逗号分隔）' },
      fingerprint: { type: 'string', description: 'revoke 时要作废的指纹' },
    },
    async run(args, exec) {
      await loadPromise
      const action = args.action
      if (action === 'get') return json({ ok: true, effective: cfg, file: path.join(dataDir, 'config.json'), fileOverrides: fileCfg, gate: { ttlMs: gate.ttlMs, idleMs: gate.idleMs, fetchMin: gate.fetchMin, fetchMax: gate.fetchMax, maxGrants: gate.maxGrants } })
      if (action === 'set') {
        const key = String(args.key || '')
        if (!(key in DEFAULTS)) return json({ ok: false, message: `不认的 key: ${key}`, allowed: Object.keys(DEFAULTS) })
        let value = args.value
        if (Array.isArray(DEFAULTS[key])) value = String(value).split(',').map((s) => s.trim()).filter(Boolean)
        else if (typeof DEFAULTS[key] === 'number') value = Number(value)
        else if (typeof DEFAULTS[key] === 'boolean') value = value === true || String(value) === 'true'
        const next = { ...readJsonSafe(path.join(dataDir, 'config.json'), {}), [key]: value }
        writeJsonSafe(path.join(dataDir, 'config.json'), next)
        Object.assign(cfg, { [key]: value })
        gate.setConfig(cfg)
        return json({ ok: true, key, value, note: '已写入 config.json，本会话立即生效' })
      }
      if (action === 'revoke') {
        const n = gate.revoke(args.fingerprint)
        return json({ ok: n, message: n ? '已作废' : '没这张指纹' })
      }
      if (action === 'clear') return json({ ok: true, revoked: gate.clear() })
      return json({ ok: false, message: `未知 action: ${action}` })
    },
  })

  // 总线内部互调（工具里的 ctx.call）
  async function callTool(name, args) {
    const tool = registry.get(name)
    if (!tool) return { ok: false, code: 'tool_not_found', message: `${name} 不在总线里` }
    const ctxRun = makeCtx({ cwd: process.cwd(), sessionId: 'internal', config: cfg, dataDir, registry, callTool })
    return runTool(tool, args || {}, ctxRun)
  }

  return () => {
    bridge.dispose()
  }
}
