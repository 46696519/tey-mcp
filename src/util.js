// tey-mcp 共享工具函数：包作者与运行时都用它。零第三方依赖。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { spawn } from 'node:child_process'

export const MAX_BUFFER = 4 * 1024 * 1024

/** 把对象收成紧凑 JSON 字符串（工具返回值统一走这里）。 */
export function json(value, space) {
  try {
    return JSON.stringify(value, null, space) ?? String(value)
  } catch (e) {
    return JSON.stringify({ ok: false, code: 'unserializable', message: String(e && e.message) })
  }
}

/** 单行摘要 + 可选明细，给模型看的常见返回形状。 */
export function list1(title, rows, note) {
  const lines = Array.isArray(rows) ? rows : []
  let out = `${title} (${lines.length})\n` + lines.join('\n')
  if (note) out += `\n# ${note}`
  return out
}

export function bool(v, fallback = false) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    if (/^(1|true|yes|y|on)$/i.test(v)) return true
    if (/^(0|false|no|n|off)$/i.test(v)) return false
  }
  return fallback
}

export function int(v, fallback) {
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex')
}

export function sha256buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function md5(text) {
  return crypto.createHash('md5').update(String(text)).digest('hex')
}

export function randomHex(n = 8) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n)
}

/** 机器指纹：主机名 + 平台 + 架构 + 内存 + CPU 型号，取 12 位十六进制。 */
export function machineId() {
  let cpu = ''
  try {
    cpu = (os.cpus()[0] && os.cpus()[0].model) || ''
  } catch (e) {
    cpu = ''
  }
  return sha256([os.hostname(), os.platform(), os.arch(), os.totalmem(), cpu].join('|')).slice(0, 12)
}

export function truncate(text, max) {
  const cap = int(max, 20000)
  const s = typeof text === 'string' ? text : json(text)
  if (s.length <= cap) return s
  return `${s.slice(0, cap)}\n…[truncated ${s.length - cap} chars]`
}

/** 安全读文本（不存在返回 null，不抛）。 */
export async function readTextSafe(abs, limitBytes = MAX_BUFFER) {
  try {
    const st = await fsp.stat(abs)
    if (!st.isFile()) return { ok: false, code: 'not-file', path: abs }
    const handle = await fsp.open(abs, 'r')
    try {
      const size = Math.min(st.size, limitBytes)
      const buf = Buffer.alloc(size)
      await handle.read(buf, 0, size, 0)
      return { ok: true, path: abs, size: st.size, mtimeMs: st.mtimeMs, text: buf.toString('utf8'), truncated: st.size > size }
    } finally {
      await handle.close()
    }
  } catch (e) {
    return { ok: false, code: 'read-failed', path: abs, message: String(e && e.message) }
  }
}

export function walkFiles(root, { maxDepth = 6, maxFiles = 5000, skip = /(^|[\\/])(\.git|node_modules|dist|build|\.next|target|__pycache__)([\\/]|$)/ } = {}) {
  const out = []
  const stack = [[path.resolve(root), 0]]
  while (stack.length) {
    const [dir, depth] = stack.pop()
    if (depth > maxDepth || out.length >= maxFiles) continue
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      continue
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) break
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!skip.test(full)) stack.push([full, depth + 1])
      } else if (ent.isFile()) {
        if (!skip.test(full)) out.push(full)
      }
    }
  }
  return out
}

/** glob（* ? **）转正则，供包内自实现搜索用。 */
export function globToRe(glob) {
  const src = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '[^/\\\\]')
    .replace(/\u0000/g, '(?:.*/|)')
    .replace(/\u0001/g, '.*')
  return new RegExp(`^${src}$`, 'i')
}

/** 起进程：不抛异常，带超时，敏感环境变量不继承。 */
export function execCmd(cmd, args = [], { cwd, timeoutMs = 30000, env, input, shell = false } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd: cwd || process.cwd(),
        shell,
        windowsHide: true,
        env: safeEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e && e.message), timedOut: false, cmd, args })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill('SIGKILL')
      } catch (e) {}
      resolve({ code: -1, stdout, stderr, timedOut: true, cmd, args })
    }, Math.max(500, int(timeoutMs, 30000)))
    child.stdout && child.stdout.on('data', (d) => {
      if (stdout.length < MAX_BUFFER) stdout += d.toString('utf8')
    })
    child.stderr && child.stderr.on('data', (d) => {
      if (stderr.length < MAX_BUFFER) stderr += d.toString('utf8')
    })
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}\n${String(e && e.message)}`, timedOut: false, cmd, args })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut: false, cmd, args })
    })
    try {
      if (input != null) child.stdin.end(String(input))
      else child.stdin.end()
    } catch (e) {}
  })
}

export function safeEnv(extra) {
  const out = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(k)) continue
    out[k] = v
  }
  if (extra && typeof extra === 'object') Object.assign(out, extra)
  return out
}

/** 极简 YAML（仅标量/数组/一层嵌套，够用；解析失败返回 null）。 */
export function parseYamlLite(text) {
  const lines = String(text).split(/\r?\n/)
  const root = {}
  const stack = [{ node: root, indent: -1 }]
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].node
    if (line.startsWith('- ')) {
      const val = scalar(line.slice(2))
      if (Array.isArray(parent.__list)) parent.__list.push(val)
      continue
    }
    const m = line.match(/^([^:]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1].trim()
    const rest = m[2].trim()
    if (!rest) {
      const child = {}
      Object.defineProperty(child, '__list', { value: [], enumerable: false })
      parent[key] = child
      stack.push({ node: child, indent })
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      parent[key] = rest.slice(1, -1).split(',').map((s) => scalar(s.trim())).filter((v) => v !== '')
    } else {
      parent[key] = scalar(rest)
    }
  }
  return root
}

function scalar(s) {
  const v = String(s).trim().replace(/^['"]|['"]$/g, '')
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~' || v === '') return v === '' ? '' : null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

/** 极简 YAML 输出（对象 → 缩进文本）。 */
export function dumpYamlLite(obj, indent = 0) {
  const pad = '  '.repeat(indent)
  const out = []
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null) out.push(`${pad}${k}: null`)
    else if (Array.isArray(v)) out.push(`${pad}${k}: [${v.join(', ')}]`)
    else if (typeof v === 'object') out.push(`${pad}${k}:\n${dumpYamlLite(v, indent + 1)}`)
    else if (typeof v === 'string' && /[:#\n]/.test(v)) out.push(`${pad}${k}: ${JSON.stringify(v)}`)
    else out.push(`${pad}${k}: ${v}`)
  }
  return out.join('\n')
}

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch (e) {
    return false
  }
}

export function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return fallback
  }
}

export function writeJsonSafe(file, value) {
  try {
    ensureDir(path.dirname(file))
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    return true
  } catch (e) {
    return false
  }
}

export function fmtBytes(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return String(n)
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  let v = x
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 2)}${units[i]}`
}

export function fmtMs(ms) {
  const x = Number(ms)
  if (!Number.isFinite(x)) return String(ms)
  if (x < 1000) return `${Math.round(x)}ms`
  if (x < 60000) return `${(x / 1000).toFixed(2)}s`
  return `${(x / 60000).toFixed(2)}min`
}

export function nowIso() {
  return new Date().toISOString()
}
