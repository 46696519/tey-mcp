// 执行器：参数校验 + 超时 + 结果整形。工具的失败一律收成 {ok:false,code,message}。
import path from 'node:path'
import { ensureDir, truncate, int, clamp, execCmd } from './util.js'

export function makeCtx({ cwd, sessionId, config, dataDir, registry, callTool }) {
  const root = cwd || process.cwd()
  return {
    cwd: root,
    sessionId: sessionId || '',
    config: config || {},
    dataDir,
    registry,
    resolve(p, allowOutside) {
      if (typeof p !== 'string' || !p.trim()) throw new Error('路径参数为空')
      const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p)
      if (!allowOutside) {
        const rel = path.relative(root, abs)
        if (rel && rel.startsWith('..')) throw new Error(`路径越出工作区: ${abs}（要跨区请传 allowOutside 或用绝对路径工具）`)
      }
      return abs
    },
    tmp(ext = '.txt') {
      const dir = path.join(dataDir, 'tmp')
      ensureDir(dir)
      return path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    },
    truncate: (text) => truncate(text, int(config && config.resultMaxChars, 20000)),
    /** 跑外部命令：永不抛异常，返回 {code,stdout,stderr,timedOut}。默认 cwd = 会话工作区。 */
    async exec(command, args, opts = {}) {
      const r = await execCmd(String(command), (Array.isArray(args) ? args : []).map(String), {
        cwd: opts.cwd || root,
        timeoutMs: opts.timeoutMs,
        env: opts.env,
        input: opts.input,
        shell: opts.shell,
      })
      return { ...r, cwd: opts.cwd || root }
    },
    /** 带超时的 fetch：默认 20 秒后 abort，返回原生 Response。 */
    async fetch(url, opts = {}) {
      const ctrl = new AbortController()
      const ms = Math.max(1000, int(opts.timeoutMs, 20000))
      const timer = setTimeout(() => ctrl.abort(), ms)
      try {
        return await fetch(url, { ...opts, headers: { ...(opts.headers || {}) }, signal: ctrl.signal })
      } finally {
        clearTimeout(timer)
      }
    },
    async call(name, args) {
      if (typeof callTool !== 'function') return { ok: false, code: 'no_call', message: '内部调用不可用' }
      return callTool(String(name), args && typeof args === 'object' ? args : {})
    },
  }
}

/** 宽松校验：必填、类型、枚举；顺手做 string→number/boolean 的宽容转换。 */
export function validateArgs(schema, args) {
  const notes = []
  const out = {}
  const props = (schema && schema.properties) || {}
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  for (const [key, node] of Object.entries(props)) {
    let v = input[key]
    if (v === undefined || v === null || v === '') {
      if (node.required === true) return { ok: false, message: `缺参数 ${key}：${node.description || ''}` }
      if (node.default !== undefined) out[key] = node.default
      continue
    }
    if (node.type === 'integer' || node.type === 'number') {
      const n = typeof v === 'string' ? Number(v) : v
      if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, message: `参数 ${key} 要数字，收到 ${JSON.stringify(v)}` }
      v = node.type === 'integer' ? Math.trunc(n) : n
    } else if (node.type === 'boolean') {
      if (typeof v !== 'boolean') {
        const s = String(v).toLowerCase()
        if (['1', 'true', 'yes', 'y', 'on'].includes(s)) v = true
        else if (['0', 'false', 'no', 'n', 'off'].includes(s)) v = false
        else return { ok: false, message: `参数 ${key} 要布尔，收到 ${JSON.stringify(v)}` }
      }
    } else if (node.type === 'array') {
      if (!Array.isArray(v)) {
        if (typeof v === 'string') v = v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
        else return { ok: false, message: `参数 ${key} 要数组，收到 ${JSON.stringify(v)}` }
      }
    } else if (node.type === 'object') {
      if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, message: `参数 ${key} 要对象，收到 ${JSON.stringify(v)}` }
    } else if (node.type === 'string') {
      if (typeof v !== 'string') v = String(v)
    }
    if (Array.isArray(node.enum) && !node.enum.includes(v)) {
      return { ok: false, message: `参数 ${key} 只能是 ${node.enum.join('/')}，收到 ${JSON.stringify(v)}` }
    }
    out[key] = v
  }
  for (const key of Object.keys(input)) {
    if (!(key in props)) notes.push(`忽略未知参数 ${key}`)
  }
  return { ok: true, args: out, notes }
}

/** 跑一个工具：校验 → 超时执行 → 结果整形（字符串直出，对象转 JSON）。 */
export async function runTool(tool, args, ctx, { timeoutMs } = {}) {
  if (!tool) return { ok: false, code: 'tool_not_found', message: '工具不存在，先 tey_packs 查名字' }
  const check = validateArgs(tool.schema, args)
  if (!check.ok) return { ok: false, code: 'bad_args', message: check.message }
  const cap = clamp(int(timeoutMs || tool.timeoutMs, 30000), 500, 600000)
  let timer
  try {
    const work = Promise.resolve().then(() => tool.run(check.args, ctx))
    const raced = await Promise.race([
      work.then((value) => ({ __done: true, value })).catch((e) => ({ __done: true, error: e })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __timeout: true }), cap)
      }),
    ])
    if (raced && raced.__timeout) {
      return { ok: false, code: 'timeout', message: `执行超过 ${cap}ms 被掐掉，可以缩小范围重试` }
    }
    if (raced && raced.error) {
      const msg = String((raced.error && raced.error.message) || raced.error)
      return { ok: false, code: 'tool_error', message: msg.slice(0, 500) }
    }
    const raw = raced ? raced.value : undefined
    let text
    if (typeof raw === 'string') text = raw
    else if (raw == null) text = ''
    else if (Buffer.isBuffer(raw)) text = raw.toString('utf8')
    else {
      try {
        text = JSON.stringify(raw, null, 2)
      } catch (e) {
        text = String(raw)
      }
    }
    const capped = ctx.truncate(text)
    return { ok: true, value: capped, notes: check.notes }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
