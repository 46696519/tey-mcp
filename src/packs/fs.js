// tey-mcp 参考样板包：文件系统。写别的包时照这个风格。
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { readTextSafe, walkFiles, globToRe, sha256buf, json, list1, fmtBytes, int, clamp, ensureDir } from '../util.js'

const enc = (a) => (a.encoding === 'latin1' ? 'latin1' : 'utf8')

async function readText(abs, limitBytes) {
  const r = await readTextSafe(abs, limitBytes)
  if (!r.ok) throw new Error(`${r.code}: ${r.message || r.path}`)
  return r
}

function splitLines(text) {
  return text.split(/\r?\n/)
}

function sliceLines(lines, offset, limit) {
  const start = Math.max(1, int(offset, 1))
  const take = clamp(int(limit, 400), 1, 20000)
  const out = lines.slice(start - 1, start - 1 + take)
  return { start, rows: out.map((l, i) => `${start + i}: ${l}`), more: lines.length - (start - 1 + out.length) }
}

function parseCsvLine(line, delim) {
  const rows = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"'
        i++
      } else inQ = !inQ
    } else if (ch === delim && !inQ) {
      rows.push(cur)
      cur = ''
    } else cur += ch
  }
  rows.push(cur)
  return rows
}

function getPath(obj, p) {
  const parts = String(p).replace(/^\$\.?/, '').split(/[.[\]]/).filter(Boolean)
  let cur = obj
  for (const key of parts) {
    if (cur == null) return undefined
    const k = key.replace(/["']/g, '')
    cur = Array.isArray(cur) && /^\d+$/.test(k) ? cur[Number(k)] : cur[k]
  }
  return cur
}

function setPath(obj, p, value) {
  const parts = String(p).replace(/^\$\.?/, '').split(/[.[\]]/).filter((s) => s !== '')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i].replace(/["']/g, '')
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = /^\d+$/.test(parts[i + 1]) ? [] : {}
    cur = cur[k]
  }
  const last = parts[parts.length - 1].replace(/["']/g, '')
  cur[last] = value
  return obj
}

export default {
  id: 'fs',
  title: '文件系统',
  tags: ['fs', 'file', 'io', 'csv', 'json'],
  summary: '读写、遍历、搜索、批量改文件，含 JSON/JSONL/CSV/frontmatter 快捷口',
  tools: [
    {
      name: 'fs_read',
      desc: '读文本文件，默认带行号，offset/limit 分页',
      params: {
        path: { type: 'string', required: true, desc: '文件路径，相对路径按会话工作区解析' },
        offset: { type: 'integer', desc: '起始行（1 起），默认 1' },
        limit: { type: 'integer', desc: '最多行数，默认 400' },
        raw: { type: 'boolean', desc: 'true=原样返回不加行号' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const r = await readText(abs)
        if (a.raw) return ctx.truncate(r.text)
        const s = sliceLines(splitLines(r.text), a.offset, a.limit)
        return `${abs} (${fmtBytes(r.size)})\n${s.rows.join('\n')}${s.more > 0 ? `\n…还有 ${s.more} 行` : ''}`
      },
    },
    {
      name: 'fs_write',
      desc: '写文本文件（覆盖），自动建父目录',
      write: true,
      params: {
        path: { type: 'string', required: true, desc: '目标文件路径' },
        content: { type: 'string', required: true, desc: '要写的正文' },
        mkdir: { type: 'boolean', desc: '是否自动建父目录，默认 true' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        if (a.mkdir !== false) ensureDir(path.dirname(abs))
        await fsp.writeFile(abs, String(a.content), enc(a))
        return `已写 ${abs} (${fmtBytes(Buffer.byteLength(String(a.content)))})`
      },
    },
    {
      name: 'fs_append',
      desc: '在文件末尾追加一行或一段文本',
      write: true,
      params: {
        path: { type: 'string', required: true, desc: '目标文件路径' },
        content: { type: 'string', required: true, desc: '追加内容' },
        newline: { type: 'boolean', desc: '末尾补换行，默认 true' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        ensureDir(path.dirname(abs))
        const text = String(a.content) + (a.newline === false ? '' : '\n')
        await fsp.appendFile(abs, text, enc(a))
        return `已追加 ${abs} +${fmtBytes(Buffer.byteLength(text))}`
      },
    },
    {
      name: 'fs_list',
      desc: '列目录，返回名字/类型/大小/修改时间',
      params: {
        path: { type: 'string', required: true, desc: '目录路径' },
        sort: { type: 'string', desc: '排序 name|mtime|size，默认 name', enum: ['name', 'mtime', 'size'] },
        limit: { type: 'integer', desc: '最多几条，默认 200' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const ents = await fsp.readdir(abs, { withFileTypes: true })
        const rows = []
        for (const e of ents) {
          const full = path.join(abs, e.name)
          let st = null
          try {
            st = await fsp.stat(full)
          } catch (err) {}
          rows.push({ name: e.name, dir: e.isDirectory(), size: st ? st.size : -1, mtime: st ? st.mtimeMs : 0 })
        }
        const key = a.sort || 'name'
        rows.sort((x, y) => (key === 'mtime' ? y.mtime - x.mtime : key === 'size' ? y.size - x.size : x.name.localeCompare(y.name)))
        const cap = clamp(int(a.limit, 200), 1, 5000)
        const shown = rows.slice(0, cap).map((r) => `${r.dir ? 'd' : '-'} ${fmtBytes(r.size).padStart(10)}  ${new Date(r.mtime).toISOString().slice(0, 19)}  ${r.name}`)
        return list1(`${abs}`, shown, rows.length > cap ? `共 ${rows.length} 项，只显示前 ${cap}` : '')
      },
    },
    {
      name: 'fs_stat',
      desc: '看一个路径的大小/时间/权限/行数等元信息',
      params: { path: { type: 'string', required: true, desc: '文件或目录路径' } },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const st = await fsp.stat(abs)
        const out = { path: abs, isFile: st.isFile(), isDir: st.isDirectory(), size: st.size, sizeHuman: fmtBytes(st.size), mode: (st.mode & 0o777).toString(8), mtime: st.mtimeMs, birthtime: st.birthtimeMs }
        if (st.isFile() && st.size < 8 * 1024 * 1024) {
          const r = await readTextSafe(abs)
          if (r.ok) {
            out.lines = splitLines(r.text).length
            out.bytesUtf8 = Buffer.byteLength(r.text)
          }
        }
        return out
      },
    },
    {
      name: 'fs_exists',
      desc: '判断路径存在与否，是文件还是目录',
      params: { path: { type: 'string', required: true, desc: '要检查的路径' } },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        try {
          const st = await fsp.stat(abs)
          return { path: abs, exists: true, isFile: st.isFile(), isDir: st.isDirectory() }
        } catch (e) {
          return { path: abs, exists: false }
        }
      },
    },
    {
      name: 'fs_find',
      desc: '按 glob 找文件（**/*.js 这种写法）',
      params: {
        pattern: { type: 'string', required: true, desc: 'glob 模式，例如 src/**/*.ts' },
        path: { type: 'string', desc: '搜索根，默认会话工作区' },
        limit: { type: 'integer', desc: '最多几条，默认 300' },
      },
      async run(a, ctx) {
        const root = ctx.resolve(a.path || '.')
        const re = globToRe(a.pattern)
        const files = walkFiles(root, { maxFiles: 20000 })
        const hits = files.filter((f) => re.test(path.relative(root, f).replace(/\\/g, '/')))
        const cap = clamp(int(a.limit, 300), 1, 5000)
        return list1(`匹配 ${a.pattern}`, hits.slice(0, cap).map((f) => path.relative(root, f)), hits.length > cap ? `共 ${hits.length} 个，只显示前 ${cap}` : hits.length === 0 ? '没有命中' : '')
      },
    },
    {
      name: 'fs_grep',
      desc: '在工作区按正则搜文件内容，返回文件:行号:内容',
      params: {
        pattern: { type: 'string', required: true, desc: '正则（JS 语法）' },
        path: { type: 'string', desc: '搜索根，默认会话工作区' },
        include: { type: 'string', desc: '只搜这些文件，glob 例如 *.js' },
        ignoreCase: { type: 'boolean', desc: '忽略大小写' },
        limit: { type: 'integer', desc: '最多几条命中，默认 80' },
      },
      async run(a, ctx) {
        const root = ctx.resolve(a.path || '.')
        const re = new RegExp(a.pattern, a.ignoreCase ? 'i' : '')
        const inc = a.include ? globToRe(a.include) : null
        const cap = clamp(int(a.limit, 80), 1, 2000)
        const files = walkFiles(root, { maxFiles: 8000 })
        const out = []
        for (const f of files) {
          if (inc && !inc.test(path.relative(root, f).replace(/\\/g, '/'))) continue
          let st
          try {
            st = await fsp.stat(f)
          } catch (e) {
            continue
          }
          if (st.size > 2 * 1024 * 1024) continue
          const r = await readTextSafe(f)
          if (!r.ok) continue
          const lines = splitLines(r.text)
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              out.push(`${path.relative(root, f)}:${i + 1}: ${lines[i].slice(0, 200)}`)
              if (out.length >= cap) break
            }
          }
          if (out.length >= cap) break
        }
        return list1(`grep ${a.pattern}`, out, out.length === 0 ? '没有命中' : `上限 ${cap} 条`)
      },
    },
    {
      name: 'fs_copy',
      desc: '复制文件（可覆盖）',
      write: true,
      params: {
        from: { type: 'string', required: true, desc: '源文件' },
        to: { type: 'string', required: true, desc: '目标路径' },
        overwrite: { type: 'boolean', desc: '已存在是否覆盖，默认 false' },
      },
      async run(a, ctx) {
        const src = ctx.resolve(a.from)
        const dst = ctx.resolve(a.to)
        if (a.overwrite !== true) {
          try {
            await fsp.stat(dst)
            return { ok: false, message: `目标已存在: ${dst}（要覆盖传 overwrite=true）` }
          } catch (e) {}
        }
        ensureDir(path.dirname(dst))
        await fsp.copyFile(src, dst)
        return `已复制 ${src} → ${dst}`
      },
    },
    {
      name: 'fs_move',
      desc: '移动/重命名文件',
      write: true,
      params: {
        from: { type: 'string', required: true, desc: '源路径' },
        to: { type: 'string', required: true, desc: '目标路径' },
      },
      async run(a, ctx) {
        const src = ctx.resolve(a.from)
        const dst = ctx.resolve(a.to)
        ensureDir(path.dirname(dst))
        await fsp.rename(src, dst)
        return `已移动 ${src} → ${dst}`
      },
    },
    {
      name: 'fs_remove',
      desc: '删文件或目录（目录需 recursive）',
      write: true,
      params: {
        path: { type: 'string', required: true, desc: '要删的路径' },
        recursive: { type: 'boolean', desc: '目录递归删除，默认 false' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        await fsp.rm(abs, { recursive: a.recursive === true, force: true })
        return `已删除 ${abs}`
      },
    },
    {
      name: 'fs_mkdir',
      desc: '建目录（递归）',
      write: true,
      params: { path: { type: 'string', required: true, desc: '目录路径' } },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        await fsp.mkdir(abs, { recursive: true })
        return `已建目录 ${abs}`
      },
    },
    {
      name: 'fs_touch',
      desc: '建空文件或更新时间戳',
      write: true,
      params: { path: { type: 'string', required: true, desc: '文件路径' } },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        ensureDir(path.dirname(abs))
        const now = new Date()
        try {
          await fsp.utimes(abs, now, now)
          return `已更新时间戳 ${abs}`
        } catch (e) {
          await fsp.writeFile(abs, '', 'utf8')
          return `已建空文件 ${abs}`
        }
      },
    },
    {
      name: 'fs_tree',
      desc: '目录树概览（缩进 + 目录/文件计数）',
      params: {
        path: { type: 'string', desc: '根目录，默认会话工作区' },
        depth: { type: 'integer', desc: '最大层数，默认 3' },
        limit: { type: 'integer', desc: '最多几行，默认 300' },
      },
      async run(a, ctx) {
        const root = ctx.resolve(a.path || '.')
        const maxDepth = clamp(int(a.depth, 3), 1, 10)
        const cap = clamp(int(a.limit, 300), 1, 5000)
        const rows = []
        let dirs = 0
        let files = 0
        const walk = async (dir, depth) => {
          if (depth > maxDepth || rows.length >= cap) return
          let ents
          try {
            ents = await fsp.readdir(dir, { withFileTypes: true })
          } catch (e) {
            return
          }
          ents.sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name) : x.isDirectory() ? -1 : 1))
          for (const e of ents) {
            if (rows.length >= cap) break
            if (/^(\.git|node_modules|dist|build|__pycache__)$/.test(e.name)) continue
            const full = path.join(dir, e.name)
            rows.push(`${'  '.repeat(depth)}${e.isDirectory() ? '+' : '-'} ${e.name}`)
            if (e.isDirectory()) {
              dirs++
              await walk(full, depth + 1)
            } else files++
          }
        }
        await walk(root, 0)
        return list1(`tree ${root} (dirs ${dirs}, files ${files})`, rows, rows.length >= cap ? `行数上限 ${cap}` : '')
      },
    },
    {
      name: 'fs_du',
      desc: '统计目录占用大小，按大小排 top N',
      params: {
        path: { type: 'string', desc: '目录，默认会话工作区' },
        top: { type: 'integer', desc: '返回前几大，默认 20' },
      },
      async run(a, ctx) {
        const root = ctx.resolve(a.path || '.')
        const files = walkFiles(root, { maxFiles: 50000 })
        const byDir = new Map()
        let total = 0
        for (const f of files) {
          let st
          try {
            st = await fsp.stat(f)
          } catch (e) {
            continue
          }
          total += st.size
          const key = path.relative(root, path.dirname(f)) || '.'
          byDir.set(key, (byDir.get(key) || 0) + st.size)
        }
        const top = clamp(int(a.top, 20), 1, 500)
        const rows = [...byDir.entries()].sort((x, y) => y[1] - x[1]).slice(0, top).map(([k, v]) => `${fmtBytes(v).padStart(10)}  ${k}`)
        return list1(`du ${root} 合计 ${fmtBytes(total)} / ${files.length} 文件`, rows)
      },
    },
    {
      name: 'fs_hash',
      desc: '算文件 sha256/md5 与大小',
      params: {
        path: { type: 'string', required: true, desc: '文件路径' },
        algo: { type: 'string', desc: 'sha256|md5|sha1，默认 sha256', enum: ['sha256', 'md5', 'sha1'] },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const buf = await fsp.readFile(abs)
        const algo = a.algo || 'sha256'
        const crypto = await import('node:crypto')
        return { path: abs, algo, digest: crypto.createHash(algo).update(buf).digest('hex'), size: buf.length, sizeHuman: fmtBytes(buf.length) }
      },
    },
    {
      name: 'fs_count',
      desc: '统计文件行数/字数/字节数/非空行',
      params: { path: { type: 'string', required: true, desc: '文件路径' } },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const r = await readText(abs)
        const lines = splitLines(r.text)
        return {
          path: abs,
          lines: lines.length,
          nonEmptyLines: lines.filter((l) => l.trim()).length,
          words: r.text.split(/\s+/).filter(Boolean).length,
          bytes: Buffer.byteLength(r.text),
          approxTokens: Math.ceil(Buffer.byteLength(r.text) / 4),
        }
      },
    },
    {
      name: 'fs_head',
      desc: '取文件前 N 行',
      params: {
        path: { type: 'string', required: true, desc: '文件路径' },
        lines: { type: 'integer', desc: '行数，默认 20' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const r = await readText(abs)
        const n = clamp(int(a.lines, 20), 1, 5000)
        return splitLines(r.text).slice(0, n).join('\n')
      },
    },
    {
      name: 'fs_tail',
      desc: '取文件后 N 行（看日志）',
      params: {
        path: { type: 'string', required: true, desc: '文件路径' },
        lines: { type: 'integer', desc: '行数，默认 40' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const r = await readText(abs)
        const n = clamp(int(a.lines, 40), 1, 5000)
        return splitLines(r.text).slice(-n).join('\n')
      },
    },
    {
      name: 'fs_lines_slice',
      desc: '按行号区间取文件片段',
      params: {
        path: { type: 'string', required: true, desc: '文件路径' },
        from: { type: 'integer', required: true, desc: '起始行（1 起）' },
        to: { type: 'integer', desc: '结束行，默认 from+200' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const r = await readText(abs)
        const lines = splitLines(r.text)
        const from = Math.max(1, int(a.from, 1))
        const to = Math.min(lines.length, int(a.to, from + 200))
        return lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n')
      },
    },
    {
      name: 'fs_replace',
      desc: '在文件里精确替换一处（old 必须唯一）',
      write: true,
      params: {
        path: { type: 'string', required: true, desc: '文件路径' },
        oldText: { type: 'string', required: true, desc: '要替换的原文，必须只出现一次' },
        newText: { type: 'string', required: true, desc: '替换成什么（空串=删除）' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const r = await readText(abs)
        const count = r.text.split(a.oldText).length - 1
        if (count === 0) return { ok: false, message: '没找到 oldText' }
        if (count > 1) return { ok: false, message: `oldText 出现 ${count} 次，不唯一；扩大上下文或用 fs_replace_all` }
        await fsp.writeFile(abs, r.text.replace(a.oldText, a.newText), 'utf8')
        return `已替换 ${abs} 1 处`
      },
    },
    {
      name: 'fs_replace_all',
      desc: '文件内全量替换（可正则），返回命中数',
      write: true,
      params: {
        path: { type: 'string', required: true, desc: '文件路径' },
        find: { type: 'string', required: true, desc: '要替换的文本或正则' },
        replacement: { type: 'string', required: true, desc: '替换成什么' },
        regex: { type: 'boolean', desc: 'find 当正则处理，默认 false' },
        dryRun: { type: 'boolean', desc: '只统计不写，默认 false' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const r = await readText(abs)
        let out
        let count = 0
        if (a.regex) {
          const re = new RegExp(a.find, 'g')
          count = (r.text.match(re) || []).length
          out = r.text.replace(re, a.replacement)
        } else {
          count = r.text.split(a.find).length - 1
          out = r.text.split(a.find).join(a.replacement)
        }
        if (a.dryRun) return { path: abs, matches: count, dryRun: true }
        if (count) await fsp.writeFile(abs, out, 'utf8')
        return { path: abs, matches: count, written: count > 0 }
      },
    },
    {
      name: 'fs_patch_lines',
      desc: '按行号替换/插入/删除若干行，一次改多处',
      write: true,
      params: {
        path: { type: 'string', required: true, desc: '文件路径' },
        edits: { type: 'array', required: true, desc: '改动列表，每项 {from,to,text}；to 省略=插入到 from 前', items: { type: 'string', desc: 'JSON 字符串，例如 {"from":3,"to":5,"text":"新行"}' } },
        dryRun: { type: 'boolean', desc: '只算不写' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const r = await readText(abs)
        const lines = splitLines(r.text)
        const ops = []
        for (const raw of a.edits) {
          const o = typeof raw === 'string' ? JSON.parse(raw) : raw
          if (!o || !Number.isFinite(Number(o.from))) throw new Error(`edit 缺 from 行号: ${JSON.stringify(o)}`)
          ops.push({ from: Number(o.from), to: o.to === undefined ? null : Number(o.to), text: o.text === undefined ? '' : String(o.text) })
        }
        ops.sort((x, y) => y.from - x.from)
        for (const o of ops) {
          if (o.to === null) lines.splice(o.from - 1, 0, ...o.text.split(/\r?\n/))
          else lines.splice(o.from - 1, o.to - o.from + 1, ...(o.text ? o.text.split(/\r?\n/) : []))
        }
        const out = lines.join('\n')
        if (!a.dryRun) await fsp.writeFile(abs, out, 'utf8')
        return { path: abs, edits: ops.length, lines: lines.length, dryRun: !!a.dryRun }
      },
    },
    {
      name: 'fs_diff',
      desc: '比较两个文件或两段文本，输出行级差异',
      params: {
        left: { type: 'string', required: true, desc: '文件路径或文本' },
        right: { type: 'string', required: true, desc: '文件路径或文本' },
        context: { type: 'integer', desc: '上下文行数，默认 2' },
      },
      async run(a, ctx) {
        const grab = async (v) => {
          try {
            const abs = ctx.resolve(v)
            if (fs.existsSync(abs)) return (await readText(abs)).text
          } catch (e) {}
          return String(v)
        }
        const L = splitLines(await grab(a.left))
        const R = splitLines(await grab(a.right))
        const setL = new Set(L)
        const setR = new Set(R)
        const onlyL = L.map((l, i) => [i + 1, l]).filter(([, l]) => !setR.has(l))
        const onlyR = R.map((l, i) => [i + 1, l]).filter(([, l]) => !setL.has(l))
        const rows = [
          ...onlyL.slice(0, 60).map(([n, l]) => `- ${n}: ${l.slice(0, 160)}`),
          ...onlyR.slice(0, 60).map(([n, l]) => `+ ${n}: ${l.slice(0, 160)}`),
        ]
        return list1(`diff ${a.left} ↔ ${a.right}: 仅左 ${onlyL.length} 行 / 仅右 ${onlyR.length} 行`, rows, rows.length === 0 ? '两边一致' : '')
      },
    },
    {
      name: 'fs_json_read',
      desc: '读 JSON 并可按路径取一个值（a.b.0 写法）',
      params: {
        path: { type: 'string', required: true, desc: 'JSON 文件路径' },
        at: { type: 'string', desc: '取值路径，例如 config.models.0.name；不传给全文' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const r = await readText(abs)
        let obj
        try {
          obj = JSON.parse(r.text)
        } catch (e) {
          return { ok: false, message: `不是合法 JSON: ${String(e && e.message).slice(0, 200)}` }
        }
        if (!a.at) return ctx.truncate(JSON.stringify(obj, null, 2))
        const v = getPath(obj, a.at)
        return v === undefined ? { path: abs, at: a.at, value: null, note: '没这个键' } : { path: abs, at: a.at, value: v }
      },
    },
    {
      name: 'fs_json_write',
      desc: '写 JSON；给了 at 就只改那一个键',
      write: true,
      params: {
        path: { type: 'string', required: true, desc: 'JSON 文件路径' },
        value: { type: 'string', required: true, desc: '要写的值（JSON 文本），例如 {"a":1} 或 "x"' },
        at: { type: 'string', desc: '只改这个键的路径；不传=整文件覆盖' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        let parsed
        try {
          parsed = JSON.parse(a.value)
        } catch (e) {
          return { ok: false, message: `value 不是合法 JSON: ${String(e && e.message).slice(0, 160)}` }
        }
        let out
        if (a.at) {
          const r = await readText(abs)
          let obj = {}
          try {
            obj = JSON.parse(r.text)
          } catch (e) {}
          setPath(obj, a.at, parsed)
          out = JSON.stringify(obj, null, 2)
        } else out = JSON.stringify(parsed, null, 2)
        ensureDir(path.dirname(abs))
        await fsp.writeFile(abs, out, 'utf8')
        return `已写 ${abs}${a.at ? ` (${a.at})` : ''}`
      },
    },
    {
      name: 'fs_jsonl_append',
      desc: '往 JSONL 追加记录（一行一条）',
      write: true,
      params: {
        path: { type: 'string', required: true, desc: 'JSONL 文件路径' },
        rows: { type: 'array', required: true, desc: '记录数组，每项是 JSON 文本', items: { type: 'string', desc: '一条 JSON' } },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        ensureDir(path.dirname(abs))
        const lines = a.rows.map((r) => (typeof r === 'string' ? r.trim() : JSON.stringify(r)))
        await fsp.appendFile(abs, `${lines.join('\n')}\n`, 'utf8')
        return `已追加 ${lines.length} 条 → ${abs}`
      },
    },
    {
      name: 'fs_jsonl_read',
      desc: '读 JSONL，可按字段过滤/取字段/取尾 N 条',
      params: {
        path: { type: 'string', required: true, desc: 'JSONL 文件路径' },
        tail: { type: 'integer', desc: '取最后 N 条，默认 20' },
        where: { type: 'string', desc: '过滤，形如 key=值 或 key~=正则' },
        fields: { type: 'array', desc: '只返回这些字段', items: { type: 'string', desc: '字段名' } },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const r = await readText(abs)
        const rows = r.text.split(/\r?\n/).filter(Boolean).map((l) => {
          try {
            return JSON.parse(l)
          } catch (e) {
            return { __bad: l.slice(0, 120) }
          }
        })
        let out = rows
        if (a.where) {
          const m = String(a.where).match(/^(.+?)(~?=)(.*)$/)
          if (m) {
            const [, key, op, val] = m
            out = out.filter((row) => {
              const v = getPath(row, key)
              const s = v === undefined || v === null ? '' : String(v)
              return op === '~=' ? new RegExp(val).test(s) : s === val
            })
          }
        }
        const n = clamp(int(a.tail, 20), 1, 2000)
        out = out.slice(-n)
        if (Array.isArray(a.fields) && a.fields.length) out = out.map((row) => Object.fromEntries(a.fields.map((f) => [f, getPath(row, f)])))
        return list1(`${abs} 命中 ${out.length} 条（取尾 ${n}）`, [json(out)])
      },
    },
    {
      name: 'fs_csv_read',
      desc: '读 CSV/TSV 成对象数组，可只取列与前 N 行',
      params: {
        path: { type: 'string', required: true, desc: 'CSV 文件路径' },
        delimiter: { type: 'string', desc: '分隔符，默认自动（, ; \\t |）' },
        limit: { type: 'integer', desc: '最多几行，默认 50' },
        columns: { type: 'array', desc: '只要这些列名', items: { type: 'string', desc: '列名' } },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const r = await readText(abs)
        const lines = splitLines(r.text).filter((l) => l.trim())
        const delim = a.delimiter || (lines[0].includes('\t') ? '\t' : lines[0].split(';').length > lines[0].split(',').length ? ';' : ',')
        const header = parseCsvLine(lines[0], delim)
        const rows = lines.slice(1).map((l) => {
          const cells = parseCsvLine(l, delim)
          const o = {}
          header.forEach((h, i) => {
            o[h.trim()] = cells[i] === undefined ? '' : cells[i]
          })
          return o
        })
        const n = clamp(int(a.limit, 50), 1, 5000)
        let out = rows.slice(0, n)
        if (Array.isArray(a.columns) && a.columns.length) out = out.map((row) => Object.fromEntries(a.columns.map((c) => [c, row[c]])))
        return { path: abs, header, total: rows.length, rows: out }
      },
    },
    {
      name: 'fs_csv_write',
      desc: '把对象数组写成 CSV',
      write: true,
      params: {
        path: { type: 'string', required: true, desc: '输出 CSV 路径' },
        rows: { type: 'array', required: true, desc: '记录数组，每项是 JSON 文本', items: { type: 'string', desc: '一条 JSON' } },
        columns: { type: 'array', desc: '列顺序；不传按第一条的键', items: { type: 'string', desc: '列名' } },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const objs = a.rows.map((r) => (typeof r === 'string' ? JSON.parse(r) : r))
        const cols = Array.isArray(a.columns) && a.columns.length ? a.columns : Object.keys(objs[0] || {})
        const esc = (v) => {
          const s = v === null || v === undefined ? '' : String(v)
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        }
        const body = [cols.join(','), ...objs.map((o) => cols.map((c) => esc(o[c])).join(','))].join('\n')
        ensureDir(path.dirname(abs))
        await fsp.writeFile(abs, body, 'utf8')
        return `已写 ${abs}：${objs.length} 行 × ${cols.length} 列`
      },
    },
    {
      name: 'fs_frontmatter_read',
      desc: '读 Markdown 的 YAML frontmatter 与正文长度',
      params: { path: { type: 'string', required: true, desc: 'md 文件路径' } },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const r = await readText(abs)
        const m = r.text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
        if (!m) return { path: abs, frontmatter: null, bodyChars: r.text.length }
        const { parseYamlLite } = await import('../util.js')
        return { path: abs, frontmatter: parseYamlLite(m[1]), bodyChars: r.text.length - m[0].length }
      },
    },
    {
      name: 'fs_frontmatter_set',
      desc: '改 Markdown frontmatter 的某个键',
      write: true,
      params: {
        path: { type: 'string', required: true, desc: 'md 文件路径' },
        key: { type: 'string', required: true, desc: '键名' },
        value: { type: 'string', required: true, desc: '键值（字符串）' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const r = await readText(abs)
        const { parseYamlLite, dumpYamlLite } = await import('../util.js')
        const m = r.text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
        const fm = m ? parseYamlLite(m[1]) : {}
        fm[a.key] = a.value
        const body = m ? r.text.slice(m[0].length) : r.text
        await fsp.writeFile(abs, `---\n${dumpYamlLite(fm)}\n---\n\n${body}`, 'utf8')
        return `已写 ${a.key} → ${abs}`
      },
    },
    {
      name: 'fs_snapshot',
      desc: '给目录拍个快照（路径+大小+mtime 哈希），配 fs_snapshot_diff 用',
      params: {
        path: { type: 'string', desc: '目录，默认会话工作区' },
        name: { type: 'string', desc: '快照名，默认 default' },
      },
      async run(a, ctx) {
        const root = ctx.resolve(a.path || '.')
        const files = walkFiles(root, { maxFiles: 30000 })
        const rows = []
        for (const f of files) {
          try {
            const st = await fsp.stat(f)
            rows.push(`${path.relative(root, f)}|${st.size}|${Math.round(st.mtimeMs)}`)
          } catch (e) {}
        }
        const snapFile = path.join(ctx.dataDir, 'snapshots', `${a.name || 'default'}.json`)
        ensureDir(path.dirname(snapFile))
        await fsp.writeFile(snapFile, JSON.stringify({ root, takenAt: Date.now(), rows }, null, 2), 'utf8')
        return { snapshot: a.name || 'default', root, files: rows.length, savedTo: snapFile }
      },
    },
    {
      name: 'fs_snapshot_diff',
      desc: '拿当前目录和之前的快照比，列出新增/删除/改动',
      params: {
        path: { type: 'string', desc: '目录，默认用快照记录的根' },
        name: { type: 'string', desc: '快照名，默认 default' },
      },
      async run(a, ctx) {
        const snapFile = path.join(ctx.dataDir, 'snapshots', `${a.name || 'default'}.json`)
        if (!fs.existsSync(snapFile)) return { ok: false, message: `没有快照 ${a.name || 'default'}，先 fs_snapshot` }
        const snap = JSON.parse(await fsp.readFile(snapFile, 'utf8'))
        const root = a.path ? ctx.resolve(a.path) : snap.root
        const now = new Map()
        for (const f of walkFiles(root, { maxFiles: 30000 })) {
          try {
            const st = await fsp.stat(f)
            now.set(path.relative(root, f), `${st.size}|${Math.round(st.mtimeMs)}`)
          } catch (e) {}
        }
        const old = new Map(snap.rows.map((r) => {
          const i = r.lastIndexOf('|')
          const j = r.lastIndexOf('|')
          return [r.slice(0, j), r.slice(j + 1)]
        }))
        const added = []
        const removed = []
        const changed = []
        for (const [k, v] of now) {
          if (!old.has(k)) added.push(k)
          else if (old.get(k) !== v) changed.push(k)
        }
        for (const k of old.keys()) if (!now.has(k)) removed.push(k)
        return { root, takenAt: snap.takenAt, added: added.slice(0, 100), removed: removed.slice(0, 100), changed: changed.slice(0, 100), counts: { added: added.length, removed: removed.length, changed: changed.length } }
      },
    },
    {
      name: 'fs_batch_rename',
      desc: '批量改名：正则查找替换文件名，可先干跑',
      write: true,
      params: {
        path: { type: 'string', desc: '目录，默认会话工作区' },
        pattern: { type: 'string', required: true, desc: '匹配文件名的正则' },
        replacement: { type: 'string', required: true, desc: '替换成的文本（支持 $1）' },
        dryRun: { type: 'boolean', desc: '只列不改，默认 true' },
      },
      async run(a, ctx) {
        const root = ctx.resolve(a.path || '.')
        const re = new RegExp(a.pattern)
        const files = walkFiles(root, { maxFiles: 20000 })
        const plan = []
        for (const f of files) {
          const base = path.basename(f)
          if (!re.test(base)) continue
          const next = base.replace(re, a.replacement)
          if (next === base) continue
          plan.push({ from: f, to: path.join(path.dirname(f), next) })
        }
        if (a.dryRun !== false) return { dryRun: true, wouldRename: plan.length, sample: plan.slice(0, 30).map((p) => `${path.basename(p.from)} → ${path.basename(p.to)}`) }
        let done = 0
        for (const p of plan) {
          try {
            await fsp.rename(p.from, p.to)
            done++
          } catch (e) {}
        }
        return { renamed: done, total: plan.length }
      },
    },
    {
      name: 'fs_find_replace_files',
      desc: '跨文件批量替换内容（带 include 过滤与干跑）',
      write: true,
      params: {
        find: { type: 'string', required: true, desc: '要替换的文本或正则' },
        replacement: { type: 'string', required: true, desc: '替换成什么' },
        path: { type: 'string', desc: '搜索根，默认会话工作区' },
        include: { type: 'string', desc: '只改这些文件，glob 例如 **/*.js' },
        regex: { type: 'boolean', desc: 'find 当正则' },
        dryRun: { type: 'boolean', desc: '只统计不写，默认 true' },
      },
      async run(a, ctx) {
        const root = ctx.resolve(a.path || '.')
        const inc = a.include ? globToRe(a.include) : null
        const files = walkFiles(root, { maxFiles: 8000 })
        let hitFiles = 0
        let hits = 0
        const sample = []
        for (const f of files) {
          if (inc && !inc.test(path.relative(root, f).replace(/\\/g, '/'))) continue
          const r = await readTextSafe(f, 1024 * 1024)
          if (!r.ok) continue
          let count = 0
          let out = r.text
          if (a.regex) {
            const re = new RegExp(a.find, 'g')
            count = (r.text.match(re) || []).length
            if (count) out = r.text.replace(re, a.replacement)
          } else {
            count = r.text.split(a.find).length - 1
            if (count) out = r.text.split(a.find).join(a.replacement)
          }
          if (!count) continue
          hitFiles++
          hits += count
          if (sample.length < 20) sample.push(`${path.relative(root, f)} ×${count}`)
          if (a.dryRun !== false) continue
          await fsp.writeFile(f, out, 'utf8')
        }
        return { dryRun: a.dryRun !== false, files: hitFiles, matches: hits, sample }
      },
    },
  ],
}
