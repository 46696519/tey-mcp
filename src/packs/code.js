// 代码体检包：行数统计、文件大纲、依赖图、TODO 扫描、包依赖审计、跑测试/类型检查。
// 全部用正则 + 启发式，不装任何解析库；结论标注为启发式，别当权威。
import fs from 'node:fs'
import path from 'node:path'
import { json, int, clamp, fmtBytes, readTextSafe, walkFiles } from '../util.js'

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.lua', '.swift', '.scala', '.dart', '.sql', '.toml', '.yml', '.yaml', '.json', '.md', '.css', '.scss', '.html'])
const SKIP_DIR = /(^|[\\/])(\.git|node_modules|dist|build|\.next|\.nuxt|target|__pycache__|\.venv|venv|\.idea|\.vscode|coverage|\.cache|out|\.agent-teams|\.turbo)([\\/]|$)/

function rootOf(ctx, a) {
  return ctx.resolve(a && a.path ? a.path : '.')
}

function extOf(f) {
  return (path.extname(f) || '(无)').toLowerCase()
}

function rel(root, f) {
  const r = path.relative(root, f)
  return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : f
}

function splitLines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n')
}

function isComment(line, ext) {
  const t = line.trim()
  if (!t) return false
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.scala', '.dart', '.css', '.scss', '.php'].includes(ext)) return /^(\/\/|\/\*|\*\/|\*)/.test(t)
  if (['.py', '.sh', '.ps1', '.yml', '.yaml', '.toml', '.rb'].includes(ext)) return t.startsWith('#')
  if (['.lua'].includes(ext)) return t.startsWith('--')
  if (['.html', '.vue', '.md', '.sql'].includes(ext)) return /^(<!--|--|<!)/.test(t)
  return false
}

function collectFiles(root, opts = {}) {
  const maxFiles = clamp(int(opts.maxFiles, 4000), 50, 100000)
  const files = walkFiles(root, { maxDepth: clamp(int(opts.maxDepth, 8), 1, 20), maxFiles, skip: SKIP_DIR })
  return opts.codeOnly === false ? files : files.filter((f) => CODE_EXT.has(extOf(f)))
}

/** readTextSafe 返回的是 {ok,text}，这里收成字符串或 null，省得每处拆对象。 */
async function readStr(abs, limitBytes = 400000) {
  const r = await readTextSafe(abs, limitBytes)
  return r && r.ok ? r.text : null
}

const JS_DEF = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\(|[\w$]+\s*=>)/, 'function'],
  [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, 'type'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*=/, 'constant'],
]
const PY_DEF = [
  [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function'],
  [/^\s*class\s+([A-Za-z_]\w*)/, 'class'],
]

function defsFor(ext) {
  if (['.py', '.pyi'].includes(ext)) return PY_DEF
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte'].includes(ext)) return JS_DEF
  return JS_DEF
}

function extractImports(text, ext) {
  const found = []
  const push = (spec, kind, line) => {
    if (!spec) return
    found.push({ spec: spec.replace(/^['"]|['"]$/g, ''), kind, line })
  }
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte'].includes(ext)) {
    let i = 0
    for (const line of splitLines(text)) {
      i++
      let m
      const re1 = /(?:^|\s)import\s+(?:[\w*\s{},$]*\sfrom\s+)?['"]([^'"]+)['"]/g
      while ((m = re1.exec(line))) push(m[1], 'import', i)
      const re2 = /export\s+(?:[\w*\s{},*]*\s)?(?:from\s+)?['"]([^'"]+)['"]/g
      while ((m = re2.exec(line))) push(m[1], 're-export', i)
      const re3 = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
      while ((m = re3.exec(line))) push(m[1], 'require', i)
      const re4 = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
      while ((m = re4.exec(line))) push(m[1], 'dynamic-import', i)
    }
  } else if (['.py', '.pyi'].includes(ext)) {
    let i = 0
    for (const line of splitLines(text)) {
      i++
      let m
      const re1 = /^\s*from\s+([.\w]+)\s+import/g
      while ((m = re1.exec(line))) push(m[1], 'from-import', i)
      const re2 = /^\s*import\s+([\w.]+)/g
      while ((m = re2.exec(line))) push(m[1], 'import', i)
    }
  }
  return found
}

function extractExports(text, ext) {
  const names = new Set()
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
    for (const m of text.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
    for (const m of text.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
    for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}/g)) for (const part of m[1].split(',')) {
      const t2 = part.trim().split(/\s+as\s+/).pop().trim()
      if (t2 && /^[A-Za-z_$][\w$]*$/.test(t2)) names.add(t2)
    }
    if (/\bexport\s+default\b/.test(text)) names.add('default')
  } else if (['.py', '.pyi'].includes(ext)) {
    for (const m of text.matchAll(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm)) if (!m[1].startsWith('_')) names.add(m[1])
    for (const m of text.matchAll(/^\s*class\s+([A-Za-z_]\w*)/gm)) if (!m[1].startsWith('_')) names.add(m[1])
  }
  return [...names]
}

export default {
  id: 'code',
  title: '代码体检',
  tags: ['code', 'analysis', 'lint', 'dependencies', 'typescript', 'python'],
  summary: '代码行数统计、文件大纲、依赖图与死文件、TODO 扫描、包依赖审计、跑测试与类型检查',
  tools: [
    {
      name: 'code_stats',
      desc: '代码量统计：按扩展名分行数/代码/注释/空行，注释占比',
      params: {
        path: { type: 'string', desc: '目录，默认会话工作区' },
        maxFiles: { type: 'integer', desc: '最多扫几个文件，默认 4000' },
        maxDepth: { type: 'integer', desc: '最大层数，默认 8' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const files = collectFiles(root, a)
        const byExt = {}
        let totalLines = 0
        let totalCode = 0
        let totalComment = 0
        let totalBlank = 0
        for (const f of files) {
          const text = await readStr(f, 400000)
          if (text === null) continue
          const ext = extOf(f)
          const lines = splitLines(text)
          let code = 0
          let comment = 0
          let blank = 0
          for (const l of lines) {
            if (!l.trim()) blank++
            else if (isComment(l, ext)) comment++
            else code++
          }
          const b = (byExt[ext] = byExt[ext] || { files: 0, lines: 0, code: 0, comment: 0, blank: 0 })
          b.files++
          b.lines += lines.length
          b.code += code
          b.comment += comment
          b.blank += blank
          totalLines += lines.length
          totalCode += code
          totalComment += comment
          totalBlank += blank
        }
        const rows = Object.entries(byExt).sort((x, y) => y[1].lines - x[1].lines)
        return {
          root,
          files: files.length,
          totalLines,
          totalCode,
          totalComment,
          totalBlank,
          commentPercent: totalLines ? Number((100 * totalComment / totalLines).toFixed(1)) : 0,
          byExtension: rows.slice(0, 30).map(([e, b]) => `${String(b.lines).padStart(8)} 行 ${String(b.files).padStart(5)} 个  注释${String(Number((100 * b.comment / Math.max(1, b.lines)).toFixed(0)) + '%').padStart(5)}  ${e}`),
        }
      },
    },
    {
      name: 'code_outline',
      desc: '文件大纲：函数/类/类型/常量定义与行号（JS/TS/Python 启发式）',
      params: {
        file: { type: 'string', required: true, desc: '文件路径' },
        includeExports: { type: 'boolean', desc: '标出哪些是 export，默认 true' },
        limit: { type: 'integer', desc: '最多几条，默认 80' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.file)
        const text = await readStr(abs, 2000000)
        if (text === null) return json({ ok: false, message: `读不到文件: ${abs}` })
        const ext = extOf(abs)
        const rules = defsFor(ext)
        const exported = new Set(extractExports(text, ext))
        const rows = []
        let i = 0
        for (const line of splitLines(text)) {
          i++
          for (const [re, kind] of rules) {
            const m = line.match(re)
            if (m) {
              rows.push({ line: i, kind, name: m[1], exported: exported.has(m[1]) || /export/.test(line) })
              break
            }
          }
        }
        const cap = clamp(int(a.limit, 80), 1, 2000)
        return {
          file: a.file,
          lines: splitLines(text).length,
          bytes: fmtBytes(Buffer.byteLength(text)),
          symbols: rows.length,
          outline: rows.slice(0, cap).map((r) => `${String(r.line).padStart(5)}  ${r.kind.padEnd(9)} ${r.exported && a.includeExports !== false ? '⇱ ' : '  '}${r.name}`),
        }
      },
    },
    {
      name: 'code_imports',
      desc: '抽出一个文件的所有 import/require 依赖（含动态 import）',
      params: { file: { type: 'string', required: true, desc: '文件路径' }, limit: { type: 'integer', desc: '最多几条，默认 60' } },
      async run(a, ctx) {
        const abs = ctx.resolve(a.file)
        const text = await readStr(abs, 2000000)
        if (text === null) return json({ ok: false, message: `读不到文件: ${abs}` })
        const found = extractImports(text, extOf(abs))
        const cap = clamp(int(a.limit, 60), 1, 1000)
        const local = found.filter((f) => f.spec.startsWith('.') || f.spec.startsWith('/') || f.spec.startsWith('~'))
        const bare = found.filter((f) => !local.includes(f))
        return { file: a.file, total: found.length, localImports: local.length, externalPackages: [...new Set(bare.map((f) => f.spec.replace(/^@([^/]+)\/([^/]+).*/, '@$1/$2').split('/')[0]))].length, deps: found.slice(0, cap).map((f) => `L${String(f.line).padStart(4)} [${f.kind}] ${f.spec}`), externalList: [...new Set(bare.map((f) => f.spec))] }
      },
    },
    {
      name: 'code_import_graph',
      desc: '项目依赖图摘要：谁被引用最多（fan-in）、谁引用最多（fan-out）',
      params: {
        path: { type: 'string', desc: '目录，默认工作区' },
        maxFiles: { type: 'integer', desc: '最多扫几个，默认 3000' },
        limit: { type: 'integer', desc: '排行各列前几名，默认 20' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const files = collectFiles(root, a)
        const fanIn = {}
        const fanOut = {}
        const external = {}
        let edges = 0
        for (const f of files) {
          const text = await readStr(f, 300000)
          if (text === null) continue
          const rel2 = rel(root, f)
          const imps = extractImports(text, extOf(f))
          fanOut[rel2] = imps.length
          edges += imps.length
          for (const im of imps) {
            const s = im.spec
            if (s.startsWith('.')) {
              const base = path.posix.dirname(rel2)
              let target = path.posix.normalize(path.posix.join(base, s.replace(/^\.\//, '')))
              const cands = [target, `${target}.js`, `${target}.ts`, `${target}.tsx`, `${target}.mjs`, `${target}.jsx`, `${target}.py`, path.posix.join(target, 'index.js'), path.posix.join(target, 'index.ts')]
              const hit = cands.find((c) => files.some((x) => rel(root, x) === c))
              if (hit) fanIn[hit] = (fanIn[hit] || 0) + 1
            } else {
              const pkg = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]
              external[pkg] = (external[pkg] || 0) + 1
            }
          }
        }
        const cap = clamp(int(a.limit, 20), 1, 300)
        const top = (obj) => Object.entries(obj).sort((x, y) => y[1] - x[1]).slice(0, cap).map(([k, v]) => `${String(v).padStart(5)}  ${k}`)
        return { root, files: files.length, edges, mostDependedOn: top(fanIn), mostDependencies: top(fanOut), externalPackages: top(external) }
      },
    },
    {
      name: 'code_dead_files',
      desc: '找疑似没人引用的文件（入口/测试/配置自动排除，启发式）',
      params: {
        path: { type: 'string', desc: '目录，默认工作区' },
        maxFiles: { type: 'integer', desc: '最多扫几个，默认 3000' },
        limit: { type: 'integer', desc: '最多列几个，默认 40' },
        includeTests: { type: 'boolean', desc: '测试文件也算候选，默认 false' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const files = collectFiles(root, a)
        const relSet = new Map(files.map((f) => [rel(root, f), f]))
        const referenced = new Set()
        for (const f of files) {
          const text = await readStr(f, 300000)
          if (text === null) continue
          const rel2 = rel(root, f)
          for (const im of extractImports(text, extOf(f))) {
            if (!im.spec.startsWith('.')) continue
            const base = path.posix.dirname(rel2)
            const target = path.posix.normalize(path.posix.join(base, im.spec.replace(/^\.\//, '')))
            for (const cand of [target, `${target}.js`, `${target}.ts`, `${target}.tsx`, `${target}.mjs`, `${target}.cjs`, `${target}.jsx`, `${target}.py`, `${target}.json`, path.posix.join(target, 'index.js'), path.posix.join(target, 'index.ts')]) if (relSet.has(cand)) referenced.add(cand)
          }
        }
        const entryRe = /(^|\/)(index|main|mod|app|cli|server|client|entry|__init__)\.(js|mjs|cjs|ts|py)$|(^|\/)(package\.json|pyproject\.toml|setup\.py|README|test|spec|\.d\.ts$)/i
        const cap = clamp(int(a.limit, 40), 1, 2000)
        const dead = []
        for (const rel2 of relSet.keys()) {
          if (referenced.has(rel2)) continue
          if (!a.includeTests && /test|spec|\.d\.ts$/i.test(rel2)) continue
          if (entryRe.test(rel2)) continue
          if (/\.(json|md|yml|yaml|css|html|toml|sql|svg|png|jpg)$/i.test(rel2)) continue
          dead.push(rel2)
        }
        return { root, scanned: files.length, referenced: referenced.size, suspectedDead: dead.length, files: dead.slice(0, cap), note: '启发式：动态 import、字符串拼路径、插件按名加载都会误报，删前手动确认' }
      },
    },
    {
      name: 'code_todo_scan',
      desc: '扫 TODO / FIXME / HACK / XXX / @todo，按文件列出行号',
      params: {
        path: { type: 'string', desc: '目录，默认工作区' },
        tags: { type: 'array', desc: '要扫的标记，默认 TODO,FIXME,HACK,XXX,Bug,BUG', items: { type: 'string', desc: '一个标记' } },
        maxFiles: { type: 'integer', desc: '最多扫几个，默认 3000' },
        limit: { type: 'integer', desc: '最多几条，默认 60' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const tags = (Array.isArray(a.tags) && a.tags.length ? a.tags : ['TODO', 'FIXME', 'HACK', 'XXX', 'BUG', 'Bug', 'todo']).map((t) => String(t).replace(/[^\w@]/g, ''))
        const re = new RegExp(`(?:^|[^\\w])(?:${tags.join('|')})\\b[:：]?\\s*(.*)`, 'i')
        const files = collectFiles(root, a)
        const rows = []
        for (const f of files) {
          const text = await readStr(f, 300000)
          if (text === null) continue
          let i = 0
          for (const line of splitLines(text)) {
            i++
            const m = line.match(re)
            if (m) rows.push({ file: rel(root, f), line: i, text: m[1].trim().slice(0, 140) || line.trim().slice(0, 140) })
          }
        }
        const byFile = {}
        for (const r of rows) byFile[r.file] = (byFile[r.file] || 0) + 1
        const cap = clamp(int(a.limit, 60), 1, 2000)
        return { root, total: rows.length, files: Object.keys(byFile).length, hottest: Object.entries(byFile).sort((x, y) => y[1] - x[1]).slice(0, 15).map(([k, v]) => `${String(v).padStart(4)}  ${k}`), items: rows.slice(0, cap).map((r) => `${r.file}:${r.line}  ${r.text}`) }
      },
    },
    {
      name: 'code_large_files',
      desc: '最大的源文件（按行数/字节），顺手给每文件函数数与最长行',
      params: {
        path: { type: 'string', desc: '目录，默认工作区' },
        by: { type: 'string', desc: 'lines|bytes，默认 lines', enum: ['lines', 'bytes'] },
        limit: { type: 'integer', desc: '前几名，默认 25' },
        maxFiles: { type: 'integer', desc: '最多扫几个，默认 4000' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const files = collectFiles(root, a)
        const rows = []
        for (const f of files) {
          const text = await readStr(f, 1200000)
          if (text === null) continue
          const lines = splitLines(text)
          let maxLen = 0
          for (const l of lines) if (l.length > maxLen) maxLen = l.length
          rows.push({ file: rel(root, f), lines: lines.length, bytes: Buffer.byteLength(text), symbols: defsFor(extOf(f)).reduce((s, [re]) => s + lines.filter((l) => re.test(l)).length, 0), maxLine: maxLen })
        }
        rows.sort((x, y) => (a.by === 'bytes' ? y.bytes - x.bytes : y.lines - x.lines))
        const cap = clamp(int(a.limit, 25), 1, 500)
        return { root, scanned: rows.length, largest: rows.slice(0, cap).map((r) => `${String(r.lines).padStart(6)} 行 ${fmtBytes(r.bytes).padStart(10)} 符号${String(r.symbols).padStart(4)} 最长行${String(r.maxLine).padStart(6)}  ${r.file}`) }
      },
    },
    {
      name: 'code_long_functions',
      desc: '找过长的函数（按大括号/缩进估算行数），给重构候选',
      params: {
        path: { type: 'string', desc: '目录，默认工作区' },
        minLines: { type: 'integer', desc: '超过多少行算长，默认 80' },
        limit: { type: 'integer', desc: '最多几条，默认 25' },
        maxFiles: { type: 'integer', desc: '最多扫几个，默认 2000' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const min = int(a.minLines, 80)
        const files = collectFiles(root, a)
        const rows = []
        for (const f of files) {
          const ext = extOf(f)
          if (['.json', '.md', '.yml', '.yaml', '.css', '.html', '.sql', '.toml'].includes(ext)) continue
          const text = await readStr(f, 600000)
          if (text === null) continue
          const lines = splitLines(text)
          const rules = defsFor(ext)
          for (let i = 0; i < lines.length; i++) {
            let name = null
            for (const [re] of rules) {
              const m = lines[i].match(re)
              if (m) {
                name = m[1]
                break
              }
            }
            if (!name) continue
            let end = i
            if (['.py', '.pyi'].includes(ext)) {
              const indent = lines[i].match(/^\s*/)[0].length
              for (let j = i + 1; j < lines.length; j++) {
                const l = lines[j]
                if (!l.trim()) continue
                if (l.match(/^\s*/)[0].length <= indent) break
                end = j
              }
            } else {
              let depth = 0
              let started = false
              for (let j = i; j < lines.length; j++) {
                for (const ch of lines[j]) {
                  if (ch === '{') {
                    depth++
                    started = true
                  } else if (ch === '}') depth--
                }
                if (started && depth <= 0) {
                  end = j
                  break
                }
              }
            }
            const len = end - i + 1
            if (len >= min) rows.push({ file: rel(root, f), line: i + 1, name, lines: len })
          }
        }
        rows.sort((x, y) => y.lines - x.lines)
        const cap = clamp(int(a.limit, 25), 1, 300)
        return { root, minLines: min, candidates: rows.length, longest: rows.slice(0, cap).map((r) => `${String(r.lines).padStart(5)} 行  ${r.file}:${r.line}  ${r.name}`), note: '启发式：大括号计数不处理字符串/模板串里的花括号' }
      },
    },
    {
      name: 'code_complexity',
      desc: '粗粒度复杂度：每文件分支/循环/异常/布尔运算计数，排最难的',
      params: {
        path: { type: 'string', desc: '目录，默认工作区' },
        limit: { type: 'integer', desc: '前几名，默认 20' },
        maxFiles: { type: 'integer', desc: '最多扫几个，默认 2000' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const files = collectFiles(root, a)
        const rows = []
        for (const f of files) {
          const ext = extOf(f)
          if (['.json', '.md', '.yml', '.yaml', '.css', '.html', '.sql', '.toml', '.svg'].includes(ext)) continue
          const text = await readStr(f, 600000)
          if (text === null) continue
          const count = (re) => (text.match(re) || []).length
          const branches = count(/\b(if|elif|case|when)\b/g)
          const loops = count(/\b(for|while|loop|foreach)\b/g)
          const catches = count(/\b(catch|except|rescue|finally)\b/g)
          const bools = count(/&&|\|\||\band\b|\bor\b/g)
          const ternary = count(/\?[^.:]*:/g)
          const returns = count(/\breturn\b|\braise\b|\bthrow\b/g)
          const score = branches + loops + 2 * catches + bools + ternary
          rows.push({ file: rel(root, f), lines: splitLines(text).length, branches, loops, catches, bools, ternary, returns, score })
        }
        rows.sort((x, y) => y.score - x.score)
        const cap = clamp(int(a.limit, 20), 1, 300)
        return { root, scanned: rows.length, hardest: rows.slice(0, cap).map((r) => `分${String(r.score).padStart(5)} if${String(r.branches).padStart(4)} 循环${String(r.loops).padStart(4)} catch${String(r.catches).padStart(3)} 布尔${String(r.bools).padStart(4)} ${String(r.lines).padStart(5)}行 ${r.file}`) }
      },
    },
    {
      name: 'code_duplicate_lines',
      desc: '找重复代码块（同一长行出现在多个文件），复制粘贴候选',
      params: {
        path: { type: 'string', desc: '目录，默认工作区' },
        minChars: { type: 'integer', desc: '行最短字符，默认 40' },
        maxFiles: { type: 'integer', desc: '最多扫几个，默认 2000' },
        limit: { type: 'integer', desc: '最多几组，默认 25' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const minChars = int(a.minChars, 40)
        const files = collectFiles(root, a)
        const map = new Map()
        for (const f of files) {
          const text = await readStr(f, 500000)
          if (text === null) continue
          let i = 0
          for (const line of splitLines(text)) {
            i++
            const t2 = line.trim()
            if (t2.length < minChars) continue
            if (/^(import|from|require|\/\/|#|\*|\/\*|\{|\}|\)|\(|<\/)/.test(t2)) continue
            const key = t2.slice(0, 200)
            if (!map.has(key)) map.set(key, [])
            map.get(key).push(`${rel(root, f)}:${i}`)
          }
        }
        const groups = [...map.entries()].filter(([, v]) => v.length >= 3).sort((x, y) => y[1].length - x[1].length)
        const cap = clamp(int(a.limit, 25), 1, 200)
        return { root, scanned: files.length, duplicatedLines: groups.length, groups: groups.slice(0, cap).map(([k, v]) => ({ times: v.length, line: k.slice(0, 120), where: v.slice(0, 6) })) }
      },
    },
    {
      name: 'code_search',
      desc: '跨文件正则搜索（带上下文行），比 grep 更懂代码扩展名',
      params: {
        path: { type: 'string', desc: '目录，默认工作区' },
        pattern: { type: 'string', required: true, desc: '正则（JS 语法）' },
        flags: { type: 'string', desc: '正则 flag，默认 gi' },
        exts: { type: 'array', desc: '限定扩展名，例如 [".js",".ts"]', items: { type: 'string', desc: '一个扩展名' } },
        context: { type: 'integer', desc: '前后各带几行，默认 0' },
        limit: { type: 'integer', desc: '最多几条命中，默认 40' },
        maxFiles: { type: 'integer', desc: '最多扫几个，默认 3000' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        let re
        try {
          re = new RegExp(a.pattern, a.flags || 'gi')
        } catch (e) {
          return json({ ok: false, message: `正则不合法: ${String(e && e.message).slice(0, 200)}` })
        }
        const exts = Array.isArray(a.exts) && a.exts.length ? new Set(a.exts.map((x) => String(x).toLowerCase().replace(/^\./, '.'))) : null
        const files = collectFiles(root, a).filter((f) => !exts || exts.has(extOf(f)))
        const ctxLines = clamp(int(a.context, 0), 0, 5)
        const cap = clamp(int(a.limit, 40), 1, 500)
        const hits = []
        for (const f of files) {
          const text = await readStr(f, 500000)
          if (text === null) continue
          const lines = splitLines(text)
          for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0
            if (!re.test(lines[i])) continue
            const item = { file: rel(root, f), line: i + 1, text: lines[i].trim().slice(0, 200) }
            if (ctxLines > 0) {
              item.before = lines.slice(Math.max(0, i - ctxLines), i).map((l) => l.trim().slice(0, 160))
              item.after = lines.slice(i + 1, i + 1 + ctxLines).map((l) => l.trim().slice(0, 160))
            }
            hits.push(item)
            if (hits.length >= cap) return { root, pattern: a.pattern, hits: hits.length, truncated: true, results: hits.map((h) => `${h.file}:${h.line}  ${h.text}`) }
          }
        }
        return { root, pattern: a.pattern, scanned: files.length, hits: hits.length, results: hits.map((h) => `${h.file}:${h.line}  ${h.text}`) }
      },
    },
    {
      name: 'code_find_symbol',
      desc: '找一个符号的定义处与引用处数量（函数名/类名/常量名）',
      params: {
        path: { type: 'string', desc: '目录，默认工作区' },
        symbol: { type: 'string', required: true, desc: '符号名' },
        limit: { type: 'integer', desc: '最多列几处引用，默认 30' },
        maxFiles: { type: 'integer', desc: '最多扫几个，默认 3000' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const sym = String(a.symbol).trim()
        if (!/^[\w$]+$/.test(sym)) return json({ ok: false, message: '符号名只能是字母数字下划线$' })
        const defRe = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum|def)\\b[^\\w\\n]*\\b${sym}\\b|\\bfunction\\s+${sym}\\b|\\bclass\\s+${sym}\\b`)
        const useRe = new RegExp(`\\b${sym.replace(/\$/g, '\\$')}\\b`)
        const files = collectFiles(root, a)
        const defs = []
        const uses = []
        for (const f of files) {
          const text = await readStr(f, 400000)
          if (text === null) continue
          let i = 0
          for (const line of splitLines(text)) {
            i++
            if (defRe.test(line)) defs.push({ file: rel(root, f), line: i, text: line.trim().slice(0, 160) })
            else if (useRe.test(line)) uses.push({ file: rel(root, f), line: i, text: line.trim().slice(0, 140) })
          }
        }
        const cap = clamp(int(a.limit, 30), 1, 500)
        return { symbol: sym, definitions: defs.length, references: uses.length, definedIn: defs.slice(0, 10).map((d) => `${d.file}:${d.line}  ${d.text}`), referencedIn: [...new Set(uses.map((u) => u.file))].slice(0, cap), samples: uses.slice(0, 12).map((u) => `${u.file}:${u.line}  ${u.text}`) }
      },
    },
    {
      name: 'code_unused_exports',
      desc: '找导出但别处没用的符号（启发式，注意动态调用会误报）',
      params: {
        path: { type: 'string', desc: '目录，默认工作区' },
        limit: { type: 'integer', desc: '最多几条，默认 40' },
        maxFiles: { type: 'integer', desc: '最多扫几个，默认 2500' },
        minUses: { type: 'integer', desc: '引用少于几次算未用，默认 1', },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const files = collectFiles(root, a)
        const corpus = []
        for (const f of files) {
          const text = await readStr(f, 400000)
          if (text === null) continue
          corpus.push({ file: rel(root, f), text, ext: extOf(f) })
        }
        const allText = corpus.map((c) => c.text).join('\n')
        const minUses = Math.max(1, int(a.minUses, 1))
        const cap = clamp(int(a.limit, 40), 1, 1000)
        const out = []
        for (const c of corpus) {
          if (['.json', '.md', '.yml', '.yaml', '.css', '.html', '.sql'].includes(c.ext)) continue
          for (const name of extractExports(c.text, c.ext)) {
            if (name === 'default') continue
            const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')
            const uses = (allText.match(re) || []).length
            if (uses < minUses) out.push({ file: c.file, name, uses })
          }
        }
        return { root, scanned: corpus.length, suspectedUnused: out.length, items: out.slice(0, cap).map((o) => `${o.file}  →  ${o.name} (引用${o.uses})`), note: '启发式：字符串路由名、按名反射调用、外部消费者会误报' }
      },
    },
    {
      name: 'code_package_audit',
      desc: 'package.json 体检：依赖有没有被 import、import 有没有声明、脚本清单',
      params: {
        path: { type: 'string', desc: '项目目录，默认工作区' },
        maxFiles: { type: 'integer', desc: '最多扫几个源文件，默认 3000' },
        limit: { type: 'integer', desc: '每类最多列几个，默认 40' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const pkgFile = path.join(root, 'package.json')
        const raw = await readStr(pkgFile, 400000)
        if (raw === null) return json({ ok: false, message: `没有 ${pkgFile}` })
        let pkg
        try {
          pkg = JSON.parse(raw)
        } catch (e) {
          return json({ ok: false, message: `package.json 解析失败: ${String(e && e.message).slice(0, 200)}` })
        }
        const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {}), ...Object.keys(pkg.peerDependencies || {}), ...Object.keys(pkg.optionalDependencies || {})])
        const used = new Set()
        for (const f of collectFiles(root, a)) {
          const text = await readStr(f, 300000)
          if (text === null) continue
          for (const im of extractImports(text, extOf(f))) {
            const s = im.spec
            if (s.startsWith('.') || s.startsWith('/') || s.startsWith('~')) continue
            const nodeBuiltin = ['fs', 'path', 'os', 'net', 'tls', 'dns', 'http', 'https', 'url', 'util', 'crypto', 'stream', 'buffer', 'events', 'child_process', 'worker_threads', 'node:sqlite', 'assert', 'zlib', 'string_decoder', 'querystring', 'readline', 'timers', 'v8', 'vm', 'perf_hooks', 'process', 'tty', 'module', 'inspector', 'constants', 'dgram', 'cluster', 'sys', 'fs/promises', 'path/posix'].some((b) => s === b || s.startsWith(`${b}/`) || s === `node:${b.slice(4)}` || s.startsWith('node:'))
            if (nodeBuiltin) continue
            used.add(s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0])
          }
        }
        const cap = clamp(int(a.limit, 40), 1, 500)
        const unused = [...declared].filter((d) => !used.has(d) && !used.has(d.split('/')[0]))
        const missing = [...used].filter((u) => !declared.has(u))
        return {
          root,
          name: pkg.name,
          version: pkg.version,
          type: pkg.type,
          main: pkg.main,
          declaredDeps: declared.size,
          usedDeps: used.size,
          scripts: Object.keys(pkg.scripts || {}),
          possiblyUnused: unused.slice(0, cap),
          usedButUndeclared: missing.slice(0, cap),
          engines: pkg.engines,
          dsh: pkg.dsh,
        }
      },
    },
    {
      name: 'code_scripts_list',
      desc: '列 package.json scripts 并标出可跑性（依赖的 CLI 在不在 PATH）',
      params: { path: { type: 'string', desc: '项目目录，默认工作区' }, checkBins: { type: 'boolean', desc: '检查脚本用到的命令是否可用，默认 true' } },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const raw = await readStr(path.join(root, 'package.json'), 400000)
        if (raw === null) return json({ ok: false, message: '没有 package.json' })
        let pkg
        try {
          pkg = JSON.parse(raw)
        } catch (e) {
          return json({ ok: false, message: String(e && e.message).slice(0, 200) })
        }
        const entries = Object.entries(pkg.scripts || {})
        const rows = []
        for (const [name, cmd] of entries) {
          const bins = [...new Set(String(cmd).split(/&&|\|\||;|\|/).map((p) => p.trim().split(/\s+/)[0]).filter((b) => b && !/^[.\/]/.test(b) && !/^(node|npx|pnpm|npm|yarn|echo|cd|set|export|cross-env)$/.test(b)))]
          let missing = []
          if (a.checkBins !== false) {
            for (const b of bins) {
              const r = process.platform === 'win32' ? await ctx.exec('where', [b], { timeoutMs: 8000 }) : await ctx.exec('sh', ['-c', `command -v ${b}`], { timeoutMs: 8000 })
              if (r.code !== 0) missing.push(b)
            }
          }
          rows.push({ name, cmd: String(cmd).slice(0, 160), missingBins: missing })
        }
        return { root, name: pkg.name, count: rows.length, scripts: rows.map((r) => `${r.missingBins.length ? '!' : '✓'} ${r.name.padEnd(18)} ${r.cmd}${r.missingBins.length ? `   [缺: ${r.missingBins.join(',')}]` : ''}`) }
      },
    },
    {
      name: 'code_run_tests',
      desc: '跑测试脚本（默认 npm test），返回退出码与输出尾部',
      write: true,
      params: {
        path: { type: 'string', desc: '项目目录，默认工作区' },
        script: { type: 'string', desc: 'npm script 名，默认 test' },
        pm: { type: 'string', desc: 'pnpm|npm|yarn|bun，默认 pnpm', enum: ['pnpm', 'npm', 'yarn', 'bun'] },
        args: { type: 'string', desc: '附加参数，例如 "-- test/foo.js"' },
        timeoutMs: { type: 'integer', desc: '超时，默认 180000' },
        tailChars: { type: 'integer', desc: '返回输出尾部多少字符，默认 6000' },
        confirm: { type: 'boolean', desc: '会执行代码，传 true 确认' },
      },
      async run(a, ctx) {
        if (a.confirm !== true) return json({ ok: false, message: '跑测试会执行仓库里的代码，传 confirm=true 确认' })
        const root = rootOf(ctx, a)
        const pm = a.pm || 'pnpm'
        const args = [a.script || 'test', ...(a.args ? String(a.args).split(/\s+/).filter(Boolean) : [])]
        const t0 = Date.now()
        const r = await ctx.exec(pm, args, { cwd: root, timeoutMs: clamp(int(a.timeoutMs, 180000), 5000, 900000) })
        const out = `${String(r.stdout)}\n${String(r.stderr)}`
        const tail = out.slice(-clamp(int(a.tailChars, 6000), 500, 60000))
        const failed = /FAIL|failed|Error:|✕|not ok|AssertionError/i.test(out)
        return { command: `${pm} ${args.join(' ')}`, cwd: root, code: r.code, timedOut: r.timedOut, ms: Date.now() - t0, passed: r.code === 0 && !failed, summary: (out.match(/\d+ (?:tests?|passing|failing)[^\n]*/gi) || []).slice(0, 8), outputTail: tail }
      },
    },
    {
      name: 'code_typecheck',
      desc: '跑 TypeScript 类型检查（tsc --noEmit），按文件汇总报错',
      write: true,
      params: {
        path: { type: 'string', desc: '项目目录，默认工作区' },
        timeoutMs: { type: 'integer', desc: '超时，默认 240000' },
        limit: { type: 'integer', desc: '最多列几条错误，默认 40' },
        confirm: { type: 'boolean', desc: '会执行 tsc，传 true 确认' },
      },
      async run(a, ctx) {
        if (a.confirm !== true) return json({ ok: false, message: '类型检查会执行 tsc，传 confirm=true 确认' })
        const root = rootOf(ctx, a)
        const r = await ctx.exec('npx', ['tsc', '--noEmit', '--pretty', 'false'], { cwd: root, timeoutMs: clamp(int(a.timeoutMs, 240000), 10000, 900000) })
        const out = `${String(r.stdout)}\n${String(r.stderr)}`
        const errs = [...out.matchAll(/^(.+?)\((\d+),(\d+)\):\s*error\s*(TS\d+):\s*(.+)$/gm)].map((m) => ({ file: m[1].replace(root, '.').replace(/\\/g, '/'), line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5].slice(0, 200) }))
        const byFile = {}
        for (const e of errs) byFile[e.file] = (byFile[e.file] || 0) + 1
        const byCode = {}
        for (const e of errs) byCode[e.code] = (byCode[e.code] || 0) + 1
        const cap = clamp(int(a.limit, 40), 1, 500)
        return { cwd: root, code: r.code, errors: errs.length, byFile: Object.entries(byFile).sort((x, y) => y[1] - x[1]).slice(0, 20).map(([k, v]) => `${String(v).padStart(4)} ${k}`), byCode: Object.entries(byCode).sort((x, y) => y[1] - x[1]).slice(0, 15).map(([k, v]) => `${String(v).padStart(4)} ${k}`), items: errs.slice(0, cap).map((e) => `${e.file}:${e.line}:${e.col} ${e.code} ${e.message}`), noTsconfig: /error TS5058|not found/i.test(out) ? '没找到 tsconfig.json' : null }
      },
    },
    {
      name: 'code_lint',
      desc: '跑 ESLint（或仓库里现成的 lint 脚本），按规则汇总',
      write: true,
      params: {
        path: { type: 'string', desc: '项目目录，默认工作区' },
        target: { type: 'string', desc: '要检的路径，默认 src' },
        fix: { type: 'boolean', desc: '加 --fix（会改文件）' },
        timeoutMs: { type: 'integer', desc: '超时，默认 180000' },
        limit: { type: 'integer', desc: '最多几条，默认 40' },
        confirm: { type: 'boolean', desc: '会执行 lint，传 true 确认' },
      },
      async run(a, ctx) {
        if (a.confirm !== true) return json({ ok: false, message: 'lint 会执行仓库配置（插件可能任意执行），传 confirm=true 确认' })
        const root = rootOf(ctx, a)
        const args = ['eslint', a.target || 'src', '--format', 'compact', ...(a.fix ? ['--fix'] : [])]
        const r = await ctx.exec('npx', args, { cwd: root, timeoutMs: clamp(int(a.timeoutMs, 180000), 5000, 900000) })
        const out = `${String(r.stdout)}\n${String(r.stderr)}`
        const rows = [...out.matchAll(/^(.+?)\s*line\s*(\d+),?\s*col\s*(\d+),?\s*(Error|Warning|error|warning)\s*-\s*(.+?)(?:\s*\(([\w/:@-]+)\))?$/gm)].map((m) => ({ file: m[1].replace(root, '.').replace(/\\/g, '/'), line: Number(m[2]), level: m[4].toLowerCase(), message: m[5].slice(0, 160), rule: m[6] || null }))
        const byRule = {}
        for (const x of rows) if (x.rule) byRule[x.rule] = (byRule[x.rule] || 0) + 1
        const cap = clamp(int(a.limit, 40), 1, 500)
        return { cwd: root, command: `npx ${args.join(' ')}`, code: r.code, issues: rows.length, errors: rows.filter((x) => x.level.startsWith('e')).length, warnings: rows.filter((x) => x.level.startsWith('w')).length, byRule: Object.entries(byRule).sort((x, y) => y[1] - x[1]).slice(0, 20).map(([k, v]) => `${String(v).padStart(4)} ${k}`), items: rows.slice(0, cap).map((x) => `${x.file}:${x.line} [${x.level}] ${x.message}${x.rule ? ` (${x.rule})` : ''}`), raw: rows.length ? undefined : out.slice(0, 3000) }
      },
    },
    {
      name: 'code_bundle_size',
      desc: '产物体积：dist/build/out 目录大小与最大文件，看有没有夹带',
      params: {
        path: { type: 'string', desc: '项目目录，默认工作区' },
        dirs: { type: 'array', desc: '要看的目录，默认 dist build out .next/static coverage', items: { type: 'string', desc: '一个目录' } },
        limit: { type: 'integer', desc: '每目录列几个大文件，默认 12' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const dirs = Array.isArray(a.dirs) && a.dirs.length ? a.dirs : ['dist', 'build', 'out', '.next/static', 'coverage', 'node_modules/.cache']
        const cap = clamp(int(a.limit, 12), 1, 200)
        const out = []
        for (const d of dirs) {
          const abs = path.join(root, d)
          if (!fs.existsSync(abs)) {
            out.push({ dir: d, exists: false })
            continue
          }
          const files = walkFiles(abs, { maxDepth: 10, maxFiles: 30000, skip: /(^|[\\/])\.git([\\/]|$)/ })
          let bytes = 0
          const rows = []
          for (const f of files) {
            try {
              const st = fs.statSync(f)
              bytes += st.size
              rows.push({ f: path.relative(abs, f).replace(/\\/g, '/'), size: st.size })
            } catch (e) {}
          }
          rows.sort((x, y) => y.size - x.size)
          const byExt = {}
          for (const r of rows) {
            const e = extOf(r.f)
            byExt[e] = (byExt[e] || 0) + r.size
          }
          out.push({ dir: d, exists: true, files: rows.length, total: fmtBytes(bytes), largest: rows.slice(0, cap).map((r) => `${fmtBytes(r.size).padStart(10)}  ${r.f}`), byExtension: Object.entries(byExt).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${fmtBytes(v).padStart(10)} ${k}`) })
        }
        return { root, scanned: out.length, dirs: out }
      },
    },
    {
      name: 'code_file_metrics',
      desc: '单文件指标：行数/代码/注释/最长行/函数数/圈复杂度/依赖数',
      params: { file: { type: 'string', required: true, desc: '文件路径' } },
      async run(a, ctx) {
        const abs = ctx.resolve(a.file)
        const text = await readStr(abs, 2000000)
        if (text === null) return json({ ok: false, message: `读不到文件: ${abs}` })
        const ext = extOf(abs)
        const lines = splitLines(text)
        let code = 0
        let comment = 0
        let blank = 0
        let maxLen = 0
        let longLines = 0
        for (const l of lines) {
          if (!l.trim()) blank++
          else if (isComment(l, ext)) comment++
          else code++
          if (l.length > maxLen) maxLen = l.length
          if (l.length > 120) longLines++
        }
        const count = (re) => (text.match(re) || []).length
        const complexity = count(/\b(if|elif|case|when)\b/g) + count(/\b(for|while|loop)\b/g) + 2 * count(/\b(catch|except|rescue|finally)\b/g) + count(/&&|\|\|/g) + count(/\?[^.:]*:/g)
        return {
          file: a.file,
          bytes: fmtBytes(Buffer.byteLength(text)),
          lines: lines.length,
          code,
          comment,
          blank,
          commentPercent: lines.length ? Number((100 * comment / lines.length).toFixed(1)) : 0,
          maxLineLength: maxLen,
          linesOver120: longLines,
          symbols: defsFor(ext).reduce((s, [re]) => s + lines.filter((l) => re.test(l)).length, 0),
          imports: extractImports(text, ext).length,
          exports: extractExports(text, ext).length,
          complexity,
          todos: count(/\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b/gi),
          cjkLines: lines.filter((l) => /[\u4e00-\u9fff]/.test(l)).length,
          tabs: lines.filter((l) => l.includes('\t')).length,
          trailingSpace: lines.filter((l) => /\s$/.test(l)).length,
          crlf: /\r\n/.test(text),
          endsWithNewline: text.endsWith('\n'),
        }
      },
    },
    {
      name: 'code_npm_outdated',
      desc: '查依赖更新（pnpm outdated / npm outdated），按落后程度列',
      params: {
        path: { type: 'string', desc: '项目目录，默认工作区' },
        pm: { type: 'string', desc: 'pnpm|npm，默认 pnpm', enum: ['pnpm', 'npm'] },
        timeoutMs: { type: 'integer', desc: '超时，默认 120000' },
        limit: { type: 'integer', desc: '最多几条，默认 40' },
        confirm: { type: 'boolean', desc: '会联网查包，传 true 确认' },
      },
      async run(a, ctx) {
        if (a.confirm !== true) return json({ ok: false, message: '要联网查包版本，传 confirm=true 确认' })
        const root = rootOf(ctx, a)
        const pm = a.pm || 'pnpm'
        const r = await ctx.exec(pm, ['outdated', '--format', pm === 'pnpm' ? 'json' : 'json'], { cwd: root, timeoutMs: clamp(int(a.timeoutMs, 120000), 5000, 600000) })
        const txt = String(r.stdout).trim()
        if (!txt) return { cwd: root, command: `${pm} outdated`, code: r.code, outdated: 0, note: String(r.stderr).slice(0, 300) || '没有可更新的依赖（或命令失败）' }
        let data
        try {
          data = JSON.parse(txt)
        } catch (e) {
          return { cwd: root, raw: txt.slice(0, 4000) }
        }
        const entries = Object.entries(data)
        const cap = clamp(int(a.limit, 40), 1, 500)
        return { cwd: root, command: `${pm} outdated`, outdated: entries.length, packages: entries.slice(0, cap).map(([name, v]) => `${String(name).padEnd(34)} ${String(v.current || '?').padEnd(14)} → ${String(v.wanted || '?').padEnd(14)} latest ${String(v.latest || '?').padEnd(14)}${v.dependentType ? ` (${v.dependentType})` : ''}`) }
      },
    },
    {
      name: 'code_lock_audit',
      desc: '锁文件体检：pnpm-lock/package-lock 版本、依赖数、重复版本、可疑源',
      params: { path: { type: 'string', desc: '项目目录，默认工作区' }, limit: { type: 'integer', desc: '最多列几条，默认 25' } },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const out = { root }
        const cap = clamp(int(a.limit, 25), 1, 300)
        const lockPnpm = path.join(root, 'pnpm-lock.yaml')
        const lockNpm = path.join(root, 'package-lock.json')
        const lockYarn = path.join(root, 'yarn.lock')
        if (fs.existsSync(lockPnpm)) {
          const t = await readStr(lockPnpm, 4000000)
          const versions = [...t.matchAll(/\n  \/([^@\s]+)@([0-9][^\s(]*):/g)].map((m) => ({ name: m[1], version: m[2] }))
          const tarballs = [...t.matchAll(/tarball\s+'?([^'\s]+)/g)].map((m) => m[1])
          const byName = {}
          for (const v of versions) byName[v.name] = (byName[v.name] || 0) + 1
          out.pnpmLock = { lockfileVersion: (t.match(/^lockfileVersion:\s*([\d.]+)/m) || [])[1], packages: versions.length, uniquePackages: Object.keys(byName).length, duplicated: Object.entries(byName).filter(([, n]) => n > 1).slice(0, cap).map(([k, n]) => `${n} 个版本  ${k}`), registries: [...new Set(tarballs.map((u) => {
            try {
              return new URL(u).host
            } catch (e) {
              return u.slice(0, 40)
            }
          }))].slice(0, 10) }
        }
        if (fs.existsSync(lockNpm)) {
          try {
            const j = JSON.parse(await readStr(lockNpm, 8000000))
            const pkgs = j.packages || {}
            const names = {}
            let http = 0
            for (const [k, v] of Object.entries(pkgs)) {
              const nm = k.replace(/^node_modules\//, '')
              if (nm) names[nm] = (names[nm] || 0) + 1
              if (v && v.resolved && /^http:\/\//.test(v.resolved)) http++
            }
            out.npmLock = { lockfileVersion: j.lockfileVersion, packages: Object.keys(pkgs).length, duplicated: Object.entries(names).filter(([, n]) => n > 1).slice(0, cap).map(([k, n]) => `${n} 份  ${k}`), insecureResolved: http }
          } catch (e) {
            out.npmLock = { note: String(e && e.message).slice(0, 120) }
          }
        }
        if (fs.existsSync(lockYarn)) out.yarnLock = { exists: true, size: fmtBytes(fs.statSync(lockYarn).size) }
        if (!out.pnpmLock && !out.npmLock && !out.yarnLock) return json({ ok: false, message: `${root} 没有 pnpm-lock.yaml / package-lock.json / yarn.lock` })
        return out
      },
    },
    {
      name: 'code_licenses',
      desc: '汇总依赖许可证（扫 node_modules 的 LICENSE/package.json），看有没有传染性协议',
      params: {
        path: { type: 'string', desc: '项目目录，默认工作区' },
        limit: { type: 'integer', desc: '最多列几个包，默认 40' },
        showCopyleft: { type: 'boolean', desc: '单独列出 GPL/AGPL/LGPL，默认 true' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const nm = path.join(root, 'node_modules')
        if (!fs.existsSync(nm)) return json({ ok: false, message: `没有 ${nm}` })
        const cap = clamp(int(a.limit, 40), 1, 2000)
        const dirs = []
        for (const entry of fs.readdirSync(nm, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue
          if (entry.name.startsWith('@')) {
            try {
              for (const sub of fs.readdirSync(path.join(nm, entry.name), { withFileTypes: true })) dirs.push(`${entry.name}/${sub.name}`)
            } catch (e) {}
          } else dirs.push(entry.name)
        }
        const lic = {}
        const rows = []
        for (const d of dirs) {
          const pj = path.join(nm, d, 'package.json')
          let license = null
          try {
            const j = JSON.parse(await readStr(pj, 200000))
            license = typeof j.license === 'string' ? j.license : j.license && j.license.type || null
          } catch (e) {}
          if (!license) {
            for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) {
              const p = path.join(nm, d, f)
              if (fs.existsSync(p)) {
                const head = (await readStr(p, 2000)) || ''
                license = /GNU AFFERO|AGPL/i.test(head) ? 'AGPL-3.0' : /GNU GENERAL PUBLIC|GPL-?3/i.test(head) ? 'GPL-3.0' : /GNU LESSER|LGPL/i.test(head) ? 'LGPL' : /Apache License/i.test(head) ? 'Apache-2.0' : /MIT License/i.test(head) ? 'MIT' : /BSD[\s-]*[23]/i.test(head) ? 'BSD' : /Mozilla Public/i.test(head) ? 'MPL-2.0' : 'UNKNOWN'
                break
              }
            }
          }
          license = license || 'NONE'
          lic[license] = (lic[license] || 0) + 1
          rows.push({ pkg: d, license })
        }
        const copyleft = a.showCopyleft !== false ? rows.filter((r) => /GPL|AGPL|LGPL|GPL/i.test(r.license)).map((r) => `${r.license.padEnd(12)} ${r.pkg}`) : []
        return { root, packages: dirs.length, byLicense: Object.entries(lic).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${String(v).padStart(5)} ${k}`), copyleft, sample: rows.slice(0, cap).map((r) => `${String(r.license).padEnd(14)} ${r.pkg}`) }
      },
    },
    {
      name: 'code_git_touchers',
      desc: '谁改过这个文件/目录（git log 汇总作者与最近改动时间）',
      params: {
        path: { type: 'string', desc: '仓库目录，默认工作区' },
        target: { type: 'string', required: true, desc: '文件或目录（仓库内相对路径）' },
        limit: { type: 'integer', desc: '最近几个提交，默认 20' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const cap = clamp(int(a.limit, 20), 1, 300)
        const r = await ctx.exec('git', ['log', `-${cap}`, '--pretty=%h|%ad|%an|%s', '--date=short', '--', String(a.target)], { cwd: root, timeoutMs: 60000 })
        if (r.code !== 0) return json({ ok: false, message: String(r.stderr).slice(0, 240) })
        const rows = String(r.stdout).split(/\r?\n/).filter((l) => l.trim()).map((l) => {
          const [h, d, an, ...rest] = l.split('|')
          return { hash: h, date: d, author: an, subject: rest.join('|') }
        })
        const byAuthor = {}
        for (const x of rows) byAuthor[x.author] = (byAuthor[x.author] || 0) + 1
        return { target: a.target, commits: rows.length, byAuthor: Object.entries(byAuthor).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${String(v).padStart(4)} ${k}`), recent: rows.map((x) => `${x.date} ${x.hash} ${x.author.padEnd(14)} ${x.subject.slice(0, 90)}`) }
      },
    },
    {
      name: 'code_project_shape',
      desc: '项目画像：语言构成、目录规模、测试覆盖情况、配置清单',
      params: {
        path: { type: 'string', desc: '项目目录，默认工作区' },
        maxFiles: { type: 'integer', desc: '最多扫几个，默认 4000' },
      },
      async run(a, ctx) {
        const root = rootOf(ctx, a)
        const files = collectFiles(root, a)
        const langBytes = {}
        const dirBytes = {}
        let tests = 0
        let srcFiles = 0
        for (const f of files) {
          let size = 0
          try {
            size = fs.statSync(f).size
          } catch (e) {
            continue
          }
          const e = extOf(f)
          langBytes[e] = (langBytes[e] || 0) + size
          const top = rel(root, f).split('/')[0]
          dirBytes[top] = (dirBytes[top] || 0) + size
          if (/test|spec|__tests__/i.test(rel(root, f))) tests++
          else srcFiles++
        }
        const configs = ['package.json', 'tsconfig.json', 'jsconfig.json', 'eslint.config.js', '.eslintrc', '.eslintrc.js', '.eslintrc.json', 'biome.json', 'prettier.config.js', '.prettierrc', 'vite.config.ts', 'vitest.config.ts', 'jest.config.js', 'pyproject.toml', 'setup.py', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Makefile', 'Dockerfile', 'docker-compose.yml', '.github', '.gitignore', 'README.md', 'LICENSE']
        const present = configs.filter((c) => fs.existsSync(path.join(root, c)))
        const totalBytes = Object.values(langBytes).reduce((s, v) => s + v, 0)
        return {
          root,
          files: files.length,
          totalSize: fmtBytes(totalBytes),
          sourceFiles: srcFiles,
          testFiles: tests,
          testRatio: files.length ? `${Number((100 * tests / files.length).toFixed(1))}%` : '0%',
          languages: Object.entries(langBytes).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => `${fmtBytes(v).padStart(10)} ${String(Number((100 * v / Math.max(1, totalBytes))).toFixed(1)).padStart(5)}% ${k}`),
          topDirs: Object.entries(dirBytes).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => `${fmtBytes(v).padStart(10)} ${k}`),
          configsPresent: present,
          configsMissing: configs.filter((c) => !present.includes(c) && ['tsconfig.json', 'eslint.config.js', '.gitignore', 'README.md', 'LICENSE'].includes(c)),
        }
      },
    },
  ],
}
