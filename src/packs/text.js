// 文本与编码包：切分、正则、编解码、JSON/YAML/CSV 互转、日期与单位换算。纯文本工具不碰磁盘。
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import os from 'node:os'
import { json, int, clamp, randomHex } from '../util.js'

const enc = (v) => (v === undefined || v === null ? '' : String(v))

function lines(t) {
  return enc(t).split(/\r?\n/)
}

function getPath(obj, p) {
  const parts = enc(p).replace(/^\$\.?/, '').split(/[.[\]]/).filter(Boolean)
  let cur = obj
  for (const key of parts) {
    if (cur == null) return undefined
    const k = key.replace(/["']/g, '')
    cur = Array.isArray(cur) && /^\d+$/.test(k) ? cur[Number(k)] : cur[k]
  }
  return cur
}

function setPath(obj, p, value) {
  const parts = enc(p).replace(/^\$\.?/, '').split(/[.[\]]/).filter(Boolean)
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i].replace(/["']/g, '')
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = /^\d+$/.test(parts[i + 1]) ? [] : {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1].replace(/["']/g, '')] = value
  return obj
}

function parseCsv(text, delim) {
  const rows = []
  let row = []
  let cur = ''
  let inQ = false
  const d = delim || (text.includes('\t') ? '\t' : ',')
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      if (inQ && text[i + 1] === '"') {
        cur += '"'
        i++
      } else inQ = !inQ
    } else if (ch === d && !inQ) {
      row.push(cur)
      cur = ''
    } else if (ch === '\n' && !inQ) {
      row.push(cur)
      rows.push(row)
      row = []
      cur = ''
    } else if (ch !== '\r') cur += ch
  }
  if (cur !== '' || row.length) {
    row.push(cur)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c !== ''))
}

function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}

function fmtDate(d, pattern) {
  const p = pattern || 'YYYY-MM-DD HH:mm:ss'
  const pad = (x, n = 2) => String(x).padStart(n, '0')
  return p
    .replace(/YYYY/g, d.getFullYear())
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()))
    .replace(/SSS/g, pad(d.getMilliseconds(), 3))
}

function parseDuration(s) {
  const str = enc(s).trim()
  if (/^\d+$/.test(str)) return Number(str) * 1000
  let ms = 0
  let found = false
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/gi
  let m
  while ((m = re.exec(str))) {
    found = true
    const v = Number(m[1])
    const unit = m[2].toLowerCase()
    ms += v * (unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : unit === 'd' ? 86400000 : 604800000)
  }
  return found ? ms : NaN
}

function nextCron(expr, from = Date.now()) {
  const parts = enc(expr).trim().split(/\s+/)
  if (parts.length < 5) return null
  const [min, hour, dom, mon, dow] = parts
  const build = (spec, lo, hi) => {
    if (spec === '*') return null
    const set = new Set()
    for (const chunk of spec.split(',')) {
      const m = chunk.match(/^(\d+)(?:-(\d+))?(?:\/(\d+))?$/)
      if (!m) continue
      const a = Number(m[1])
      const b = m[2] ? Number(m[2]) : hi
      const step = m[3] ? Number(m[3]) : 1
      for (let i = a; i <= b; i += step) if (i >= lo && i <= hi) set.add(i)
    }
    return set.size ? set : null
  }
  const sMin = build(min, 0, 59)
  const sHour = build(hour, 0, 23)
  const sDom = build(dom, 1, 31)
  const sMon = build(mon, 1, 12)
  const sDow = build(dow, 0, 7)
  const d = new Date(from + 60000)
  d.setSeconds(0, 0)
  for (let i = 0; i < 800000; i++, d.setMinutes(d.getMinutes() + 1)) {
    const mo = d.getMonth() + 1
    if (sMon && !sMon.has(mo)) continue
    if (sDom && !sDom.has(d.getDate())) continue
    if (sDow && !sDow.has(d.getDay()) && !sDow.has(7 === d.getDay() ? 7 : d.getDay())) continue
    if (sHour && !sHour.has(d.getHours())) continue
    if (sMin && !sMin.has(d.getMinutes())) continue
    return d
  }
  return null
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export default {
  id: 'text',
  title: '文本与编码',
  tags: ['text', 'json', 'yaml', 'csv', 'date', 'encode'],
  summary: '切分排序去重、正则、base64/hex/url、JSON/YAML/CSV/表格互转、日期时长单位换算',
  tools: [
    {
      name: 'text_case',
      desc: '大小写与命名风格转换（upper/lower/title/snake/camel/kebab/pascal/constant）',
      params: { text: { type: 'string', required: true, desc: '输入文本' }, style: { type: 'string', required: true, desc: '目标风格', enum: ['upper', 'lower', 'title', 'snake', 'camel', 'kebab', 'pascal', 'constant', 'spongebob'] } },
      run: async (a) => {
        const words = enc(a.text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
        const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        switch (a.style) {
          case 'upper': return enc(a.text).toUpperCase()
          case 'lower': return enc(a.text).toLowerCase()
          case 'title': return words.map(cap).join(' ')
          case 'snake': return words.map((w) => w.toLowerCase()).join('_')
          case 'constant': return words.map((w) => w.toUpperCase()).join('_')
          case 'kebab': return words.map((w) => w.toLowerCase()).join('-')
          case 'camel': return words.map(cap).join('').replace(/^./, (c) => c.toLowerCase())
          case 'pascal': return words.map(cap).join('')
          default: return enc(a.text).split('').map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join('')
        }
      },
    },
    {
      name: 'text_whitespace',
      desc: '空白规整：去首尾空格/压缩连续空格/去空行/去行尾空格/统一换行',
      params: {
        text: { type: 'string', required: true, desc: '输入文本' },
        trimLines: { type: 'boolean', desc: '去每行首尾空格，默认 true' },
        collapse: { type: 'boolean', desc: '行内连续空格压成一个，默认 false' },
        dropEmpty: { type: 'boolean', desc: '删掉空行，默认 false' },
        eol: { type: 'string', desc: '换行风格 lf|crlf，默认保持', enum: ['lf', 'crlf'] },
      },
      run: async (a) => {
        let out = lines(a.text)
        if (a.trimLines !== false) out = out.map((l) => l.replace(/\s+$/, ''))
        if (a.collapse) out = out.map((l) => l.replace(/[ \t]+/g, ' '))
        if (a.dropEmpty) out = out.filter((l) => l.trim())
        const t = out.join('\n')
        return a.eol === 'crlf' ? t.replace(/\n/g, '\r\n') : t
      },
    },
    {
      name: 'text_regex',
      desc: '正则测试/提取/替换，返回命中分组',
      params: {
        text: { type: 'string', required: true, desc: '被匹配的文本' },
        pattern: { type: 'string', required: true, desc: '正则（JS 语法）' },
        flags: { type: 'string', desc: '标志，默认 g，例如 gi/m' },
        replace: { type: 'string', desc: '给了就替换（支持 $1），否则只提取' },
        limit: { type: 'integer', desc: '最多几条，默认 30' },
      },
      run: async (a) => {
        const re = new RegExp(a.pattern, a.flags || 'g')
        if (a.replace !== undefined) return enc(a.text).replace(re, a.replace)
        const out = []
        const cap = clamp(int(a.limit, 30), 1, 500)
        let m
        while ((m = re.exec(enc(a.text))) && out.length < cap) {
          out.push({ match: m[0], index: m.index, groups: m.slice(1) })
          if (m.index === re.lastIndex) re.lastIndex++
        }
        return out.length ? out : { matched: 0, hint: '没命中，检查正则或加 i 标志' }
      },
    },
    {
      name: 'text_split',
      desc: '按行/空白/字符/分隔符切分，返回带序号的片段',
      params: {
        text: { type: 'string', required: true, desc: '输入文本' },
        by: { type: 'string', desc: 'line|word|char|sep，默认 line', enum: ['line', 'word', 'char', 'sep'] },
        sep: { type: 'string', desc: 'by=sep 时的分隔符' },
        limit: { type: 'integer', desc: '最多几段，默认 200' },
      },
      run: async (a) => {
        let parts
        if (a.by === 'word') parts = enc(a.text).split(/\s+/).filter(Boolean)
        else if (a.by === 'char') parts = Array.from(enc(a.text))
        else if (a.by === 'sep') parts = enc(a.text).split(a.sep === undefined ? ',' : a.sep)
        else parts = lines(a.text)
        const cap = clamp(int(a.limit, 200), 1, 20000)
        return json({ total: parts.length, parts: parts.slice(0, cap).map((p, i) => `${i + 1}|${p}`) })
      },
    },
    {
      name: 'text_sort_uniq',
      desc: '行排序/去重/计数（uniq -c 风格）/反转',
      params: {
        text: { type: 'string', required: true, desc: '多行文本' },
        mode: { type: 'string', desc: 'sort|uniq|count|reverse|shuffle，默认 uniq', enum: ['sort', 'uniq', 'count', 'reverse', 'shuffle'] },
        numeric: { type: 'boolean', desc: '按数字排序' },
        ignoreCase: { type: 'boolean', desc: '忽略大小写' },
        limit: { type: 'integer', desc: '最多几行，默认 300' },
      },
      run: async (a) => {
        let rows = lines(a.text).filter((l) => l !== '')
        const cap = clamp(int(a.limit, 300), 1, 20000)
        if (a.mode === 'reverse') rows = rows.reverse()
        else if (a.mode === 'shuffle') rows = rows.map((v, i) => [Math.random(), v, i]).sort((x, y) => x[0] - y[0]).map((x) => x[1])
        else if (a.mode === 'count') {
          const m = new Map()
          for (const l of rows) {
            const k = a.ignoreCase ? l.toLowerCase() : l
            m.set(k, (m.get(k) || 0) + 1)
          }
          rows = [...m.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${String(v).padStart(6)} ${k}`)
        } else {
          rows = [...new Set(rows)]
          rows.sort((x, y) => (a.numeric ? Number(x) - Number(y) : a.ignoreCase ? x.toLowerCase().localeCompare(y.toLowerCase()) : x.localeCompare(y)))
        }
        return rows.slice(0, cap).join('\n')
      },
    },
    {
      name: 'text_freq',
      desc: '词频/字符频统计，返回 top N',
      params: {
        text: { type: 'string', required: true, desc: '输入文本' },
        by: { type: 'string', desc: 'word|char|line，默认 word', enum: ['word', 'char', 'line'] },
        top: { type: 'integer', desc: '前几名，默认 30' },
        minLen: { type: 'integer', desc: '词最短长度，默认 1' },
      },
      run: async (a) => {
        const items = a.by === 'char' ? Array.from(enc(a.text)) : a.by === 'line' ? lines(a.text).filter((l) => l.trim()) : enc(a.text).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
        const min = int(a.minLen, 1)
        const m = new Map()
        for (const it of items) {
          if (it.length < min) continue
          m.set(it, (m.get(it) || 0) + 1)
        }
        const top = clamp(int(a.top, 30), 1, 2000)
        return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, top).map(([k, v]) => `${String(v).padStart(6)} ${k}`).join('\n') || '没有内容'
      },
    },
    {
      name: 'text_encode',
      desc: 'base64 / hex / url / base32 编解码',
      params: {
        text: { type: 'string', required: true, desc: '输入（编码时是原文，解码时是密文）' },
        codec: { type: 'string', required: true, desc: 'base64|hex|url|base32', enum: ['base64', 'hex', 'url', 'base32'] },
        op: { type: 'string', required: true, desc: 'encode|decode', enum: ['encode', 'decode'] },
      },
      run: async (a) => {
        const t = enc(a.text)
        if (a.codec === 'base64') return a.op === 'encode' ? Buffer.from(t, 'utf8').toString('base64') : Buffer.from(t, 'base64').toString('utf8')
        if (a.codec === 'hex') return a.op === 'encode' ? Buffer.from(t, 'utf8').toString('hex') : Buffer.from(t, 'hex').toString('utf8')
        if (a.codec === 'url') return a.op === 'encode' ? encodeURIComponent(t) : decodeURIComponent(t)
        if (a.op === 'encode') {
          let bits = ''
          for (const ch of Buffer.from(t, 'utf8')) bits += ch.toString(2).padStart(8, '0')
          bits += '0'.repeat((5 - (bits.length % 5)) % 5)
          let out = ''
          for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]
          return out
        }
        let bits = ''
        for (const ch of t.toUpperCase()) {
          const idx = B32.indexOf(ch)
          if (idx < 0) continue
          bits += idx.toString(2).padStart(5, '0')
        }
        const bytes = []
        for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
        return Buffer.from(bytes).toString('utf8')
      },
    },
    {
      name: 'text_json',
      desc: 'JSON 美化/压缩/校验/按路径取值/按路径写值',
      params: {
        text: { type: 'string', required: true, desc: 'JSON 文本' },
        op: { type: 'string', required: true, desc: 'pretty|minify|validate|get|set', enum: ['pretty', 'minify', 'validate', 'get', 'set'] },
        at: { type: 'string', desc: 'get/set 的路径，例如 a.b.0' },
        value: { type: 'string', desc: 'set 的值（JSON 文本）' },
      },
      run: async (a) => {
        let obj
        try {
          obj = JSON.parse(a.text)
        } catch (e) {
          return json({ ok: false, code: 'invalid_json', message: String(e && e.message).slice(0, 200) })
        }
        if (a.op === 'validate') return json({ ok: true, type: Array.isArray(obj) ? 'array' : typeof obj, keys: obj && typeof obj === 'object' ? Object.keys(obj).slice(0, 50) : null })
        if (a.op === 'minify') return JSON.stringify(obj)
        if (a.op === 'get') return json({ value: a.at === undefined ? obj : getPath(obj, a.at) })
        if (a.op === 'set') {
          let v
          try {
            v = JSON.parse(a.value)
          } catch (e) {
            return json({ ok: false, message: 'value 不是合法 JSON' })
          }
          setPath(obj, a.at, v)
          return JSON.stringify(obj, null, 2)
        }
        return JSON.stringify(obj, null, 2)
      },
    },
    {
      name: 'text_json_diff',
      desc: '比较两份 JSON，列出新增/删除/改动的路径',
      params: {
        left: { type: 'string', required: true, desc: '左边 JSON 文本' },
        right: { type: 'string', required: true, desc: '右边 JSON 文本' },
        limit: { type: 'integer', desc: '最多几条差异，默认 60' },
      },
      run: async (a) => {
        let L
        let R
        try {
          L = JSON.parse(a.left)
          R = JSON.parse(a.right)
        } catch (e) {
          return json({ ok: false, message: `有一边不是合法 JSON: ${String(e && e.message).slice(0, 160)}` })
        }
        const out = []
        const cap = clamp(int(a.limit, 60), 1, 2000)
        const walk = (l, r, p) => {
          if (out.length >= cap) return
          if (l === r) return
          const tl = l === null ? 'null' : Array.isArray(l) ? 'array' : typeof l
          const tr = r === null ? 'null' : Array.isArray(r) ? 'array' : typeof r
          if (tl !== tr || tl !== 'object' && tl !== 'array') {
            out.push({ path: p, change: 'changed', left: l, right: r })
            return
          }
          const keys = new Set([...Object.keys(l), ...Object.keys(r)])
          for (const k of keys) {
            if (!(k in r)) out.push({ path: `${p}.${k}`, change: 'removed', left: l[k] })
            else if (!(k in l)) out.push({ path: `${p}.${k}`, change: 'added', right: r[k] })
            else walk(l[k], r[k], `${p}.${k}`)
            if (out.length >= cap) return
          }
        }
        walk(L, R, '$')
        return json({ differences: out.length, capped: out.length >= cap, changes: out })
      },
    },
    {
      name: 'text_json_merge',
      desc: '深合并多份 JSON（数组可选拼接或覆盖）',
      params: {
        base: { type: 'string', required: true, desc: '基础 JSON' },
        patch: { type: 'array', required: true, desc: '依次叠加的 JSON 文本', items: { type: 'string', desc: '一份 JSON' } },
        arrayMode: { type: 'string', desc: 'replace|concat，默认 replace', enum: ['replace', 'concat'] },
      },
      run: async (a) => {
        const merge = (t, s) => {
          if (Array.isArray(t) && Array.isArray(s)) return a.arrayMode === 'concat' ? [...t, ...s] : s
          if (t && s && typeof t === 'object' && typeof s === 'object' && !Array.isArray(t) && !Array.isArray(s)) {
            const out = { ...t }
            for (const k of Object.keys(s)) out[k] = k in t ? merge(t[k], s[k]) : s[k]
            return out
          }
          return s
        }
        let base
        try {
          base = JSON.parse(a.base)
        } catch (e) {
          return json({ ok: false, message: 'base 不是合法 JSON' })
        }
        let n = 0
        for (const raw of a.patch) {
          try {
            base = merge(base, JSON.parse(raw))
            n++
          } catch (e) {
            return json({ ok: false, message: `第 ${n + 1} 份 patch 不是合法 JSON`, applied: n })
          }
        }
        return JSON.stringify(base, null, 2)
      },
    },
    {
      name: 'text_yaml',
      desc: 'YAML 与 JSON 互转（标量/数组/一层嵌套够用）',
      params: {
        text: { type: 'string', required: true, desc: 'YAML 或 JSON 文本' },
        op: { type: 'string', required: true, desc: 'toJSON|toYAML', enum: ['toJSON', 'toYAML'] },
      },
      run: async (a) => {
        const { parseYamlLite, dumpYamlLite } = await import('../util.js')
        if (a.op === 'toJSON') {
          const obj = parseYamlLite(a.text)
          return json(obj)
        }
        let obj
        try {
          obj = JSON.parse(a.text)
        } catch (e) {
          return json({ ok: false, message: 'toYAML 需要输入合法 JSON' })
        }
        return dumpYamlLite(obj)
      },
    },
    {
      name: 'text_csv',
      desc: 'CSV/TSV 与 JSON 互转（自动识别分隔符，支持引号）',
      params: {
        text: { type: 'string', required: true, desc: 'CSV 文本或 JSON 数组文本' },
        op: { type: 'string', required: true, desc: 'toJSON|toCSV', enum: ['toJSON', 'toCSV'] },
        delimiter: { type: 'string', desc: '分隔符，默认自动' },
        limit: { type: 'integer', desc: 'toJSON 时最多几行，默认 200' },
      },
      run: async (a) => {
        if (a.op === 'toJSON') {
          const rows = parseCsv(enc(a.text), a.delimiter)
          if (!rows.length) return json({ rows: [], header: [] })
          const header = rows[0].map((h) => h.trim())
          const cap = clamp(int(a.limit, 200), 1, 20000)
          const objs = rows.slice(1).map((cells) => {
            const o = {}
            header.forEach((h, i) => {
              o[h] = cells[i] === undefined ? '' : cells[i]
            })
            return o
          })
          return json({ header, total: objs.length, rows: objs.slice(0, cap) })
        }
        let arr
        try {
          arr = JSON.parse(a.text)
        } catch (e) {
          return json({ ok: false, message: 'toCSV 需要 JSON 数组文本' })
        }
        if (!Array.isArray(arr) || !arr.length) return ''
        const cols = [...new Set(arr.flatMap((o) => Object.keys(o || {})))]
        const esc = (v) => {
          const s = v === null || v === undefined ? '' : String(v)
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        }
        return [cols.join(','), ...arr.map((o) => cols.map((c) => esc(o ? o[c] : '')).join(','))].join('\n')
      },
    },
    {
      name: 'text_md_table',
      desc: 'Markdown 表格与 JSON 互转',
      params: {
        text: { type: 'string', required: true, desc: '表格文本或 JSON 数组' },
        op: { type: 'string', required: true, desc: 'toJSON|toMD', enum: ['toJSON', 'toMD'] },
      },
      run: async (a) => {
        if (a.op === 'toJSON') {
          const rows = lines(a.text).filter((l) => l.trim().startsWith('|'))
          if (rows.length < 2) return json({ ok: false, message: '没找到 Markdown 表格（要 | 开头的行）' })
          const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
          const header = cells(rows[0])
          const objs = rows.slice(2).filter((l) => !/^\s*\|?[\s:-]+\|?\s*$/.test(l)).map((l) => {
            const c = cells(l)
            const o = {}
            header.forEach((h, i) => {
              o[h] = c[i] === undefined ? '' : c[i]
            })
            return o
          })
          return json({ header, total: objs.length, rows: objs })
        }
        let arr
        try {
          arr = JSON.parse(a.text)
        } catch (e) {
          return json({ ok: false, message: 'toMD 需要 JSON 数组文本' })
        }
        if (!Array.isArray(arr) || !arr.length) return ''
        const cols = [...new Set(arr.flatMap((o) => Object.keys(o || {})))]
        const row = (cells) => `| ${cells.join(' | ')} |`
        return [row(cols), row(cols.map(() => '---')), ...arr.map((o) => row(cols.map((c) => (o && o[c] !== undefined ? String(o[c]).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ') : ''))))].join('\n')
      },
    },
    {
      name: 'text_slugify',
      desc: '转 slug / 文件名安全串（可保留中文）',
      params: {
        text: { type: 'string', required: true, desc: '输入' },
        sep: { type: 'string', desc: '分隔符，默认 -' },
        keepCjk: { type: 'boolean', desc: '保留中日韩字符，默认 false' },
        lower: { type: 'boolean', desc: '转小写，默认 true' },
      },
      run: async (a) => {
        let s = enc(a.text).normalize('NFKC')
        s = a.keepCjk ? s.replace(/[^\p{L}\p{N}\s-]/gu, ' ') : s.replace(/[^\x00-\x7F]+/g, ' ').replace(/[^a-zA-Z0-9\s-]/g, ' ')
        s = s.trim().split(/\s+/).join(a.sep || '-')
        return a.lower === false ? s : s.toLowerCase()
      },
    },
    {
      name: 'text_diff',
      desc: '两段文本行级差异（只左/只右/共同行数）',
      params: {
        left: { type: 'string', required: true, desc: '左边文本' },
        right: { type: 'string', required: true, desc: '右边文本' },
        limit: { type: 'integer', desc: '每种最多列几行，默认 40' },
      },
      run: async (a) => {
        const L = lines(a.left)
        const R = lines(a.right)
        const setL = new Set(L)
        const setR = new Set(R)
        const cap = clamp(int(a.limit, 40), 1, 2000)
        const onlyL = L.map((l, i) => [i + 1, l]).filter(([, l]) => !setR.has(l))
        const onlyR = R.map((l, i) => [i + 1, l]).filter(([, l]) => !setL.has(l))
        return json({
          leftLines: L.length,
          rightLines: R.length,
          onlyLeft: onlyL.length,
          onlyRight: onlyR.length,
          sample: [...onlyL.slice(0, cap).map(([n, l]) => `- ${n}: ${l.slice(0, 160)}`), ...onlyR.slice(0, cap).map(([n, l]) => `+ ${n}: ${l.slice(0, 160)}`)],
        })
      },
    },
    {
      name: 'text_similar',
      desc: '字符串相似度（编辑距离 + 归一化比例）',
      params: { left: { type: 'string', required: true, desc: '串 A' }, right: { type: 'string', required: true, desc: '串 B' } },
      run: async (a) => {
        const L = enc(a.left)
        const R = enc(a.right)
        const d = levenshtein(L, R)
        const max = Math.max(L.length, R.length) || 1
        return { distance: d, similarity: Number((1 - d / max).toFixed(4)), leftLength: L.length, rightLength: R.length }
      },
    },
    {
      name: 'text_stats',
      desc: '字符数/行数/词数/字节数/近似 token 统计',
      params: { text: { type: 'string', required: true, desc: '输入文本' }, lang: { type: 'string', desc: 'zh|en|auto，影响 token 估算', enum: ['zh', 'en', 'auto'] } },
      run: async (a) => {
        const t = enc(a.text)
        const bytes = Buffer.byteLength(t)
        const cjk = (t.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length
        const lang = a.lang === 'auto' || !a.lang ? (cjk > t.length * 0.1 ? 'zh' : 'en') : a.lang
        const tokens = lang === 'zh' ? Math.ceil(cjk + (t.length - cjk) / 4) : Math.ceil(bytes / 4)
        return { chars: t.length, lines: lines(t).length, nonEmptyLines: lines(t).filter((l) => l.trim()).length, words: t.split(/\s+/).filter(Boolean).length, bytes, cjkChars: cjk, detectedLang: lang, approxTokens: tokens }
      },
    },
    {
      name: 'text_sample',
      desc: '随机取样 / 洗牌 / 生成随机数与随机串',
      params: {
        items: { type: 'array', required: true, desc: '候选项（JSON 文本数组或纯文本，一行一个）', items: { type: 'string', desc: '一项' } },
        mode: { type: 'string', desc: 'sample|shuffle|randomInt，默认 sample', enum: ['sample', 'shuffle', 'randomInt'] },
        count: { type: 'integer', desc: '取几个，默认 1' },
        min: { type: 'integer', desc: 'randomInt 下界' },
        max: { type: 'integer', desc: 'randomInt 上界' },
      },
      run: async (a) => {
        const n = clamp(int(a.count, 1), 1, 10000)
        if (a.mode === 'randomInt') {
          const lo = int(a.min, 0)
          const hi = int(a.max, 100)
          return json(Array.from({ length: n }, () => lo + crypto.randomInt(Math.max(1, hi - lo + 1))))
        }
        const arr = a.items.map((x) => enc(x))
        if (a.mode === 'shuffle') return arr.map((v, i) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]).join('\n')
        const pool = [...arr]
        const out = []
        for (let i = 0; i < n && pool.length; i++) out.push(pool.splice(crypto.randomInt(pool.length), 1)[0])
        return out.join('\n')
      },
    },
    {
      name: 'text_template',
      desc: '模板渲染：{{key}} 替换成变量值',
      params: {
        template: { type: 'string', required: true, desc: '模板文本，占位符写 {{key}}' },
        vars: { type: 'object', required: true, desc: '变量表', props: {} },
        style: { type: 'string', desc: 'mustache|erb|fstring，默认 mustache', enum: ['mustache', 'erb', 'fstring'] },
      },
      run: async (a) => {
        const vars = a.vars || {}
        const re = a.style === 'erb' ? /<%=\s*([\w.]+)\s*%>/g : a.style === 'fstring' ? /\{\s*([\w.]+)\s*\}/g : /\{\{\s*([\w.]+)\s*\}\}/g
        const missing = []
        const out = enc(a.template).replace(re, (_m, key) => {
          const v = getPath(vars, key)
          if (v === undefined) missing.push(key)
          return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
        })
        return missing.length ? `${out}\n# 缺变量: ${missing.join(', ')}` : out
      },
    },
    {
      name: 'text_hash',
      desc: '对文本算 sha256/sha1/md5/hmac',
      params: {
        text: { type: 'string', required: true, desc: '输入文本' },
        algo: { type: 'string', desc: 'sha256|sha1|md5|blake2s，默认 sha256', enum: ['sha256', 'sha1', 'md5', 'blake2s'] },
        key: { type: 'string', desc: '给了就算 HMAC' },
      },
      run: async (a) => {
        const algo = a.algo || 'sha256'
        const out = a.key ? crypto.createHmac(algo, a.key).update(enc(a.text)).digest('hex') : crypto.createHash(algo).update(enc(a.text)).digest('hex')
        return { algo, hmac: !!a.key, digest: out }
      },
    },
    {
      name: 'text_compress',
      desc: 'zlib/gzip/deflate 压缩解压，结果 base64',
      params: {
        text: { type: 'string', required: true, desc: '压缩时是原文，解压时是 base64' },
        op: { type: 'string', required: true, desc: 'compress|decompress', enum: ['compress', 'decompress'] },
        algo: { type: 'string', desc: 'gzip|deflate|brotli，默认 gzip', enum: ['gzip', 'deflate', 'brotli'] },
      },
      run: async (a) => {
        const algo = a.algo || 'gzip'
        const pick = algo === 'deflate' ? zlib.deflateSync : algo === 'brotli' ? zlib.brotliCompressSync : zlib.gzipSync
        const unpick = algo === 'deflate' ? zlib.inflateSync : algo === 'brotli' ? zlib.brotliDecompressSync : zlib.gunzipSync
        if (a.op === 'compress') {
          const raw = Buffer.from(enc(a.text), 'utf8')
          const z = pick(raw)
          return json({ rawBytes: raw.length, compressedBytes: z.length, ratio: Number((z.length / raw.length).toFixed(4)), base64: z.toString('base64') })
        }
        const z = unpick(Buffer.from(enc(a.text), 'base64'))
        return z.toString('utf8')
      },
    },
    {
      name: 'text_number',
      desc: '数字格式化：千分位/科学计数/保留位/进制转换',
      params: {
        value: { type: 'string', required: true, desc: '数字文本' },
        op: { type: 'string', desc: 'group|sci|fixed|radix|percent，默认 group', enum: ['group', 'sci', 'fixed', 'radix', 'percent'] },
        digits: { type: 'integer', desc: '小数位，默认 2' },
        radix: { type: 'integer', desc: 'radix 目标进制 2-36，默认 16' },
      },
      run: async (a) => {
        const n = Number(String(a.value).replace(/,/g, ''))
        if (!Number.isFinite(n)) return json({ ok: false, message: `不是数字: ${a.value}` })
        const d = clamp(int(a.digits, 2), 0, 20)
        if (a.op === 'sci') return n.toExponential(d)
        if (a.op === 'fixed') return n.toFixed(d)
        if (a.op === 'percent') return `${(n * 100).toFixed(d)}%`
        if (a.op === 'radix') {
          const r = clamp(int(a.radix, 16), 2, 36)
          return json({ decimal: n, radix: r, value: Number.isInteger(n) ? n.toString(r) : n.toString(r) })
        }
        return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
      },
    },
    {
      name: 'text_unit',
      desc: '单位换算：字节/时间/温度/长度/速度/频率',
      params: {
        value: { type: 'string', required: true, desc: '数值' },
        from: { type: 'string', required: true, desc: '源单位，例如 GB / ms / C / km / GHz' },
        to: { type: 'string', required: true, desc: '目标单位，例如 MiB / s / F / mile / MHz' },
      },
      run: async (a) => {
        const n = Number(String(a.value).replace(/,/g, ''))
        if (!Number.isFinite(n)) return json({ ok: false, message: `不是数字: ${a.value}` })
        const f = String(a.from).trim()
        const t = String(a.to).trim()
        const bytes = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5 }
        const time = { ms: 1, s: 1e3, sec: 1e3, min: 60000, h: 3600000, d: 86400000, w: 604800000 }
        const len = { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mile: 1609.344, li: 500 }
        const speed = { 'm/s': 1, kmh: 0.277778, mph: 0.44704, kn: 0.514444 }
        const freq = { hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9, thz: 1e12 }
        const table = (tbl) => {
          if (!(f.toLowerCase() in tbl) || !(t.toLowerCase() in tbl)) return null
          return (n * tbl[f.toLowerCase()] * 1) / tbl[t.toLowerCase()]
        }
        let out
        if ((f.toLowerCase() === 'c' || f.toLowerCase() === 'f' || f.toLowerCase() === 'k') && (t.toLowerCase() === 'c' || t.toLowerCase() === 'f' || t.toLowerCase() === 'k')) {
          const kelvin = f.toLowerCase() === 'c' ? n + 273.15 : f.toLowerCase() === 'f' ? (n - 32) / 1.8 + 273.15 : n
          out = t.toLowerCase() === 'c' ? kelvin - 273.15 : t.toLowerCase() === 'f' ? (kelvin - 273.15) * 1.8 + 32 : kelvin
        } else out = table(bytes) ?? table(time) ?? table(len) ?? table(speed) ?? table(freq)
        if (out === null || out === undefined) return json({ ok: false, message: `不认识的单位对 ${f} → ${t}`, supported: { 字节: Object.keys(bytes), 时间: Object.keys(time), 长度: Object.keys(len), 速度: Object.keys(speed), 频率: Object.keys(freq), 温度: ['C', 'F', 'K'] } })
        return json({ input: `${n} ${f}`, result: Number(out.toPrecision(10)), unit: t })
      },
    },
    {
      name: 'text_color',
      desc: '颜色互转 hex/rgb/hsl 与对比度',
      params: {
        color: { type: 'string', required: true, desc: '颜色，例如 #ff0000 / rgb(255,0,0) / hsl(0,100%,50%)' },
        to: { type: 'string', desc: 'hex|rgb|hsl，默认 hex', enum: ['hex', 'rgb', 'hsl'] },
        against: { type: 'string', desc: '另一个颜色，给就算对比度' },
      },
      run: async (a) => {
        const parse = (s) => {
          const str = String(s).trim().toLowerCase()
          let m = str.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/)
          if (m) {
            let h = m[1]
            if (h.length === 3) h = h.split('').map((c) => c + c).join('')
            return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
          }
          m = str.match(/^rgba?\(([^)]+)\)$/)
          if (m) return m[1].split(',').slice(0, 3).map((x) => clamp(Math.round(Number(x)), 0, 255))
          m = str.match(/^hsla?\(([^)]+)\)$/)
          if (m) {
            const [hh, ss, ll] = m[1].split(',').map((x) => parseFloat(x))
            const s2 = ss / 100
            const l2 = ll / 100
            const c = (1 - Math.abs(2 * l2 - 1)) * s2
            const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
            const mm = l2 - c / 2
            const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hh / 60) % 6]
            return seg.map((v) => Math.round((v + mm) * 255))
          }
          return null
        }
        const rgb = parse(a.color)
        if (!rgb) return json({ ok: false, message: `认不出这个颜色: ${a.color}` })
        const [r, g, b] = rgb
        const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
        const to = a.to || 'hex'
        let out = hex
        if (to === 'rgb') out = `rgb(${r}, ${g}, ${b})`
        if (to === 'hsl') {
          const rn = r / 255
          const gn = g / 255
          const bn = b / 255
          const mx = Math.max(rn, gn, bn)
          const mn = Math.min(rn, gn, bn)
          const l = (mx + mn) / 2
          let h = 0
          let s = 0
          if (mx !== mn) {
            const d = mx - mn
            s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
            h = mx === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0)) : mx === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4
            h *= 60
          }
          out = `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`
        }
        const lum = ([rr, gg, bb]) => {
          const f = (v) => {
            const s2 = v / 255
            return s2 <= 0.03928 ? s2 / 12.92 : ((s2 + 0.055) / 1.055) ** 2.4
          }
          return 0.2126 * f(rr) + 0.7152 * f(gg) + 0.0722 * f(bb)
        }
        const result = { input: a.color, hex, rgb: `rgb(${r}, ${g}, ${b})`, output: out }
        if (a.against) {
          const other = parse(a.against)
          if (other) {
            const l1 = lum(rgb)
            const l2 = lum(other)
            result.contrast = Number(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2))
            result.wcagAA = result.contrast >= 4.5
          }
        }
        return result
      },
    },
    {
      name: 'text_id',
      desc: '生成 uuid / 短码 / ULID / 随机串',
      params: {
        kind: { type: 'string', desc: 'uuid|ulid|short|random，默认 uuid', enum: ['uuid', 'ulid', 'short', 'random'] },
        count: { type: 'integer', desc: '生成几个，默认 1' },
        length: { type: 'integer', desc: 'random 长度，默认 16' },
      },
      run: async (a) => {
        const n = clamp(int(a.count, 1), 1, 500)
        const kind = a.kind || 'uuid'
        const out = []
        for (let i = 0; i < n; i++) {
          if (kind === 'uuid') out.push(crypto.randomUUID())
          else if (kind === 'short') out.push(`${Date.now().toString(36)}${randomHex(4)}`)
          else if (kind === 'ulid') {
            const t = Date.now()
            let tstr = ''
            let v = t
            const alpha = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
            for (let k = 0; k < 10; k++) {
              tstr = alpha[v % 32] + tstr
              v = Math.floor(v / 32)
            }
            out.push(tstr + randomHex(16).toUpperCase().replace(/[ILUO]/g, 'X').slice(0, 16))
          } else out.push(randomHex(clamp(int(a.length, 16), 2, 128)))
        }
        return out.join('\n')
      },
    },
    {
      name: 'text_date',
      desc: '日期解析与格式化，输出各时区表示',
      params: {
        value: { type: 'string', required: true, desc: '日期文本或时间戳（秒/毫秒）' },
        pattern: { type: 'string', desc: '格式，默认 YYYY-MM-DD HH:mm:ss' },
        tzOffsetMinutes: { type: 'integer', desc: '时区偏移分钟，默认本地（如 480=东八区）' },
      },
      run: async (a) => {
        let d
        const raw = String(a.value).trim()
        if (/^-?\d{10}$/.test(raw)) d = new Date(Number(raw) * 1000)
        else if (/^-?\d{13}$/.test(raw)) d = new Date(Number(raw))
        else d = new Date(raw)
        if (Number.isNaN(d.getTime())) return json({ ok: false, message: `解析不出日期: ${a.value}` })
        if (a.tzOffsetMinutes !== undefined) {
          const off = Number(a.tzOffsetMinutes)
          d = new Date(d.getTime() + (off - -d.getTimezoneOffset()) * 60000)
        }
        return { iso: d.toISOString(), local: fmtDate(d, a.pattern), timestampMs: d.getTime(), timestampS: Math.floor(d.getTime() / 1000), weekday: ['日', '一', '二', '三', '四', '五', '六'][d.getDay()], utc: fmtDate(new Date(d.getTime() + d.getTimezoneOffset() * 60000), a.pattern) }
      },
    },
    {
      name: 'text_date_math',
      desc: '日期加减与差值（支持 1d/2h/30m 这种时长）',
      params: {
        value: { type: 'string', required: true, desc: '起始日期（留空=现在）' },
        op: { type: 'string', desc: 'add|sub|diff，默认 add', enum: ['add', 'sub', 'diff'] },
        amount: { type: 'string', desc: '时长，例如 90m、2d、1h30m' },
        other: { type: 'string', desc: 'diff 时的另一个日期' },
        pattern: { type: 'string', desc: '输出格式' },
      },
      run: async (a) => {
        const base = a.value ? new Date(/^\d{13}$/.test(String(a.value)) ? Number(a.value) : String(a.value)) : new Date()
        if (Number.isNaN(base.getTime())) return json({ ok: false, message: `解析不出日期: ${a.value}` })
        if (a.op === 'diff') {
          const other = a.other ? new Date(/^\d{13}$/.test(String(a.other)) ? Number(a.other) : String(a.other)) : new Date()
          if (Number.isNaN(other.getTime())) return json({ ok: false, message: `解析不出日期: ${a.other}` })
          const ms = other.getTime() - base.getTime()
          return { from: base.toISOString(), to: other.toISOString(), ms, seconds: Math.round(ms / 1000), minutes: Number((ms / 60000).toFixed(2)), hours: Number((ms / 3600000).toFixed(3)), days: Number((ms / 86400000).toFixed(3)) }
        }
        const ms = parseDuration(a.amount)
        if (!Number.isFinite(ms)) return json({ ok: false, message: `时长看不懂: ${a.amount}（用 90m / 2h / 1d 这种写法）` })
        const out = a.op === 'sub' ? new Date(base.getTime() - ms) : new Date(base.getTime() + ms)
        return { base: base.toISOString(), amount: a.amount, ms, result: fmtDate(out, a.pattern), iso: out.toISOString() }
      },
    },
    {
      name: 'text_duration',
      desc: '时长文本互转（1h30m ↔ 秒/毫秒/人类可读）',
      params: {
        value: { type: 'string', required: true, desc: '时长文本（1h30m）或数字（默认按秒）' },
        unit: { type: 'string', desc: '数字时的单位 s|ms|m|h，默认 s', enum: ['s', 'ms', 'm', 'h'] },
        to: { type: 'string', desc: 'ms|s|human|clock，默认 human', enum: ['ms', 's', 'human', 'clock'] },
      },
      run: async (a) => {
        let ms
        const raw = String(a.value).trim()
        if (/^\d+(\.\d+)?$/.test(raw)) {
          const u = a.unit || 's'
          ms = Number(raw) * (u === 'ms' ? 1 : u === 'm' ? 60000 : u === 'h' ? 3600000 : 1000)
        } else ms = parseDuration(raw)
        if (!Number.isFinite(ms)) return json({ ok: false, message: `看不懂时长: ${a.value}` })
        const to = a.to || 'human'
        if (to === 'ms') return ms
        if (to === 's') return Number((ms / 1000).toFixed(3))
        const d = Math.floor(ms / 86400000)
        const h = Math.floor((ms % 86400000) / 3600000)
        const m = Math.floor((ms % 3600000) / 60000)
        const s = Math.floor((ms % 60000) / 1000)
        const msr = ms % 1000
        if (to === 'clock') return `${d ? `${d}:` : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        return [d && `${d}天`, h && `${h}小时`, m && `${m}分`, s && `${s}秒`, msr && `${msr}毫秒`].filter(Boolean).join('') || '0秒'
      },
    },
    {
      name: 'text_cron',
      desc: '解析 cron 表达式，算接下来 N 次执行时间',
      params: {
        expression: { type: 'string', required: true, desc: '五段 cron，例如 */15 9-18 * * 1-5' },
        count: { type: 'integer', desc: '算几次，默认 5' },
        from: { type: 'string', desc: '起点时间，默认现在' },
      },
      run: async (a) => {
        const n = clamp(int(a.count, 5), 1, 50)
        let from = Date.now()
        if (a.from) {
          const d = new Date(a.from)
          if (!Number.isNaN(d.getTime())) from = d.getTime()
        }
        const out = []
        let cursor = from
        for (let i = 0; i < n; i++) {
          const d = nextCron(a.expression, cursor)
          if (!d) break
          out.push(d.toISOString())
          cursor = d.getTime()
        }
        if (!out.length) return json({ ok: false, message: '算不出下次执行时间，检查表达式（要 5 段：分 时 日 月 周）' })
        return json({ expression: a.expression, next: out })
      },
    },
    {
      name: 'text_tz',
      desc: '时区换算（偏移分钟表 + UTC/本地/指定偏移三视图）',
      params: {
        value: { type: 'string', required: true, desc: '时间文本或时间戳' },
        offsets: { type: 'array', desc: '要看的时区偏移分钟，例如 ["0","480","-480"]', items: { type: 'string', desc: '偏移分钟' } },
        pattern: { type: 'string', desc: '格式，默认 YYYY-MM-DD HH:mm:ss' },
      },
      run: async (a) => {
        const raw = String(a.value).trim()
        const d = new Date(/^\d{13}$/.test(raw) ? Number(raw) : /^\d{10}$/.test(raw) ? Number(raw) * 1000 : raw)
        if (Number.isNaN(d.getTime())) return json({ ok: false, message: `解析不出时间: ${a.value}` })
        const offs = Array.isArray(a.offsets) && a.offsets.length ? a.offsets.map(Number).filter(Number.isFinite) : [0, 480, -480, 540]
        const views = {}
        for (const off of offs) {
          const shifted = new Date(d.getTime() + (off - -d.getTimezoneOffset()) * 60000)
          views[`UTC${off >= 0 ? '+' : ''}${off / 60}`] = fmtDate(shifted, a.pattern)
        }
        return { iso: d.toISOString(), timestampMs: d.getTime(), views }
      },
    },
    {
      name: 'text_semver',
      desc: '版本号比较与合法性检查（semver 子集）',
      params: {
        left: { type: 'string', required: true, desc: '版本 A，例如 1.2.3' },
        right: { type: 'string', desc: '版本 B；不给只校验 A' },
        op: { type: 'string', desc: 'compare|satisfies，默认 compare', enum: ['compare', 'satisfies'] },
        range: { type: 'string', desc: 'satisfies 的范围，例如 >=1.2.0 <2.0.0' },
      },
      run: async (a) => {
        const parse = (s) => {
          const m = String(s).trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/)
          return m ? { major: +m[1], minor: +m[2], patch: +m[3], tag: m[4] || '' } : null
        }
        const L = parse(a.left)
        if (!L) return json({ ok: false, message: `${a.left} 不是 x.y.z 版本` })
        if (a.op === 'satisfies') {
          const R = parse(a.right)
          if (!R) return json({ ok: false, message: 'satisfies 需要 right 作为版本号' })
          const cmp = (x, y) => x.major - y.major || x.minor - y.minor || x.patch - y.patch
          const ok = String(a.range || '*').split(/\s*,?\s+/).filter(Boolean).every((clause) => {
            const m = clause.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/)
            if (!m) return false
            const target = parse(m[2])
            if (!target) return false
            const c = cmp(R, target)
            switch (m[1]) {
              case '>=': return c >= 0
              case '<=': return c <= 0
              case '>': return c > 0
              case '<': return c < 0
              case '^': return R.major === target.major && c >= 0
              case '~': return R.major === target.major && R.minor === target.minor && c >= 0
              default: return c === 0
            }
          })
          return { version: a.right, range: a.range, satisfies: ok }
        }
        if (!a.right) return { version: a.left, valid: true, ...L }
        const R = parse(a.right)
        if (!R) return json({ ok: false, message: `${a.right} 不是 x.y.z 版本` })
        const cmp = L.major - R.major || L.minor - R.minor || L.patch - R.patch
        return { left: a.left, right: a.right, compare: cmp > 0 ? 1 : cmp < 0 ? -1 : 0, newer: cmp > 0 ? a.left : cmp < 0 ? a.right : '相同' }
      },
    },
    {
      name: 'text_url',
      desc: 'URL 拆成各段（协议/主机/端口/路径/查询/哈希）',
      params: { url: { type: 'string', required: true, desc: '完整 URL' }, base: { type: 'string', desc: '相对路径时的基准 URL' } },
      run: async (a) => {
        try {
          const u = new URL(a.url, a.base || undefined)
          return {
            href: u.href,
            protocol: u.protocol,
            host: u.host,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? '443' : '80'),
            path: u.pathname,
            query: Object.fromEntries(u.searchParams.entries()),
            hash: u.hash.replace(/^#/, ''),
            origin: u.origin,
          }
        } catch (e) {
          return json({ ok: false, message: `URL 解析失败: ${String(e && e.message).slice(0, 160)}` })
        }
      },
    },
    {
      name: 'text_jwt',
      desc: 'JWT 解码（不验签），看头部与载荷字段',
      params: { token: { type: 'string', required: true, desc: 'JWT 文本' }, b64url: { type: 'boolean', desc: '按 base64url 解，默认 true' } },
      run: async (a) => {
        const parts = String(a.token).trim().split('.')
        if (parts.length < 2) return json({ ok: false, message: '不是 JWT（要 header.payload.signature 三段）' })
        const dec = (seg) => {
          const s = seg.replace(/-/g, '+').replace(/_/g, '/')
          return Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64').toString('utf8')
        }
        try {
          const header = JSON.parse(dec(parts[0]))
          const payload = JSON.parse(dec(parts[1]))
          const now = Math.floor(Date.now() / 1000)
          return { header, payload, signatureLength: parts[2] ? parts[2].length : 0, expired: payload.exp ? payload.exp < now : null, expiresIn: payload.exp ? payload.exp - now : null, notYetValid: payload.nbf ? payload.nbf > now : null }
        } catch (e) {
          return json({ ok: false, message: `解码失败: ${String(e && e.message).slice(0, 160)}` })
        }
      },
    },
    {
      name: 'text_html',
      desc: 'HTML 去标签转纯文本 / 转义 / 反转义 / 抽属性',
      params: {
        html: { type: 'string', required: true, desc: 'HTML 或文本' },
        op: { type: 'string', desc: 'strip|escape|unescape|links|meta，默认 strip', enum: ['strip', 'escape', 'unescape', 'links', 'meta'] },
      },
      run: async (a) => {
        const src = enc(a.html)
        const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d))).replace(/&nbsp;/g, ' ')
        const op = a.op || 'strip'
        if (op === 'escape') return src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        if (op === 'unescape') return unescape(src)
        if (op === 'links') {
          const out = []
          const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
          let m
          while ((m = re.exec(src))) out.push({ href: unescape(m[1]), text: unescape(m[2].replace(/<[^>]+>/g, '')).trim() })
          return json({ count: out.length, links: out.slice(0, 200) })
        }
        if (op === 'meta') {
          const grab = (re) => {
            const m = src.match(re)
            return m ? unescape(m[1]) : null
          }
          return {
            title: grab(/<title[^>]*>([\s\S]*?)<\/title>/i),
            description: grab(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || grab(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i),
            charset: grab(/<meta[^>]+charset=["']?([\w-]+)/i),
            canonical: grab(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i),
            og: Object.fromEntries([...src.matchAll(/<meta[^>]+property=["']og:([\w:]+)["'][^>]+content=["']([^"']*)["']/gi)].slice(0, 20).map((m) => [m[1], unescape(m[2])])),
          }
        }
        const text = unescape(src
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<!--[\s\S]*?-->/g, ' ')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .join('\n'))
        return text
      },
    },
    {
      name: 'text_lines_between',
      desc: '取两个标记之间的文本（含/不含标记）',
      params: {
        text: { type: 'string', required: true, desc: '源文本' },
        start: { type: 'string', required: true, desc: '起始标记（子串或正则）' },
        end: { type: 'string', required: true, desc: '结束标记' },
        regex: { type: 'boolean', desc: '标记当正则，默认 false' },
        includeMarks: { type: 'boolean', desc: '结果含标记，默认 false' },
        all: { type: 'boolean', desc: '取所有区间，默认只取第一段' },
      },
      run: async (a) => {
        const src = enc(a.text)
        const segs = []
        if (a.regex) {
          const re = new RegExp(`${a.start}([\\s\\S]*?)${a.end}`, 'g')
          let m
          while ((m = re.exec(src))) {
            segs.push(a.includeMarks ? m[0] : m[1])
            if (!a.all) break
          }
        } else {
          let cursor = 0
          for (;;) {
            const i = src.indexOf(a.start, cursor)
            if (i < 0) break
            const j = src.indexOf(a.end, i + a.start.length)
            if (j < 0) break
            segs.push(a.includeMarks ? src.slice(i, j + a.end.length) : src.slice(i + a.start.length, j))
            cursor = j + a.end.length
            if (!a.all) break
          }
        }
        if (!segs.length) return json({ ok: false, message: '没找到标记区间，检查 start/end 写法' })
        return segs.join('\n\n---\n\n')
      },
    },
    {
      name: 'text_indent',
      desc: '整体缩进/反缩进/缩进风格转换（空格↔Tab）',
      params: {
        text: { type: 'string', required: true, desc: '多行文本' },
        op: { type: 'string', required: true, desc: 'indent|outdent|toSpaces|toTabs', enum: ['indent', 'outdent', 'toSpaces', 'toTabs'] },
        size: { type: 'integer', desc: '缩进宽度，默认 2' },
      },
      run: async (a) => {
        const size = clamp(int(a.size, 2), 1, 8)
        const rows = lines(a.text)
        if (a.op === 'toSpaces') return rows.map((l) => l.replace(/^\t+/, (m) => ' '.repeat(m.length * size))).replace(/\t/g, ' '.repeat(size))
        if (a.op === 'toTabs') return rows.map((l) => l.replace(/^ +/, (m) => '\t'.repeat(Math.floor(m.length / size)) + ' '.repeat(m.length % size)))
        if (a.op === 'outdent') return rows.map((l) => l.replace(new RegExp(`^ {1,${size}}`), '').replace(/^\t/, '')).join('\n')
        const pad = ' '.repeat(size)
        return rows.map((l) => (l.trim() ? pad + l : l)).join('\n')
      },
    },
    {
      name: 'text_random_string',
      desc: '生成随机密码/口令（可控字符集与强度）',
      params: {
        count: { type: 'integer', desc: '生成几个，默认 1' },
        length: { type: 'integer', desc: '长度，默认 16' },
        sets: { type: 'array', desc: '字符集：lower|upper|digit|symbol|hex，默认 lower/upper/digit', items: { type: 'string', desc: '字符集名' } },
        exclude: { type: 'string', desc: '要排除的字符，例如 0O1lI' },
      },
      run: async (a) => {
        const map = { lower: 'abcdefghijkmnopqrstuvwxyz', upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', digit: '23456789', symbol: '!@#$%^*-_=+', hex: '0123456789abcdef' }
        const names = Array.isArray(a.sets) && a.sets.length ? a.sets : ['lower', 'upper', 'digit']
        let pool = names.map((n) => map[String(n).toLowerCase()] || '').join('')
        for (const ch of enc(a.exclude)) pool = pool.split(ch).join('')
        if (!pool) return json({ ok: false, message: '字符集被排除空了' })
        const n = clamp(int(a.count, 1), 1, 200)
        const len = clamp(int(a.length, 16), 4, 256)
        const out = []
        for (let i = 0; i < n; i++) {
          let s = ''
          for (let k = 0; k < len; k++) s += pool[crypto.randomInt(pool.length)]
          out.push(s)
        }
        return { poolSize: pool.length, entropyBitsPerChar: Number(Math.log2(pool.length).toFixed(2)), totalEntropyBits: Math.round(len * Math.log2(pool.length)), passwords: out }
      },
    },
    {
      name: 'text_pretty_table',
      desc: '把 JSON 数组排成等宽文本表（终端风格）',
      params: {
        rows: { type: 'string', required: true, desc: 'JSON 数组文本' },
        columns: { type: 'array', desc: '列顺序；不传按第一个对象的键', items: { type: 'string', desc: '列名' } },
        maxWidth: { type: 'integer', desc: '单列最大宽度，默认 40' },
        limit: { type: 'integer', desc: '最多几行，默认 100' },
      },
      run: async (a) => {
        let arr
        try {
          arr = JSON.parse(a.rows)
        } catch (e) {
          return json({ ok: false, message: 'rows 要 JSON 数组文本' })
        }
        if (!Array.isArray(arr) || !arr.length) return '空数组'
        const cap = clamp(int(a.limit, 100), 1, 5000)
        const mw = clamp(int(a.maxWidth, 40), 6, 200)
        const cols = Array.isArray(a.columns) && a.columns.length ? a.columns : Object.keys(arr[0] || {})
        const cell = (v) => {
          const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
          return s.length > mw ? `${s.slice(0, mw - 1)}…` : s
        }
        const data = arr.slice(0, cap).map((o) => cols.map((c) => cell(o ? o[c] : '')))
        const widths = cols.map((c, i) => Math.max(c.length, ...data.map((r) => r[i].length)))
        const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`
        const sep = `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`
        return [line(cols), sep, ...data.map(line)].join('\n') + (arr.length > cap ? `\n# 共 ${arr.length} 行，显示前 ${cap}` : '')
      },
    },
  ],
}
