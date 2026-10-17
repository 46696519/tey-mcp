// 工具注册表：把 src/packs/*.js 的包对象收进来，建索引，按组/关键词取用。
// 参数表编译成 DSH 注册用的形状：对象节点显式 additionalProperties，必填按属性标记。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { clamp, int } from './util.js'

const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/
const TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object'])

export class Registry {
  constructor() {
    this.packs = new Map()
    this.tools = new Map()
    this.loaded = false
    this.loadError = []
    this.startedAt = Date.now()
  }

  /** 扫描目录并加载全部包（跳过 _ 前缀文件）。 */
  async loadDir(dir) {
    let files = []
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_'))
    } catch (e) {
      this.loadError.push({ dir, message: String(e && e.message) })
      this.loaded = true
      return this
    }
    for (const f of files) {
      const full = path.join(dir, f)
      try {
        const mod = await import(pathToFileURL(full).href)
        const pack = mod.default || mod.pack
        const res = this.addPack(pack)
        if (!res.ok) this.loadError.push({ file: f, message: res.message })
      } catch (e) {
        this.loadError.push({ file: f, message: String(e && e.message) })
      }
    }
    this.loaded = true
    return this
  }

  /** 加一个包（外部 MCP 工具也走这里）。 */
  addPack(pack) {
    if (!pack || typeof pack !== 'object') return { ok: false, message: '包不是对象' }
    const id = String(pack.id || '')
    if (!/^[a-z][a-z0-9-]{1,20}$/.test(id)) return { ok: false, message: `包 id 不合法: ${id}` }
    const tools = Array.isArray(pack.tools) ? pack.tools : []
    if (!tools.length) return { ok: false, message: `${id}: 没有工具` }
    const entry = {
      id,
      title: String(pack.title || id),
      tags: Array.isArray(pack.tags) ? pack.tags.map(String) : [],
      summary: String(pack.summary || ''),
      external: !!pack.external,
      toolNames: [],
    }
    for (const t of tools) {
      const name = String((t && t.name) || '')
      if (!NAME_RE.test(name)) return { ok: false, message: `${id}: 工具名不合法 ${name}` }
      if (this.tools.has(name)) return { ok: false, message: `工具名重复: ${name}` }
      if (typeof (t.run || t.execute) !== 'function') return { ok: false, message: `${name}: 没有 run 函数` }
      const compiled = compileParams(t.params)
      if (!compiled.ok) return { ok: false, message: compiled.message }
      this.tools.set(name, {
        name,
        pack: id,
        desc: String(t.desc || ''),
        params: t.params && typeof t.params === 'object' ? t.params : {},
        schema: compiled.schema,
        write: t.write === true,
        timeoutMs: int(t.timeoutMs, 30000),
        run: t.run || t.execute,
        meta: t.meta || null,
      })
      entry.toolNames.push(name)
    }
    this.packs.set(id, entry)
    return { ok: true, added: entry.toolNames.length }
  }

  /** 卸掉某个外部包（MCP 服务器断开时用）。 */
  removePack(id) {
    const p = this.packs.get(id)
    if (!p) return false
    for (const n of p.toolNames) this.tools.delete(n)
    this.packs.delete(id)
    return true
  }

  packList() {
    return [...this.packs.values()].map((p) => ({
      id: p.id,
      title: p.title,
      summary: p.summary,
      tags: p.tags,
      tools: p.toolNames.length,
      external: !!p.external,
    }))
  }

  /** 薄清单：包概览 + 命中工具的名字与一句话。 */
  thin({ pack, query, limit = 60, offset = 0 } = {}) {
    const q = String(query || '').toLowerCase().trim()
    let names = [...this.tools.keys()]
    if (pack) names = names.filter((n) => this.tools.get(n).pack === pack)
    if (q) {
      names = names.filter((n) => {
        const t = this.tools.get(n)
        return `${n} ${t.desc} ${t.pack} ${this.packs.get(t.pack)?.tags.join(' ') || ''}`.toLowerCase().includes(q)
      })
    }
    const total = names.length
    const rows = names.slice(offset, offset + limit).map((n) => {
      const t = this.tools.get(n)
      return { name: n, pack: t.pack, desc: t.desc, write: t.write }
    })
    return { total, offset, rows }
  }

  /** 按包 / 关键词 / 指定名字取工具，返回去重后的工具数组（受 limit 约束）。 */
  pick({ pack, query, names, limit } = {}) {
    const cap = clamp(int(limit, 40), 1, 200)
    const picked = []
    const seen = new Set()
    const push = (t) => {
      if (!t || seen.has(t.name) || picked.length >= cap) return
      seen.add(t.name)
      picked.push(t)
    }
    if (Array.isArray(names) && names.length) {
      for (const n of names) push(this.tools.get(String(n)))
    }
    if (pack) {
      const p = this.packs.get(String(pack))
      if (p) for (const n of p.toolNames) push(this.tools.get(n))
    }
    if (query) {
      const q = String(query).toLowerCase()
      for (const t of this.tools.values()) {
        if (`${t.name} ${t.desc} ${t.pack}`.toLowerCase().includes(q)) push(t)
      }
    }
    return picked
  }

  get(name) {
    return this.tools.get(String(name))
  }

  count() {
    return { packs: this.packs.size, tools: this.tools.size }
  }
}

/** 参数表 → DSH 注册形状。返回 {ok:true,schema} 或 {ok:false,message}。 */
export function compileParams(params) {
  const props = {}
  if (params && typeof params === 'object') {
    for (const [key, raw] of Object.entries(params)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)) return { ok: false, message: `参数名不合法: ${key}` }
      const node = compileNode(key, raw)
      if (!node.ok) return node
      props[key] = node.node
    }
  }
  return { ok: true, schema: { type: 'object', properties: props, additionalProperties: false } }
}

function compileNode(key, raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, message: `${key}: 参数定义不是对象` }
  const type = raw.type
  if (!TYPES.has(type)) return { ok: false, message: `${key}: 类型不合法 ${type}` }
  const out = { type }
  if (raw.desc) out.description = String(raw.desc)
  if (raw.required === true) out.required = true
  if (raw.default !== undefined) out.default = raw.default
  if (raw.enum !== undefined) out.enum = raw.enum
  if (raw.examples !== undefined) out.examples = raw.examples
  if (type === 'array') {
    if (!raw.items || typeof raw.items !== 'object') return { ok: false, message: `${key}: array 缺 items` }
    const items = compileNode(`${key}[]`, { ...raw.items, required: undefined })
    if (!items.ok) return items
    out.items = items.node
  }
  if (type === 'object') {
    if (!raw.props || typeof raw.props !== 'object') return { ok: false, message: `${key}: object 缺 props` }
    const sub = {}
    for (const [k, v] of Object.entries(raw.props)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(k)) return { ok: false, message: `${key}.${k}: 参数名不合法` }
      const child = compileNode(`${key}.${k}`, v)
      if (!child.ok) return child
      sub[k] = child.node
    }
    out.properties = sub
    out.additionalProperties = false
  }
  return { ok: true, node: out }
}
