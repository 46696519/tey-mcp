// 外部 MCP 桥：把 stdio / streamable-http 的 MCP 服务器（NVIDIA RAG、任意 FastMCP）
// 的工具折进同一个注册表，走同一套指纹门。零依赖，手写 JSON-RPC。
import { spawn } from 'node:child_process'
import { safeEnv, int, sha256 } from './util.js'

const PROTOCOL = '2024-11-05'
const CLIENT_INFO = { name: 'tey-mcp', version: '0.1.0' }

class StdioLink {
  constructor(spec) {
    this.spec = spec
    this.child = null
    this.buf = Buffer.alloc(0)
    this.pending = new Map()
    this.seq = 1
    this.dead = false
  }

  async start() {
    const { command, args = [], cwd, env } = this.spec
    if (!command) throw new Error('stdio 服务器缺 command')
    this.child = spawn(command, args.map(String), {
      cwd: cwd || process.cwd(),
      env: safeEnv(env),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.on('error', (e) => this._fail(String(e && e.message)))
    this.child.on('close', (code) => this._fail(`子进程退出 code=${code}`))
    this.child.stderr && this.child.stderr.on('data', () => {})
    this.child.stdout.on('data', (chunk) => this._feed(chunk))
  }

  _fail(message) {
    this.dead = true
    for (const [, p] of this.pending) p.reject(new Error(message))
    this.pending.clear()
  }

  _feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      const idx = this.buf.indexOf('\r\n\r\n')
      if (idx < 0) return
      const head = this.buf.subarray(0, idx).toString('latin1')
      const m = head.match(/content-length:\s*(\d+)/i)
      if (!m) {
        this.buf = this.buf.subarray(idx + 4)
        continue
      }
      const len = Number(m[1])
      if (this.buf.length < idx + 4 + len) return
      const body = this.buf.subarray(idx + 4, idx + 4 + len).toString('utf8')
      this.buf = this.buf.subarray(idx + 4 + len)
      let msg
      try {
        msg = JSON.parse(body)
      } catch (e) {
        continue
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(`${msg.error.code || ''} ${msg.error.message || 'MCP 错误'}`))
        else p.resolve(msg.result)
      }
    }
  }

  request(method, params, timeoutMs) {
    if (this.dead) return Promise.reject(new Error('连接已断'))
    const id = this.seq++
    const payload = { jsonrpc: '2.0', id, method, params }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时 ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
        this.child.stdin.write(body)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(String(e && e.message)))
      }
    })
  }

  notify(method, params) {
    try {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }), 'utf8')
      this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
      this.child.stdin.write(body)
    } catch (e) {}
  }

  close() {
    this.dead = true
    try {
      this.child && this.child.kill()
    } catch (e) {}
  }
}

class HttpLink {
  constructor(spec) {
    this.spec = spec
    this.sessionId = ''
    this.seq = 1
  }

  async start() {
    if (!this.spec.url) throw new Error('http 服务器缺 url')
    await this.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, int(this.spec.timeoutMs, 30000))
    await this.notify('notifications/initialized', {})
  }

  async request(method, params, timeoutMs) {
    const id = this.seq++
    const raw = await this._post({ jsonrpc: '2.0', id, method, params }, timeoutMs)
    if (raw.error) throw new Error(`${raw.error.code || ''} ${raw.error.message || 'MCP 错误'}`)
    return raw.result
  }

  async notify(method, params) {
    await this._post({ jsonrpc: '2.0', method, params }, int(this.spec.timeoutMs, 30000)).catch(() => null)
  }

  async _post(payload, timeoutMs) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000)
    try {
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.spec.headers || {}),
      }
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId
      const res = await fetch(this.spec.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
      const jsonText = extractJson(text)
      if (!jsonText) throw new Error('响应里没有 JSON')
      return JSON.parse(jsonText)
    } finally {
      clearTimeout(timer)
    }
  }

  close() {}
}

/** SSE 或纯 JSON 里捞出属于这次请求的 JSON。 */
function extractJson(text) {
  const t = String(text).trim()
  if (!t) return ''
  if (t.startsWith('{') || t.startsWith('[')) return t
  const datas = t
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter(Boolean)
  for (let i = datas.length - 1; i >= 0; i--) {
    if (datas[i].startsWith('{')) return datas[i]
  }
  return ''
}

export class McpBridge {
  constructor(servers = []) {
    this.servers = servers.map((s) => ({ ...s, name: String(s.name || '') })).filter((s) => /^[A-Za-z0-9_-]{1,32}$/.test(s.name))
    this.links = new Map()
    this.state = new Map()
  }

  async connectAll(onPack) {
    const out = []
    for (const spec of this.servers) {
      try {
        const pack = await this.connectOne(spec)
        this.state.set(spec.name, { ok: true, tools: pack.tools.length })
        out.push(pack)
        if (onPack) await onPack(pack)
      } catch (e) {
        this.state.set(spec.name, { ok: false, message: String(e && e.message) })
      }
    }
    return out
  }

  async connectOne(spec) {
    const link = spec.transport === 'stdio' ? new StdioLink(spec) : new HttpLink(spec)
    await link.start()
    this.links.set(spec.name, link)
    const res = await link.request('tools/list', {}, int(spec.timeoutMs, 30000))
    const tools = (res && res.tools) || []
    return {
      id: `mcp-${spec.name}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
      title: `MCP · ${spec.name}`,
      tags: ['mcp', spec.name],
      summary: `外部 MCP 服务器 ${spec.name}（${spec.transport || 'http'}）`,
      external: true,
      server: spec.name,
      tools: tools.map((t) => ({
        name: `mcp_${spec.name}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 64),
        desc: String(t.description || `MCP ${spec.name}.${t.name}`).slice(0, 200),
        params: mcpParams(t.inputSchema),
        write: true,
        timeoutMs: int(spec.toolCallTimeoutMs, 60000),
        run: async (args, ctx) => {
          const value = await this.call(spec.name, t.name, args, int(spec.toolCallTimeoutMs, 60000))
          return value
        },
      })),
    }
  }

  async call(server, tool, args, timeoutMs = 60000) {
    const link = this.links.get(String(server))
    if (!link) throw new Error(`MCP 服务器 ${server} 没连上`)
    const res = await link.request('tools/call', { name: tool, arguments: args || {} }, timeoutMs)
    return renderMcpResult(res)
  }

  status() {
    return [...this.state.entries()].map(([name, s]) => ({ server: name, ...s }))
  }

  dispose() {
    for (const [, link] of this.links) link.close()
    this.links.clear()
  }
}

/** MCP inputSchema（JSON Schema）→ tey 参数表。认不出的形状退化成单 payload 参数。 */
function mcpParams(inputSchema) {
  const out = {}
  const props = inputSchema && typeof inputSchema === 'object' ? inputSchema.properties : null
  if (!props || typeof props !== 'object') return { payload: { type: 'object', required: true, desc: '原样传给服务器的参数对象', props: {} } }
  const required = Array.isArray(inputSchema.required) ? inputSchema.required : []
  for (const [key, node] of Object.entries(props)) {
    const clean = key.replace(/[^a-z0-9_]/g, '_').toLowerCase()
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(clean)) continue
    const t = node && node.type
    if (t === 'array') out[clean] = { type: 'array', desc: String(node.description || key).slice(0, 200), required: required.includes(key), items: { type: mapType(node.items && node.items.type), desc: '元素' } }
    else if (t === 'object') out[clean] = { type: 'object', desc: String(node.description || key).slice(0, 200), required: required.includes(key), props: {} }
    else out[clean] = { type: mapType(t), desc: String(node.description || key).slice(0, 200), required: required.includes(key), enum: Array.isArray(node && node.enum) ? node.enum.map(String) : undefined }
  }
  return out
}

function mapType(t) {
  if (t === 'integer') return 'integer'
  if (t === 'number') return 'number'
  if (t === 'boolean') return 'boolean'
  return 'string'
}

function renderMcpResult(res) {
  if (!res || typeof res !== 'object') return String(res)
  const parts = Array.isArray(res.content) ? res.content : []
  const text = parts
    .map((p) => {
      if (!p || typeof p !== 'object') return String(p)
      if (p.type === 'text') return String(p.text || '')
      if (p.type === 'image') return `[image ${p.mimeType || ''} ${p.data ? `${p.data.length}b64` : ''}]`
      if (p.type === 'resource_link') return `[resource ${p.name || ''} ${p.uri || ''}]`
      return `[${p.type || 'block'}]`
    })
    .join('\n')
  const structured = res.structuredContent ? `\n${JSON.stringify(res.structuredContent, null, 2)}` : ''
  const flag = res.isError ? '⚠ 服务器报错\n' : ''
  return `${flag}${text}${structured}`.trim() || JSON.stringify(res)
}

export function serverFingerprint(servers) {
  return sha256(JSON.stringify(servers.map((s) => [s.name, s.transport, s.command, s.args, s.url]))).slice(0, 12)
}
