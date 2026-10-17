// SQLite 查询包：给记忆栈（engram / knowledge / knowledge-base）和任意 .sqlite/.db
// 做体检、查表、跑只读 SELECT、FTS5 检索、导出。写操作要显式 confirm。
// node:sqlite 不可用时全部降级为"只报文件信息"，不抛异常。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { json, int, clamp, fmtBytes, ensureDir, walkFiles } from '../util.js'

const SAFE_READ = /^\s*(select|with|pragma|explain)\b/i
const WRITE_KIND = /^\s*(insert|update|delete|create|drop|alter|vacuum|reindex|analyze|replace)\b/i

function replacer(_k, v) {
  if (typeof v === 'bigint') return String(v)
  if (Buffer.isBuffer(v)) return `<Buffer ${v.length}B>`
  return v
}

function stringifyRows(rows, maxChars = 4000) {
  const s = JSON.stringify(rows, replacer)
  return s && s.length > maxChars ? `${s.slice(0, maxChars)}…[截断 ${s.length - maxChars} 字符]` : s
}

async function openDb(file, readOnly = true) {
  const { DatabaseSync } = await import('node:sqlite').catch(() => ({}))
  if (!DatabaseSync) return { error: '本机 Node 没有 node:sqlite（需要 Node 22.5+，DSH 自带 24 有）' }
  try {
    const db = new DatabaseSync(file, readOnly ? { readOnly: true, open: true } : { open: true })
    return { db, DatabaseSync }
  } catch (e) {
    return { error: `打不开库: ${String(e && e.message).slice(0, 160)}` }
  }
}

function dshHome() {
  return process.env.DSH_HOME_DIR || path.join(os.homedir(), '.dsh')
}

function knownDbs() {
  return [
    { layer: 'engram 记忆', dir: path.join(dshHome(), 'engram'), patterns: [/\.db$/i] },
    { layer: 'knowledge 提炼', dir: path.join(dshHome(), 'knowledge'), patterns: [/\.sqlite$/i, /\.db$/i] },
    { layer: 'knowledge-base 语料', dir: path.join(dshHome(), 'knowledge-base'), patterns: [/\.sqlite$/i, /\.db$/i] },
    { layer: 'storages 会话', dir: path.join(dshHome(), 'storages'), patterns: [/\.sqlite$/i, /\.db$/i] },
  ]
}

function findDbFile(ctx, hint) {
  if (!hint) return null
  const raw = String(hint).trim()
  const abs = path.isAbsolute(raw) ? raw : ctx.resolve(raw)
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs
  // 按层名找：engram / knowledge / kb / knowledge-base / storages
  const key = raw.toLowerCase()
  const alias = { engram: 'engram', knowledge: 'knowledge', kb: 'knowledge-base', 'knowledge-base': 'knowledge-base', storages: 'storages', sessions: 'sessions' }
  const dirName = alias[key]
  if (dirName) {
    const dir = path.join(dshHome(), dirName)
    try {
      const files = fs.readdirSync(dir).filter((f) => /\.(db|sqlite|sqlite3)$/i.test(f)).map((f) => ({ f, s: fs.statSync(path.join(dir, f)).size })).sort((x, y) => y.s - x.s)
      if (files.length) return path.join(dir, files[0].f)
    } catch (e) {}
  }
  // 按文件名在各层里搜
  for (const layer of knownDbs()) {
    try {
      for (const f of fs.readdirSync(layer.dir)) {
        if (f.toLowerCase() === key || f.toLowerCase() === `${key}.db` || f.toLowerCase() === `${key}.sqlite`) return path.join(layer.dir, f)
      }
    } catch (e) {}
  }
  return abs
}

function tableNames(db) {
  return db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name)
}

export default {
  id: 'db',
  title: 'SQLite 查询',
  tags: ['sqlite', 'database', 'fts', 'memory', 'query'],
  summary: '记忆栈库体检、列表与结构、只读 SELECT、FTS5 检索、导出 JSON/CSV、完整性检查',
  tools: [
    {
      name: 'db_sqlite_available',
      desc: '确认本机能不能用 node:sqlite，并列出记忆栈里的库文件',
      params: {},
      async run() {
        const { DatabaseSync } = await import('node:sqlite').catch(() => ({}))
        const layers = []
        for (const layer of knownDbs()) {
          const dbs = []
          try {
            for (const f of fs.readdirSync(layer.dir)) {
              if (!/\.(db|sqlite|sqlite3)$/i.test(f)) continue
              try {
                const st = fs.statSync(path.join(layer.dir, f))
                dbs.push({ file: f, size: fmtBytes(st.size), mtime: new Date(st.mtimeMs).toISOString() })
              } catch (e) {}
            }
          } catch (e) {
            dbs.push({ note: `目录不存在: ${layer.dir}` })
          }
          layers.push({ layer: layer.layer, dir: layer.dir, databases: dbs })
        }
        return { node: process.version, nodeSqlite: !!DatabaseSync, howToOpen: DatabaseSync ? "new DatabaseSync(file, { readOnly: true })" : '需要 Node 22.5+', layers }
      },
    },
    {
      name: 'db_scan_files',
      desc: '扫目录找 SQLite 库（含大小、魔数校验、表数量）',
      params: {
        path: { type: 'string', desc: '扫描根，默认 ~/.dsh' },
        depth: { type: 'integer', desc: '最大层数，默认 4' },
        limit: { type: 'integer', desc: '最多几个库，默认 60' },
        countTables: { type: 'boolean', desc: '打开数一下表，默认 true' },
      },
      async run(a, ctx) {
        const root = a.path ? ctx.resolve(a.path) : dshHome()
        const files = walkFiles(root, { maxDepth: clamp(int(a.depth, 4), 1, 10), maxFiles: 40000 }).filter((f) => /\.(db|sqlite|sqlite3)$/i.test(f))
        const cap = clamp(int(a.limit, 60), 1, 1000)
        const out = []
        for (const f of files) {
          try {
            const st = await fs.promises.stat(f)
            const fd = await fs.promises.open(f, 'r')
            const head = Buffer.alloc(16)
            await fd.read(head, 0, 16, 0)
            await fd.close()
            const magic = head.toString('latin1', 0, 15) === 'SQLite format 3'
            const row = { file: path.relative(root, f), size: fmtBytes(st.size), mtime: new Date(st.mtimeMs).toISOString(), validSqlite: magic }
            if (magic && a.countTables !== false) {
              const { db } = await openDb(f)
              if (db) {
                try {
                  row.tables = tableNames(db).length
                } catch (e) {
                  row.note = String(e && e.message).slice(0, 80)
                } finally {
                  db.close()
                }
              }
            }
            out.push(row)
          } catch (e) {}
          if (out.length >= cap) break
        }
        out.sort((x, y) => (parseInt(y.size) || 0) - (parseInt(x.size) || 0))
        return { root, found: out.length, databases: out.map((r) => `${r.size.padStart(10)} ${r.validSqlite ? '✓' : 'x'} tables=${r.tables === undefined ? '?' : String(r.tables).padStart(3)}  ${r.file}`) }
      },
    },
    {
      name: 'db_tables',
      desc: '列表：表名、行数、列数（记忆栈库直接传 engram / kb / knowledge）',
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名（engram/knowledge/kb/storages）' },
        limit: { type: 'integer', desc: '最多几张表，默认 60' },
        withCounts: { type: 'boolean', desc: '数每张表的行数，默认 true' },
      },
      async run(a, ctx) {
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const { db } = await openDb(file)
        if (!db) return json({ ok: false, file, message: '打不开（可能被 DSH 占用或不是 sqlite）' })
        try {
          const names = tableNames(db)
          const cap = clamp(int(a.limit, 60), 1, 500)
          const rows = []
          for (const t of names) {
            const row = { table: t }
            if (a.withCounts !== false) {
              try {
                row.rows = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${t.replace(/"/g, '""')}"`).get().c)
              } catch (e) {
                row.rows = null
              }
            }
            try {
              row.columns = db.prepare(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).all().length
            } catch (e) {}
            rows.push(row)
          }
          return { file, size: fmtBytes(fs.statSync(file).size), tableCount: names.length, tables: rows.slice(0, cap).map((r) => `${String(r.rows === null ? '?' : r.rows).padStart(9)} 行 ${String(r.columns).padStart(3)} 列  ${r.table}`) }
        } finally {
          db.close()
        }
      },
    },
    {
      name: 'db_schema',
      desc: '看库结构：建表语句、索引、触发器、视图',
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名' },
        table: { type: 'string', desc: '只看这张表' },
        limit: { type: 'integer', desc: '最多几条 DDL，默认 40' },
      },
      async run(a, ctx) {
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const { db } = await openDb(file)
        if (!db) return json({ ok: false, message: '打不开库' })
        try {
          const sql = a.table ? `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name = ?` : `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name`
          const rows = db.prepare(sql).all(...(a.table ? [a.table] : []))
          const cap = clamp(int(a.limit, 40), 1, 500)
          return {
            file,
            count: rows.length,
            ddl: rows.slice(0, cap).map((r) => `-- ${r.type}: ${r.name}\n${String(r.sql).replace(/,\s*/g, ',\n  ').slice(0, 1500)}`),
            ftsTables: rows.filter((r) => /fts/i.test(String(r.sql))).map((r) => r.name),
          }
        } finally {
          db.close()
        }
      },
    },
    {
      name: 'db_query',
      desc: '跑只读 SQL（select/with/pragma/explain），返回行与耗时',
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名' },
        sql: { type: 'string', required: true, desc: 'SQL，参数用 ? 占位' },
        params: { type: 'array', desc: '按顺序填 ? 的值（JSON 文本数组）', items: { type: 'string', desc: '一个值' } },
        limit: { type: 'integer', desc: '最多返回几行，默认 50' },
        asTable: { type: 'boolean', desc: '按列对齐输出，默认 false（JSON）' },
      },
      async run(a, ctx) {
        if (!SAFE_READ.test(a.sql)) return json({ ok: false, message: '这个工具只跑只读语句（select/with/pragma/explain）。写操作用 db_exec' })
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const { db } = await openDb(file)
        if (!db) return json({ ok: false, message: '打不开库' })
        try {
          let args = []
          if (Array.isArray(a.params)) args = a.params
          else if (typeof a.params === 'string' && a.params.trim()) {
            try {
              args = JSON.parse(a.params)
            } catch (e) {
              args = [a.params]
            }
          }
          const cap = clamp(int(a.limit, 50), 1, 5000)
          const t0 = Date.now()
          const rows = db.prepare(String(a.sql)).all(...args)
          const ms = Date.now() - t0
          const shown = rows.slice(0, cap)
          if (a.asTable && shown.length && typeof shown[0] === 'object') {
            const cols = Object.keys(shown[0])
            return { file, ms, total: rows.length, table: [cols.join(' | '), ...shown.map((r) => cols.map((c) => String(r[c] === undefined ? '' : r[c]).replace(/\r?\n/g, ' ').slice(0, 60)).join(' | '))] }
          }
          return { file, ms, total: rows.length, rows: JSON.parse(stringifyRows(shown, 12000) || '[]') || stringifyRows(shown, 12000) }
        } catch (e) {
          return json({ ok: false, code: 'sql_error', message: String(e && e.message).slice(0, 400), sql: String(a.sql).slice(0, 300) })
        } finally {
          db.close()
        }
      },
    },
    {
      name: 'db_table_info',
      desc: '单表详情：列与类型、行数、索引、外键、样例行',
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名' },
        table: { type: 'string', required: true, desc: '表名' },
        sample: { type: 'integer', desc: '抽几行样例，默认 3' },
      },
      async run(a, ctx) {
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const { db } = await openDb(file)
        if (!db) return json({ ok: false, message: '打不开库' })
        try {
          const t = String(a.table).replace(/"/g, '""')
          const cols = db.prepare(`PRAGMA table_info("${t}")`).all()
          if (!cols.length) return json({ ok: false, message: `没有表 ${a.table}`, tables: tableNames(db).slice(0, 40) })
          const rows = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c)
          const indexes = db.prepare(`PRAGMA index_list("${t}")`).all()
          const fks = db.prepare(`PRAGMA foreign_key_list("${t}")`).all()
          const out = { file, table: a.table, rows, columns: cols.map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PK' : ''}${c.dflt_value ? ` DEFAULT ${c.dflt_value}` : ''}`), indexes: indexes.map((i) => `${i.name}${i.unique ? ' UNIQUE' : ''}`), foreignKeys: fks.map((f) => `${f.from} → ${f.table}.${f.to}`) }
          const n = int(a.sample, 3)
          if (n > 0) {
            try {
              out.sample = JSON.parse(stringifyRows(db.prepare(`SELECT * FROM "${t}" LIMIT ${clamp(n, 1, 50)}`).all(), 4000))
            } catch (e) {}
          }
          return out
        } finally {
          db.close()
        }
      },
    },
    {
      name: 'db_search_rows',
      desc: '在表的文本列里做 LIKE 搜索（自动找文本列），返回命中行',
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名' },
        table: { type: 'string', required: true, desc: '表名' },
        query: { type: 'string', required: true, desc: '关键词（子串）' },
        columns: { type: 'array', desc: '只搜这些列；不给自动挑文本列', items: { type: 'string', desc: '列名' } },
        limit: { type: 'integer', desc: '最多几行，默认 20' },
        orderBy: { type: 'string', desc: '排序列（倒序），例如 id / created_at' },
      },
      async run(a, ctx) {
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const { db } = await openDb(file)
        if (!db) return json({ ok: false, message: '打不开库' })
        try {
          const t = String(a.table).replace(/"/g, '""')
          const cols = db.prepare(`PRAGMA table_info("${t}")`).all()
          if (!cols.length) return json({ ok: false, message: `没有表 ${a.table}`, tables: tableNames(db).slice(0, 40) })
          const textCols = (Array.isArray(a.columns) && a.columns.length ? a.columns : cols.filter((c) => /text|char|varchar|clob|blob|$/i.test(String(c.type).toLowerCase()) || !String(c.type)).map((c) => c.name)).map((c) => String(c).replace(/"/g, '""'))
          const cap = clamp(int(a.limit, 20), 1, 500)
          const where = textCols.map((c) => `"${c}" LIKE ?`).join(' OR ')
          const order = a.orderBy && cols.some((c) => c.name === a.orderBy) ? ` ORDER BY "${String(a.orderBy).replace(/"/g, '""')}" DESC` : ''
          const sql = `SELECT * FROM "${t}"${where ? ` WHERE ${where}` : ''}${order} LIMIT ${cap}`
          const rows = db.prepare(sql).all(...textCols.map(() => `%${a.query}%`))
          return { file, table: a.table, searchedColumns: textCols, query: a.query, hits: rows.length, rows: JSON.parse(stringifyRows(rows, 10000)) }
        } catch (e) {
          return json({ ok: false, message: String(e && e.message).slice(0, 300) })
        } finally {
          db.close()
        }
      },
    },
    {
      name: 'db_fts_search',
      desc: 'FTS5 全文检索（自动找 fts 虚表），返回命中与片段',
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名，例如 kb / knowledge-base' },
        query: { type: 'string', required: true, desc: 'FTS 查询串（支持 中文 trigram 子串、AND/OR、引号短语）' },
        table: { type: 'string', desc: '指定 FTS 表；不给自动找' },
        limit: { type: 'integer', desc: '最多几条，默认 15' },
        snippetChars: { type: 'integer', desc: '片段最长字符，默认 240' },
      },
      async run(a, ctx) {
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const { db } = await openDb(file)
        if (!db) return json({ ok: false, message: '打不开库' })
        try {
          let tables = []
          if (a.table) tables = [a.table]
          else {
            const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'").all()
            tables = rows.map((r) => r.name)
            if (!tables.length) tables = tableNames(db).filter((t) => /fts|search|index/i.test(t))
          }
          if (!tables.length) return json({ ok: false, message: '这个库里没找到 FTS5 虚表', tables: tableNames(db).slice(0, 30) })
          const cap = clamp(int(a.limit, 15), 1, 200)
          const snip = clamp(int(a.snippetChars, 240), 40, 4000)
          const out = []
          for (const t of tables) {
            const safe = String(t).replace(/"/g, '""')
            try {
              const cols = db.prepare(`PRAGMA table_info("${safe}")`).all().map((c) => c.name)
              const textCol = cols.find((c) => /content|text|body|content|chunk|value|title/i.test(c)) || cols[0]
              const sql = `SELECT rowid, * FROM "${safe}" WHERE "${safe}" MATCH ? LIMIT ${cap}`
              const rows = db.prepare(sql).all(a.query)
              out.push({ table: t, hits: rows.length, rows: rows.map((r) => ({ rowid: r.rowid, [textCol]: String(r[textCol] === undefined ? '' : r[textCol]).slice(0, snip) })) })
            } catch (e) {
              out.push({ table: t, error: String(e && e.message).slice(0, 200) })
            }
          }
          return { file, ftsTables: tables, query: a.query, results: out }
        } finally {
          db.close()
        }
      },
    },
    {
      name: 'db_size_report',
      desc: '库空间报告：页数/页大小/空闲页、各表占用（dbstat 可用时）、碎片率',
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名' },
        perTable: { type: 'boolean', desc: '用 dbstat 算每张表占用，默认 true（大库会慢）' },
        limit: { type: 'integer', desc: '最多几张表，默认 25' },
      },
      async run(a, ctx) {
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const st = fs.statSync(file)
        const { db } = await openDb(file)
        const out = { file, fileSize: fmtBytes(st.size), mtime: new Date(st.mtimeMs).toISOString() }
        if (!db) return { ...out, note: '打不开库，只给文件信息' }
        try {
          const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size)
          const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count)
          const freelist = Number(db.prepare('PRAGMA freelist_count').get().freelist_count)
          out.pageSize = pageSize
          out.pageCount = pageCount
          out.freelistPages = freelist
          out.reclaimable = fmtBytes(freelist * pageSize)
          out.fragmentPercent = Number((100 * freelist / Math.max(1, pageCount)).toFixed(2))
          out.journalMode = String(db.prepare('PRAGMA journal_mode').get().journal_mode)
          out.encoding = String(db.prepare('PRAGMA encoding').get().encoding)
          if (a.perTable !== false) {
            const cap = clamp(int(a.limit, 25), 1, 300)
            try {
              const rows = db.prepare(`SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT ${cap}`).all()
              out.byTable = rows.map((r) => `${fmtBytes(Number(r.bytes)).padStart(10)} ${String(r.pages).padStart(7)} 页  ${r.name}`)
            } catch (e) {
              out.byTableNote = 'dbstat 虚表不可用（编译时没开 DBSTAT）'
            }
          }
        } finally {
          db.close()
        }
        return out
      },
    },
    {
      name: 'db_integrity_check',
      desc: '完整性检查（PRAGMA integrity_check）+ 外键孤儿快速扫',
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名' },
        quick: { type: 'boolean', desc: 'quick_check（快）还是 integrity_check（全），默认 true', },
        checkForeignKeys: { type: 'boolean', desc: '顺带 PRAGMA foreign_key_check，默认 true' },
      },
      async run(a, ctx) {
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const { db } = await openDb(file)
        if (!db) return json({ ok: false, message: '打不开库' })
        try {
          const t0 = Date.now()
          const sql = a.quick === false ? 'PRAGMA integrity_check' : 'PRAGMA quick_check'
          const rows = db.prepare(sql).all()
          const out = { file, check: sql, ms: Date.now() - t0, ok: rows.length === 1 && String(Object.values(rows[0])[0]) === 'ok', result: JSON.parse(stringifyRows(rows.slice(0, 20), 2000)) }
          if (a.checkForeignKeys !== false) {
            try {
              const fk = db.prepare('PRAGMA foreign_key_check').all()
              out.foreignKeyViolations = fk.length
              out.foreignKeys = JSON.parse(stringifyRows(fk.slice(0, 10), 1500))
            } catch (e) {
              out.foreignKeyNote = String(e && e.message).slice(0, 120)
            }
          }
          return out
        } finally {
          db.close()
        }
      },
    },
    {
      name: 'db_export_table',
      desc: '把一张表导出成 JSON 或 CSV 文件',
      write: true,
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名' },
        table: { type: 'string', required: true, desc: '表名' },
        format: { type: 'string', desc: 'json|csv，默认 json', enum: ['json', 'csv'] },
        path: { type: 'string', desc: '输出路径，默认 exports/<表名>.<ext>' },
        limit: { type: 'integer', desc: '最多几行，默认 5000' },
        where: { type: 'string', desc: '附加 WHERE 条件（原样拼，注意自己写安全）' },
      },
      async run(a, ctx) {
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const { db } = await openDb(file)
        if (!db) return json({ ok: false, message: '打不开库' })
        try {
          const t = String(a.table).replace(/"/g, '""')
          const cap = clamp(int(a.limit, 5000), 1, 500000)
          const sql = `SELECT * FROM "${t}"${a.where ? ` WHERE ${a.where}` : ''} LIMIT ${cap}`
          const rows = db.prepare(sql).all()
          const fmt = a.format || 'json'
          const rel = a.path || `exports/${a.table}.${fmt === 'csv' ? 'csv' : 'json'}`
          const abs = ctx.resolve(rel)
          ensureDir(path.dirname(abs))
          let bytes
          if (fmt === 'csv') {
            const cols = rows.length ? Object.keys(rows[0]) : []
            const esc = (v) => {
              const s = v === null || v === undefined ? '' : String(v)
              return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
            }
            const body = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
            fs.writeFileSync(abs, body, 'utf8')
            bytes = Buffer.byteLength(body)
          } else {
            const body = JSON.stringify(rows, replacer, 2)
            fs.writeFileSync(abs, body, 'utf8')
            bytes = Buffer.byteLength(body)
          }
          return { saved: rel, abs, rows: rows.length, format: fmt, size: fmtBytes(bytes), columns: rows.length ? Object.keys(rows[0]).length : 0 }
        } catch (e) {
          return json({ ok: false, message: String(e && e.message).slice(0, 300) })
        } finally {
          db.close()
        }
      },
    },
    {
      name: 'db_exec_write',
      desc: '跑写语句（insert/update/delete/vacuum…），必须 confirm=true',
      write: true,
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名' },
        sql: { type: 'string', required: true, desc: '写语句，参数用 ? 占位' },
        params: { type: 'array', desc: '按顺序填 ? 的值', items: { type: 'string', desc: '一个值' } },
        confirm: { type: 'boolean', desc: '必须 true 才执行' },
      },
      async run(a, ctx) {
        if (a.confirm !== true) return json({ ok: false, message: '写库会改数据，传 confirm=true 才执行（建议先 db_export_table 备份）' })
        if (SAFE_READ.test(a.sql)) return json({ ok: false, message: '这是只读语句，用 db_query' })
        if (!WRITE_KIND.test(a.sql)) return json({ ok: false, message: '认不出写语句类型（要 insert/update/delete/create/drop/alter/vacuum/reindex/analyze/replace）' })
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const { db } = await openDb(file, false)
        if (!db) return json({ ok: false, message: '打不开库（写模式）' })
        try {
          const args = Array.isArray(a.params) ? a.params : []
          const t0 = Date.now()
          const r = db.prepare(String(a.sql)).run(...args)
          return { file, sql: String(a.sql).slice(0, 300), changes: Number(r.changes), lastInsertRowid: String(r.lastInsertRowid), ms: Date.now() - t0 }
        } catch (e) {
          return json({ ok: false, code: 'sql_error', message: String(e && e.message).slice(0, 400) })
        } finally {
          db.close()
        }
      },
    },
    {
      name: 'db_memory_stack_report',
      desc: '记忆栈五层实测：engram/knowledge/kb/storages 各库表数与关键表行数',
      params: {
        keyTables: { type: 'array', desc: '要重点数行的表名（模糊匹配）', items: { type: 'string', desc: '表名片段' } },
      },
      async run(a, ctx) {
        const wanted = Array.isArray(a.keyTables) && a.keyTables.length ? a.keyTables.map((x) => String(x).toLowerCase()) : ['memory', 'fact', 'entity', 'episode', 'knowledge', 'entry', 'chunk', 'document', 'message', 'session', 'embedding', 'fts']
        const layers = []
        for (const layer of knownDbs()) {
          const item = { layer: layer.layer, dir: layer.dir, databases: [] }
          try {
            for (const f of fs.readdirSync(layer.dir)) {
              if (!/\.(db|sqlite|sqlite3)$/i.test(f)) continue
              const full = path.join(layer.dir, f)
              const st = fs.statSync(full)
              const d = { file: f, size: fmtBytes(st.size), mtime: new Date(st.mtimeMs).toISOString() }
              const { db } = await openDb(full)
              if (!db) {
                d.note = '打不开（可能被占用）'
                item.databases.push(d)
                continue
              }
              try {
                const tables = tableNames(db)
                d.tables = tables.length
                d.keyTables = []
                for (const t of tables) {
                  if (!wanted.some((w) => t.toLowerCase().includes(w))) continue
                  try {
                    d.keyTables.push(`${t} = ${db.prepare(`SELECT COUNT(*) AS c FROM "${t.replace(/"/g, '""')}"`).get().c} 行`)
                  } catch (e) {}
                  if (d.keyTables.length >= 12) break
                }
              } catch (e) {
                d.note = String(e && e.message).slice(0, 100)
              } finally {
                db.close()
              }
              item.databases.push(d)
            }
          } catch (e) {
            item.note = `目录不存在: ${layer.dir}`
          }
          layers.push(item)
        }
        const missing = layers.filter((l) => !l.databases.length).map((l) => l.layer)
        return { dshHome: dshHome(), layers, verdict: missing.length ? `缺 ${missing.join('/')}` : '五层都有库文件', hint: '逐层实测：engram_search（记忆）+ kb_query（语料）+ db_fts_search（直查 FTS）' }
      },
    },
    {
      name: 'db_row_stats',
      desc: '某表数据分布：各列空值率、唯一值数、最长值、数值范围',
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名' },
        table: { type: 'string', required: true, desc: '表名' },
        sampleRows: { type: 'integer', desc: '算多少行（0=全表），默认 0' },
      },
      async run(a, ctx) {
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const { db } = await openDb(file)
        if (!db) return json({ ok: false, message: '打不开库' })
        try {
          const t = String(a.table).replace(/"/g, '""')
          const cols = db.prepare(`PRAGMA table_info("${t}")`).all()
          if (!cols.length) return json({ ok: false, message: `没有表 ${a.table}` })
          const from = a.sampleRows > 0 ? `(SELECT * FROM "${t}" LIMIT ${clamp(int(a.sampleRows, 0), 1, 200000)})` : `"${t}"`
          const exprs = cols.map((c) => {
            const col = `"${String(c.name).replace(/"/g, '""')}"`
            return `COUNT(${col}) AS "n_${c.name}", COUNT(DISTINCT ${col}) AS "u_${c.name}", MAX(LENGTH(CAST(${col} AS TEXT))) AS "m_${c.name}", MIN(${col}) AS "min_${c.name}", MAX(${col}) AS "max_${c.name}"`
          }).join(', ')
          const row = db.prepare(`SELECT ${exprs} FROM ${from}`).get()
          const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${from}`).get().c)
          return {
            file,
            table: a.table,
            rows: total,
            columns: cols.map((c) => {
              const n = Number(row[`n_${c.name}`] || 0)
              return {
                column: c.name,
                type: c.type,
                filled: `${total ? Number((100 * n / total).toFixed(1)) : 0}%`,
                distinct: Number(row[`u_${c.name}`] || 0),
                maxLen: row[`m_${c.name}`] === null ? null : Number(row[`m_${c.name}`]),
                min: row[`min_${c.name}`] === null || typeof row[`min_${c.name}`] === 'string' && String(row[`min_${c.name}`]).length > 24 ? null : row[`min_${c.name}`],
                max: row[`max_${c.name}`] === null || typeof row[`max_${c.name}`] === 'string' && String(row[`max_${c.name}`]).length > 24 ? null : row[`max_${c.name}`],
              }
            }),
          }
        } catch (e) {
          return json({ ok: false, message: String(e && e.message).slice(0, 300) })
        } finally {
          db.close()
        }
      },
    },
    {
      name: 'db_recent_rows',
      desc: '看某表最近的行（自动找时间列），用来确认"刚写进去的东西在不在"',
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名' },
        table: { type: 'string', required: true, desc: '表名' },
        limit: { type: 'integer', desc: '几行，默认 10' },
        columnPreview: { type: 'integer', desc: '每列最多显示字符，默认 120' },
      },
      async run(a, ctx) {
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const { db } = await openDb(file)
        if (!db) return json({ ok: false, message: '打不开库' })
        try {
          const t = String(a.table).replace(/"/g, '""')
          const cols = db.prepare(`PRAGMA table_info("${t}")`).all()
          if (!cols.length) return json({ ok: false, message: `没有表 ${a.table}`, tables: tableNames(db).slice(0, 40) })
          const names = cols.map((c) => c.name)
          const timeCol = names.find((n) => /created|updated|time|date|at|ts|modified/i.test(n))
          const idCol = names.find((n) => /^(id|rowid|key|uid|uuid)$/i.test(n))
          const order = timeCol ? `ORDER BY "${timeCol}" DESC` : idCol ? `ORDER BY "${idCol}" DESC` : 'ORDER BY rowid DESC'
          const cap = clamp(int(a.limit, 10), 1, 200)
          const prev = clamp(int(a.columnPreview, 120), 10, 2000)
          const rows = db.prepare(`SELECT * FROM "${t}" ${order} LIMIT ${cap}`).all()
          return {
            file,
            table: a.table,
            ordered: timeCol || idCol || 'rowid',
            total: Number(db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c),
            rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : typeof v === 'string' && v.length > prev ? `${v.slice(0, prev)}…` : String(v).length > prev ? `${String(v).slice(0, prev)}…` : v]))),
          }
        } catch (e) {
          return json({ ok: false, message: String(e && e.message).slice(0, 300) })
        } finally {
          db.close()
        }
      },
    },
    {
      name: 'db_count_by',
      desc: '按某列分组计数（GROUP BY + COUNT），看数据是怎么分布的',
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名' },
        table: { type: 'string', required: true, desc: '表名' },
        column: { type: 'string', required: true, desc: '分组列，例如 kind / room / scope / category' },
        limit: { type: 'integer', desc: '前几名，默认 30' },
      },
      async run(a, ctx) {
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const { db } = await openDb(file)
        if (!db) return json({ ok: false, message: '打不开库' })
        try {
          const t = String(a.table).replace(/"/g, '""')
          const c = String(a.column).replace(/"/g, '""')
          const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((x) => x.name)
          if (!cols.includes(a.column)) return json({ ok: false, message: `表 ${a.table} 没有列 ${a.column}`, columns: cols.slice(0, 60) })
          const cap = clamp(int(a.limit, 30), 1, 500)
          const rows = db.prepare(`SELECT COALESCE(CAST("${c}" AS TEXT), '(NULL)') AS k, COUNT(*) AS n FROM "${t}" GROUP BY k ORDER BY n DESC LIMIT ${cap}`).all()
          const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c)
          return { file, table: a.table, column: a.column, total, groups: rows.length, distribution: rows.map((r) => `${String(r.n).padStart(8)}  ${String(r.k).slice(0, 60)}`) }
        } catch (e) {
          return json({ ok: false, message: String(e && e.message).slice(0, 300) })
        } finally {
          db.close()
        }
      },
    },
    {
      name: 'db_wal_checkpoint',
      desc: '看 WAL 状态并可做 checkpoint（把 -wal 合回主库），写操作要 confirm',
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名' },
        mode: { type: 'string', desc: 'PASSIVE|FULL|RESTART|TRUNCATE，默认 PASSIVE', enum: ['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'] },
        confirm: { type: 'boolean', desc: '执行 checkpoint 必须 true' },
      },
      async run(a, ctx) {
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const wal = `${file}-wal`
        const info = { file, walExists: fs.existsSync(wal), walSize: fs.existsSync(wal) ? fmtBytes(fs.statSync(wal).size) : null, shmExists: fs.existsSync(`${file}-shm`) }
        const { db } = await openDb(file, !a.confirm)
        if (!db) return { ...info, note: '打不开库' }
        try {
          info.journalMode = String(db.prepare('PRAGMA journal_mode').get().journal_mode)
          info.busyTimeoutMs = Number(db.prepare('PRAGMA busy_timeout').get().busy_timeout)
          if (a.confirm === true) {
            const t0 = Date.now()
            const r = db.prepare(`PRAGMA wal_checkpoint(${a.mode || 'PASSIVE'})`).get()
            info.checkpoint = { ms: Date.now() - t0, busy: r.busy, logPages: r.log, checkpointedPages: r.checkpointed, note: r.busy ? '有连接占着，没做完' : '完成' }
            info.walSizeAfter = fs.existsSync(wal) ? fmtBytes(fs.statSync(wal).size) : null
          } else info.note = '没传 confirm=true，只读状态没动 WAL'
          return info
        } catch (e) {
          return { ...info, error: String(e && e.message).slice(0, 200) }
        } finally {
          db.close()
        }
      },
    },
    {
      name: 'db_backup_copy',
      desc: '备份一个库到目标路径（用 sqlite backup API，安全不锁死）',
      write: true,
      params: {
        database: { type: 'string', required: true, desc: '源库路径或层名' },
        to: { type: 'string', required: true, desc: '目标路径，例如 backups/engram-2026-10-17.db' },
        confirm: { type: 'boolean', desc: '必须 true' },
      },
      async run(a, ctx) {
        if (a.confirm !== true) return json({ ok: false, message: '备份会写文件，传 confirm=true' })
        const src = findDbFile(ctx, a.database)
        if (!fs.existsSync(src)) return json({ ok: false, message: `找不到源库: ${src}` })
        const dest = ctx.resolve(a.to)
        ensureDir(path.dirname(dest))
        const { DatabaseSync } = await import('node:sqlite').catch(() => ({}))
        const t0 = Date.now()
        try {
          if (DatabaseSync && typeof DatabaseSync.prototype.backup === 'function') {
            await DatabaseSync.prototype.backup.call(await new DatabaseSync(src, { readOnly: true, open: true }), dest)
          } else {
            fs.copyFileSync(src, dest)
            for (const suffix of ['-wal', '-shm']) if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, dest + suffix)
          }
          return { from: src, to: dest, size: fmtBytes(fs.statSync(dest).size), ms: Date.now() - t0, method: DatabaseSync && typeof DatabaseSync.prototype.backup === 'function' ? 'sqlite backup API' : '文件复制' }
        } catch (e) {
          return json({ ok: false, message: String(e && e.message).slice(0, 300) })
        }
      },
    },
    {
      name: 'db_vector_check',
      desc: '查向量表：有没有 embedding/blob 列、维度、行数、是否 sqlite-vec/vss 虚表',
      params: {
        database: { type: 'string', required: true, desc: '库路径或层名，例如 engram / knowledge' },
        table: { type: 'string', desc: '指定表；不给自动找带向量特征的表' },
        sample: { type: 'integer', desc: '抽几条看维度，默认 3' },
      },
      async run(a, ctx) {
        const file = findDbFile(ctx, a.database)
        if (!fs.existsSync(file)) return json({ ok: false, message: `找不到库: ${file}` })
        const { db } = await openDb(file)
        if (!db) return json({ ok: false, message: '打不开库' })
        try {
          const all = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all()
          const candidates = a.table ? [a.table] : all.filter((r) => /vec|vector|embedding|embedding|float32|vss|knn/i.test(`${r.name} ${r.sql || ''}`)).map((r) => r.name)
          const out = []
          for (const t of candidates.slice(0, 12)) {
            const safe = String(t).replace(/"/g, '""')
            const item = { table: t, ddl: String((all.find((x) => x.name === t) || {}).sql || '').slice(0, 400) }
            try {
              item.rows = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${safe}"`).get().c)
            } catch (e) {
              item.note = `数行数失败: ${String(e && e.message).slice(0, 80)}`
              out.push(item)
              continue
            }
            try {
              const cols = db.prepare(`PRAGMA table_info("${safe}")`).all()
              item.columns = cols.map((c) => `${c.name}:${c.type || '?'}`)
              const blobCol = cols.map((c) => c.name).find((n) => /vec|vector|embedding|embedding|blob|data/i.test(n))
              if (blobCol && a.sample > 0) {
                const rows = db.prepare(`SELECT "${String(blobCol).replace(/"/g, '""')}" AS v FROM "${safe}" WHERE v IS NOT NULL LIMIT ${clamp(int(a.sample, 3), 1, 20)}`).all()
                item.samples = rows.map((r) => {
                  const v = r.v
                  if (Buffer.isBuffer(v)) return { kind: 'blob', bytes: v.length, float32Dims: v.length / 4 }
                  if (typeof v === 'string') {
                    const t2 = v.trim()
                    if (t2.startsWith('[')) {
                      try {
                        const arr = JSON.parse(t2)
                        return { kind: 'json-array', dims: Array.isArray(arr) ? arr.length : null }
                      } catch (e) {
                        return { kind: 'string', chars: v.length }
                      }
                    }
                    return { kind: 'string', chars: v.length, head: v.slice(0, 60) }
                  }
                  return { kind: typeof v, value: String(v).slice(0, 60) }
                })
              }
            } catch (e) {
              item.note = String(e && e.message).slice(0, 120)
            }
            out.push(item)
          }
          return { file, candidates: candidates.length, tables: out, note: out.length ? null : '没找到向量特征表（可能向量在独立库或用了 sqlite-vec 扩展）' }
        } finally {
          db.close()
        }
      },
    },
  ],
}
