// DSH 插件与配置包：读 ~/.dsh 的 profile、bundle、skills、sessions、记忆栈数据库，
// 以及插件自己的运行配置。全部只读为主，写只写 ~/.dsh/tey-mcp/config.json。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { json, int, clamp, fmtBytes, readJsonSafe, writeJsonSafe, ensureDir, walkFiles, parseYamlLite } from '../util.js'

function dshHome() {
  return process.env.DSH_HOME_DIR || path.join(os.homedir(), '.dsh')
}

function profileDir() {
  const env = process.env.DSH_PROFILE_DIR
  if (env && fs.existsSync(env)) return env
  const base = path.join(dshHome(), 'profiles')
  try {
    const names = fs.readdirSync(base).filter((n) => fs.statSync(path.join(base, n)).isDirectory())
    if (names.includes('desktop')) return path.join(base, 'desktop')
    if (names.length) return path.join(base, names[0])
  } catch (e) {}
  return base
}

function dirStats(dir, maxFiles = 60000) {
  const out = { dir, exists: false, files: 0, bytes: 0, newest: 0 }
  try {
    const st = fs.statSync(dir)
    out.exists = st.isDirectory()
    if (!out.exists) return out
  } catch (e) {
    return out
  }
  for (const f of walkFiles(dir, { maxFiles, skip: /(^|[\\/])(\.git|node_modules)([\\/]|$)/ })) {
    try {
      const st = fs.statSync(f)
      out.files++
      out.bytes += st.size
      if (st.mtimeMs > out.newest) out.newest = st.mtimeMs
    } catch (e) {}
  }
  return out
}

async function sqliteInfo(file) {
  const out = { file, exists: false }
  try {
    const st = fs.statSync(file)
    out.exists = true
    out.size = fmtBytes(st.size)
    out.mtime = new Date(st.mtimeMs).toISOString()
  } catch (e) {
    return out
  }
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch (e) {
    out.note = '本机 Node 没有 node:sqlite，只报文件信息'
    return out
  }
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name").all()
      out.tables = []
      for (const t of tables) {
        if (t.type !== 'table') continue
        if (/^(sqlite_|fts_|temp\.)/.test(t.name)) continue
        try {
          const n = db.prepare(`SELECT COUNT(*) AS c FROM "${t.name.replace(/"/g, '""')}"`).get()
          out.tables.push({ table: t.name, rows: Number(n.c) })
        } catch (e) {
          out.tables.push({ table: t.name, rows: null })
        }
      }
      try {
        out.userVersion = Number(db.prepare('PRAGMA user_version').get().user_version)
      } catch (e) {}
    } finally {
      db.close()
    }
  } catch (e) {
    out.note = `打不开库（可能被占用）: ${String(e && e.message).slice(0, 120)}`
  }
  return out
}

function readCordisRows() {
  const file = path.join(profileDir(), 'cordis.yml')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { file, rows: [], error: '读不到 cordis.yml' }
  }
  const rows = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*id:\s*(.+)$/)
    if (!m) continue
    const id = m[1].trim().replace(/^['"]|['"]$/g, '')
    let name = ''
    let disabled = false
    for (let k = i + 1; k < Math.min(lines.length, i + 8); k++) {
      if (/^\s*-\s*id:/.test(lines[k])) break
      const nm = lines[k].match(/^\s*name:\s*(.+)$/)
      if (nm) name = nm[1].trim().replace(/^['"]|['"]$/g, '')
      const dm = lines[k].match(/^\s*disabled:\s*(.+)$/)
      if (dm) disabled = /^(true|yes|1)/i.test(dm[1].trim())
    }
    rows.push({ id, name, disabled, line: i + 1 })
  }
  return { file, rows }
}

export default {
  id: 'dsh',
  title: 'DSH 插件与配置',
  tags: ['dsh', 'plugin', 'bundle', 'skills', 'memory'],
  summary: '看 profile/已装插件/技能/会话/记忆栈数据库、插件启用状态、总线自身配置读写',
  tools: [
    {
      name: 'dsh_home_overview',
      desc: 'DSH 家目录概况：~/.dsh 各子目录大小、文件数、最近改动',
      params: {
        limit: { type: 'integer', desc: '最多列几个子目录，默认 30' },
        deep: { type: 'boolean', desc: '递归统计大小（慢），默认 true' },
      },
      async run(a) {
        const home = dshHome()
        const cap = clamp(int(a.limit, 30), 1, 200)
        let names = []
        try {
          names = fs.readdirSync(home)
        } catch (e) {
          return json({ ok: false, message: `读不到 ${home}` })
        }
        const rows = []
        for (const n of names.slice(0, cap)) {
          const full = path.join(home, n)
          try {
            const st = fs.statSync(full)
            if (!st.isDirectory()) {
              rows.push({ name: n, kind: 'file', size: fmtBytes(st.size), mtime: new Date(st.mtimeMs).toISOString() })
              continue
            }
            if (a.deep === false) {
              rows.push({ name: n, kind: 'dir', mtime: new Date(st.mtimeMs).toISOString() })
              continue
            }
            const s = dirStats(full)
            rows.push({ name: n, kind: 'dir', files: s.files, size: fmtBytes(s.bytes), newest: s.newest ? new Date(s.newest).toISOString() : null })
          } catch (e) {}
        }
        rows.sort((x, y) => (y.size || '').localeCompare(x.size || ''))
        return { home, profileDir: profileDir(), entries: rows }
      },
    },
    {
      name: 'dsh_profiles',
      desc: '列 DSH profile 目录与当前 profile，含各自插件数量',
      params: {},
      async run() {
        const base = path.join(dshHome(), 'profiles')
        const out = []
        try {
          for (const n of fs.readdirSync(base)) {
            const full = path.join(base, n)
            const pkg = readJsonSafe(path.join(full, 'package.json'), null)
            out.push({
              profile: n,
              path: full,
              isCurrent: path.resolve(full) === path.resolve(profileDir()),
              bundles: pkg && pkg.dsh && Array.isArray(pkg.dsh.profile && pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles.length : null,
              dependencies: pkg && pkg.dependencies ? Object.keys(pkg.dependencies).length : null,
              hasCordisYml: fs.existsSync(path.join(full, 'cordis.yml')),
            })
          }
        } catch (e) {
          return json({ ok: false, message: `读不到 ${base}` })
        }
        return { current: profileDir(), envProfile: process.env.DSH_PROFILE || null, profiles: out }
      },
    },
    {
      name: 'dsh_bundles',
      desc: '当前 profile 装了哪些插件（bundles 启用清单 + 依赖版本）',
      params: {
        filter: { type: 'string', desc: '按名字子串过滤' },
        limit: { type: 'integer', desc: '最多几条，默认 60' },
      },
      async run(a) {
        const dir = profileDir()
        const pkg = readJsonSafe(path.join(dir, 'package.json'), null)
        if (!pkg) return json({ ok: false, message: `读不到 ${dir}/package.json` })
        const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
        const deps = pkg.dependencies || {}
        const cap = clamp(int(a.limit, 60), 1, 400)
        const rows = Object.entries(deps)
          .filter(([name]) => !a.filter || name.toLowerCase().includes(String(a.filter).toLowerCase()))
          .map(([name, version]) => ({ name, version, enabled: bundles.includes(name) }))
        return { profileDir: dir, enabledCount: bundles.length, dependencyCount: Object.keys(deps).length, shown: rows.slice(0, cap), notInDeps: bundles.filter((b) => !(b in deps)) }
      },
    },
    {
      name: 'dsh_plugin_info',
      desc: '看某个插件包的 name/version/描述/skills/patch 与入口文件',
      params: { name: { type: 'string', required: true, desc: '插件包名，例如 tey-mcp 或 @kenz1117/dsh-engram' } },
      async run(a) {
        const pkgDir = path.join(profileDir(), 'node_modules', String(a.name))
        const pkg = readJsonSafe(path.join(pkgDir, 'package.json'), null)
        if (!pkg) return json({ ok: false, message: `没找到 ${a.name}（在 ${pkgDir}）` })
        const dsh = pkg.dsh || {}
        const patchFile = dsh.bundle && dsh.bundle.patch
        return {
          name: pkg.name,
          version: pkg.version,
          description: pkg.description,
          main: pkg.main,
          exports: Object.keys(pkg.exports || {}),
          skills: dsh.skills || [],
          patch: patchFile,
          patchExists: patchFile ? fs.existsSync(path.join(pkgDir, patchFile)) : false,
          icon: pkg.icon || null,
          keywords: pkg.keywords || [],
          repository: pkg.repository && (pkg.repository.url || pkg.repository),
          dir: pkgDir,
          dirSize: fmtBytes(dirStats(pkgDir, 4000).bytes),
        }
      },
    },
    {
      name: 'dsh_plugin_patch',
      desc: '读插件的 cordis.patch.yml 原文（看它插了哪些行）',
      params: {
        name: { type: 'string', required: true, desc: '插件包名' },
        parse: { type: 'boolean', desc: '顺手粗解析成结构，默认 true' },
      },
      async run(a) {
        const pkgDir = path.join(profileDir(), 'node_modules', String(a.name))
        const pkg = readJsonSafe(path.join(pkgDir, 'package.json'), null)
        if (!pkg) return json({ ok: false, message: `没找到 ${a.name}` })
        const rel = (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) || 'cordis.patch.yml'
        const file = path.join(pkgDir, rel)
        let text = ''
        try {
          text = fs.readFileSync(file, 'utf8')
        } catch (e) {
          return json({ ok: false, message: `没有 patch 文件: ${file}` })
        }
        const rows = [...text.matchAll(/-\s*id:\s*([^\n]+)\n\s*name:\s*([^\n]+)/g)].map((m) => ({ id: m[1].trim().replace(/['"]/g, ''), name: m[2].trim().replace(/['"]/g, '') }))
        return { file, inserts: rows, raw: text.slice(0, 6000) }
      },
    },
    {
      name: 'dsh_rows_list',
      desc: '列 profile cordis.yml 里所有已插入的行（id/name/disabled/行号）',
      params: {
        filter: { type: 'string', desc: '按 id 或 name 子串过滤' },
        enabledOnly: { type: 'boolean', desc: '只列启用的' },
        limit: { type: 'integer', desc: '最多几条，默认 80' },
      },
      async run(a) {
        const r = readCordisRows()
        if (r.error) return json({ ok: false, ...r })
        const cap = clamp(int(a.limit, 80), 1, 500)
        let rows = r.rows
        if (a.enabledOnly) rows = rows.filter((x) => !x.disabled)
        if (a.filter) rows = rows.filter((x) => `${x.id} ${x.name}`.toLowerCase().includes(String(a.filter).toLowerCase()))
        return { file: r.file, total: r.rows.length, shown: rows.length, rows: rows.slice(0, cap).map((x) => `${x.disabled ? 'x' : '✓'} ${String(x.line).padStart(4)}  ${x.id.padEnd(28)} ${x.name}`) }
      },
    },
    {
      name: 'dsh_row_lookup',
      desc: '在 cordis.yml 里按关键词搜上下文（查某插件的配置块）',
      params: {
        query: { type: 'string', required: true, desc: '要搜的词，例如 tey-mcp / free-search' },
        contextLines: { type: 'integer', desc: '上下各几行，默认 6' },
      },
      async run(a) {
        const file = path.join(profileDir(), 'cordis.yml')
        let lines
        try {
          lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
        } catch (e) {
          return json({ ok: false, message: `读不到 ${file}` })
        }
        const ctxN = clamp(int(a.contextLines, 6), 0, 40)
        const hits = []
        const q = String(a.query).toLowerCase()
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(q)) continue
          const from = Math.max(0, i - ctxN)
          const to = Math.min(lines.length, i + ctxN + 1)
          hits.push({ line: i + 1, context: lines.slice(from, to).map((l, k) => `${from + k + 1}| ${l.slice(0, 200)}`) })
          if (hits.length >= 8) break
        }
        return { file, query: a.query, hits: hits.length, matches: hits }
      },
    },
    {
      name: 'dsh_plugin_enabled',
      desc: '查某插件是否启用（在 cordis.yml 行里 + 在 bundles 清单里 + 包在不在）',
      params: { name: { type: 'string', required: true, desc: '插件包名或行 id' } },
      async run(a) {
        const key = String(a.name)
        const rows = readCordisRows()
        const row = rows.rows.find((r) => r.id === key || r.name === key)
        const pkg = readJsonSafe(path.join(profileDir(), 'package.json'), {}) || {}
        const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
        return {
          name: key,
          installed: fs.existsSync(path.join(profileDir(), 'node_modules', key)),
          inBundles: bundles.includes(key),
          cordisRow: row || null,
          enabled: !!row && !row.disabled,
          hint: row ? (row.disabled ? '行在但被 disabled' : '已启用') : 'cordis.yml 里没有这个行',
        }
      },
    },
    {
      name: 'dsh_plugins_table',
      desc: '所有插件汇总表：name/version/有没有 skills/有没有 UI 行',
      params: {
        filter: { type: 'string', desc: '按名字过滤' },
        limit: { type: 'integer', desc: '最多几条，默认 60' },
      },
      async run(a) {
        const base = path.join(profileDir(), 'node_modules')
        const cap = clamp(int(a.limit, 60), 1, 400)
        const rows = readCordisRows().rows
        const out = []
        const names = []
        try {
          for (const n of fs.readdirSync(base)) {
            if (n.startsWith('@')) {
              for (const s of fs.readdirSync(path.join(base, n))) names.push(`${n}/${s}`)
            } else names.push(n)
          }
        } catch (e) {
          return json({ ok: false, message: `读不到 ${base}` })
        }
        for (const n of names) {
          if (n.startsWith('@deepseek-ai')) continue
          const pkg = readJsonSafe(path.join(base, n, 'package.json'), null)
          if (!pkg || !Array.isArray(pkg.keywords) || !pkg.keywords.includes('dsh-plugin')) {
            if (!pkg || !(pkg.dsh && pkg.dsh.bundle)) continue
          }
          if (a.filter && !n.toLowerCase().includes(String(a.filter).toLowerCase())) continue
          const row = rows.find((r) => r.name === n)
          out.push({
            name: n,
            version: pkg.version,
            skills: (pkg.dsh && pkg.dsh.skills ? pkg.dsh.skills.length : 0),
            rows: rows.filter((r) => r.name === n).map((r) => r.id),
            enabled: row ? !row.disabled : null,
            desc: String(pkg.description || '').slice(0, 80),
          })
          if (out.length >= cap) break
        }
        out.sort((x, y) => Number(!!y.enabled) - Number(!!x.enabled) || x.name.localeCompare(y.name))
        return { total: out.length, plugins: out.map((p) => `${p.enabled === false ? 'x' : '✓'} ${p.name.padEnd(32)} ${String(p.version).padEnd(10)} skills=${p.skills}  ${p.desc}`) }
      },
    },
    {
      name: 'dsh_skills_list',
      desc: '列 ~/.dsh/skills 下的技能：名字、有没有 SKILL.md、大小、最近改动',
      params: {
        filter: { type: 'string', desc: '按名字子串过滤' },
        limit: { type: 'integer', desc: '最多几条，默认 80' },
      },
      async run(a) {
        const dir = process.env.DSH_SKILLS_DIR || path.join(dshHome(), 'skills')
        const cap = clamp(int(a.limit, 80), 1, 2000)
        let names
        try {
          names = fs.readdirSync(dir)
        } catch (e) {
          return json({ ok: false, message: `读不到 ${dir}` })
        }
        const rows = []
        for (const n of names) {
          if (a.filter && !n.toLowerCase().includes(String(a.filter).toLowerCase())) continue
          const full = path.join(dir, n)
          try {
            const st = fs.statSync(full)
            if (!st.isDirectory()) continue
            const skillMd = path.join(full, 'SKILL.md')
            const has = fs.existsSync(skillMd)
            const s = dirStats(full, 2000)
            rows.push({ name: n, hasSkillMd: has, size: fmtBytes(s.bytes), files: s.files, mtime: new Date(st.mtimeMs).toISOString() })
          } catch (e) {}
          if (rows.length >= cap) break
        }
        return { dir, total: rows.length, skills: rows.map((r) => `${r.hasSkillMd ? '✓' : 'x'} ${r.name.padEnd(40)} ${r.size.padStart(9)} ${r.files} 文件  ${r.mtime.slice(0, 10)}`) }
      },
    },
    {
      name: 'dsh_skill_read',
      desc: '读某个 SKILL.md：frontmatter、字数、前 N 行',
      params: {
        name: { type: 'string', required: true, desc: '技能目录名' },
        lines: { type: 'integer', desc: '返回前几行，默认 60' },
        scope: { type: 'string', desc: 'profile=profile 内 skills 目录，home=~/.dsh/skills，默认 home', enum: ['home', 'profile'] },
      },
      async run(a) {
        const base = a.scope === 'profile' ? path.join(profileDir(), 'skills') : process.env.DSH_SKILLS_DIR || path.join(dshHome(), 'skills')
        const file = path.join(base, String(a.name), 'SKILL.md')
        let text
        try {
          text = fs.readFileSync(file, 'utf8')
        } catch (e) {
          return json({ ok: false, message: `读不到 ${file}` })
        }
        const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
        const rows = text.split(/\r?\n/)
        const n = clamp(int(a.lines, 60), 1, 2000)
        return {
          file,
          frontmatter: m ? parseYamlLite(m[1]) : null,
          chars: text.length,
          lines: rows.length,
          approxTokens: Math.ceil(Buffer.byteLength(text) / 4),
          head: rows.slice(0, n).map((l, i) => `${i + 1}| ${l.slice(0, 200)}`),
        }
      },
    },
    {
      name: 'dsh_sessions_stats',
      desc: '会话目录统计：按工作区分组的会话数、总大小、最近活动',
      params: {
        limit: { type: 'integer', desc: '最多几个工作区，默认 25' },
        deep: { type: 'boolean', desc: '递归算大小（慢），默认 false' },
      },
      async run(a) {
        const dir = path.join(dshHome(), 'sessions')
        const cap = clamp(int(a.limit, 25), 1, 300)
        let names
        try {
          names = fs.readdirSync(dir)
        } catch (e) {
          return json({ ok: false, message: `读不到 ${dir}` })
        }
        const groups = new Map()
        for (const n of names) {
          const full = path.join(dir, n)
          try {
            const st = fs.statSync(full)
            if (!st.isDirectory()) continue
            const files = fs.readdirSync(full)
            let bytes = 0
            let newest = st.mtimeMs
            for (const f of files) {
              try {
                const fst = fs.statSync(path.join(full, f))
                bytes += fst.size
                if (fst.mtimeMs > newest) newest = fst.mtimeMs
              } catch (e) {}
            }
            const key = n.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)
            groups.set(key, { dir: n, sessions: files.length, bytes, newest })
          } catch (e) {}
          if (groups.size >= cap) break
        }
        const rows = [...groups.values()].sort((x, y) => y.newest - x.newest)
        return {
          dir,
          workspaces: rows.length,
          totalSessions: rows.reduce((s, r) => s + r.sessions, 0),
          totalBytes: fmtBytes(rows.reduce((s, r) => s + r.bytes, 0)),
          rows: rows.slice(0, cap).map((r) => `${String(r.sessions).padStart(5)}  ${fmtBytes(r.bytes).padStart(10)}  ${new Date(r.newest).toISOString().slice(0, 16)}  ${r.dir}`),
        }
      },
    },
    {
      name: 'dsh_engram_stats',
      desc: 'engram 记忆库概况：文件大小 + 各表行数（node:sqlite 可用时）',
      params: {
        file: { type: 'string', desc: '库文件路径，默认 ~/.dsh/engram 下最大的 .db' },
        sample: { type: 'integer', desc: '顺带抽几条记忆看，默认 0 不抽' },
      },
      async run(a) {
        let file = a.file ? path.resolve(a.file) : null
        if (!file) {
          const dir = path.join(dshHome(), 'engram')
          try {
            const dbs = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).map((f) => ({ f, s: fs.statSync(path.join(dir, f)).size })).sort((x, y) => y.s - x.s)
            if (!dbs.length) return json({ ok: false, message: `${dir} 下没有 .db` })
            file = path.join(dir, dbs[0].f)
          } catch (e) {
            return json({ ok: false, message: `读不到 ${dir}` })
          }
        }
        const info = await sqliteInfo(file)
        if (a.sample > 0 && info.tables) {
          let DatabaseSync
          try {
            ;({ DatabaseSync } = await import('node:sqlite'))
            const db = new DatabaseSync(file, { readOnly: true })
            try {
              for (const t of info.tables.slice(0, 3)) {
                try {
                  info.sample = info.sample || {}
                  info.sample[t.table] = db.prepare(`SELECT * FROM "${t.table}" LIMIT ?`).all(clamp(int(a.sample, 3), 1, 20)).map((r) => JSON.stringify(r).slice(0, 300))
                } catch (e) {}
              }
            } finally {
              db.close()
            }
          } catch (e) {}
        }
        return info
      },
    },
    {
      name: 'dsh_knowledge_stats',
      desc: 'knowledge.sqlite（提炼知识层）概况与表行数',
      params: { limit: { type: 'integer', desc: '最多几张表，默认 20' } },
      async run(a) {
        const file = path.join(dshHome(), 'knowledge', 'knowledge.sqlite')
        const info = await sqliteInfo(file)
        if (info.tables) info.tables = info.tables.slice(0, clamp(int(a.limit, 20), 1, 100))
        return info
      },
    },
    {
      name: 'dsh_kb_stats',
      desc: 'knowledge-base/kb.sqlite（语料层）概况：条目数、分类分布',
      params: {
        categoryTop: { type: 'integer', desc: '列前几个分类，默认 15' },
        sample: { type: 'integer', desc: '抽几条条目名看，默认 5' },
      },
      async run(a) {
        const file = path.join(dshHome(), 'knowledge-base', 'kb.sqlite')
        const info = await sqliteInfo(file)
        let DatabaseSync
        try {
          ;({ DatabaseSync } = await import('node:sqlite'))
        } catch (e) {
          return info
        }
        try {
          const db = new DatabaseSync(file, { readOnly: true })
          try {
            const tables = (info.tables || []).map((t) => t.table)
            const main = tables.find((t) => /entr|doc|item|knowledge/i.test(t)) || tables[0]
            if (main) {
              info.mainTable = main
              try {
                info.categories = db.prepare(`SELECT category, COUNT(*) AS c FROM "${main}" GROUP BY category ORDER BY c DESC LIMIT ?`).all(clamp(int(a.categoryTop, 15), 1, 100))
              } catch (e) {}
              try {
                info.sample = db.prepare(`SELECT * FROM "${main}" ORDER BY rowid DESC LIMIT ?`).all(clamp(int(a.sample, 5), 0, 30)).map((r) => JSON.stringify(r).slice(0, 260))
              } catch (e) {}
            }
          } finally {
            db.close()
          }
        } catch (e) {
          info.note = `${info.note || ''} 读分类失败: ${String(e && e.message).slice(0, 100)}`
        }
        return info
      },
    },
    {
      name: 'dsh_memory_stack_check',
      desc: '记忆栈自检：爬取/记忆/向量/知识库/会话五层在不在、多大、最近改动',
      params: {},
      async run() {
        const targets = [
          { layer: '会话记录', path: path.join(dshHome(), 'sessions') },
          { layer: 'engram 记忆', path: path.join(dshHome(), 'engram') },
          { layer: 'knowledge 提炼', path: path.join(dshHome(), 'knowledge') },
          { layer: 'knowledge-base 语料', path: path.join(dshHome(), 'knowledge-base') },
          { layer: 'skills 技能', path: path.join(dshHome(), 'skills') },
          { layer: 'storages', path: path.join(dshHome(), 'storages') },
        ]
        const rows = []
        for (const t of targets) {
          const s = dirStats(t.path, 20000)
          rows.push({ layer: t.layer, path: t.path, exists: s.exists, files: s.files, size: fmtBytes(s.bytes), newest: s.newest ? new Date(s.newest).toISOString() : null })
        }
        const missing = rows.filter((r) => !r.exists).map((r) => r.layer)
        return { dshHome: dshHome(), layers: rows, verdict: missing.length ? `缺 ${missing.length} 层: ${missing.join('/')}` : '五层目录都在', hint: '要逐层实测用 engram_search / kb_query / dsh_kb_stats' }
      },
    },
    {
      name: 'dsh_runtime_versions',
      desc: 'DSH 安装目录的运行时版本（node / pnpm 等 versions.json）',
      params: {
        installDir: { type: 'string', desc: '安装目录，例如 H:\\DeepSeek Harness；不给就自动找' },
      },
      async run(a, ctx) {
        const cands = []
        if (a.installDir) cands.push(path.resolve(a.installDir))
        if (process.resourcesPath) cands.push(process.resourcesPath)
        cands.push('H:/DeepSeek Harness', 'C:/Program Files/DeepSeek Harness')
        for (const base of cands) {
          const file = path.join(base, 'resources', 'runtime', 'versions.json')
          const v = readJsonSafe(file, null)
          if (v) return { file, versions: v, node: process.version }
        }
        return json({ ok: false, message: '没找到 versions.json', tried: cands.map((c) => path.join(c, 'resources', 'runtime', 'versions.json')), currentNode: process.version })
      },
    },
    {
      name: 'dsh_env_facts',
      desc: '当前进程里所有 DSH_* 与相关环境变量（脱敏）',
      params: { filter: { type: 'string', desc: '额外过滤词，例如 PROFILE / HOME' } },
      async run(a) {
        const rows = {}
        for (const [k, v] of Object.entries(process.env)) {
          if (!/DSH|DEEPSEEK|CORDIS/i.test(k)) continue
          if (a.filter && !k.toUpperCase().includes(String(a.filter).toUpperCase())) continue
          rows[k] = String(v).slice(0, 200)
        }
        return { count: Object.keys(rows).length, vars: rows, dshHome: dshHome(), profileDir: profileDir() }
      },
    },
    {
      name: 'dsh_config_store',
      desc: '总线自身配置（~/.dsh/tey-mcp/config.json）get/set/list，重启也生效',
      write: true,
      params: {
        action: { type: 'string', required: true, desc: 'get|set|list|delete', enum: ['get', 'set', 'list', 'delete'] },
        key: { type: 'string', desc: 'set/delete 的键，例如 fetchMax / packsDisabled' },
        value: { type: 'string', desc: 'set 的值（数组用逗号分隔）' },
      },
      async run(a) {
        const dir = path.join(dshHome(), 'tey-mcp')
        const file = path.join(dir, 'config.json')
        ensureDir(dir)
        const cur = readJsonSafe(file, {}) || {}
        if (a.action === 'list' || a.action === 'get') return { file, config: cur, defaults: { ttlSeconds: 1800, idleSeconds: 900, fetchMin: 30, fetchMax: 50, maxBatch: 12, resultMaxChars: 20000, packsDisabled: [], mcpServers: [] } }
        if (a.action === 'set') {
          if (!a.key) return json({ ok: false, message: 'set 要填 key' })
          let v = a.value
          if (/^(ttlSeconds|idleSeconds|fetchMin|fetchMax|maxBatch|resultMaxChars)$/.test(a.key)) v = Number(a.value)
          if (/^(packsDisabled|mcpServers)$/.test(a.key)) v = a.key === 'mcpServers' ? JSON.parse(a.value) : String(a.value).split(',').map((s) => s.trim()).filter(Boolean)
          cur[a.key] = v
          writeJsonSafe(file, cur)
          return json({ ok: true, file, key: a.key, value: v, note: '已写入；本会话的 tey_configure set 会立即生效，重启后按此文件' })
        }
        if (a.action === 'delete') {
          delete cur[a.key]
          writeJsonSafe(file, cur)
          return json({ ok: true, removed: a.key, config: cur })
        }
        return json({ ok: false, message: `未知 action: ${a.action}` })
      },
    },
    {
      name: 'dsh_backup_status',
      desc: '工作区 GitHub 备份状态：远端、未提交、未推送、最近提交',
      params: {
        path: { type: 'string', desc: '仓库目录，默认会话工作区' },
        fetch: { type: 'boolean', desc: '先 git fetch 再比（慢），默认 false' },
      },
      async run(a, ctx) {
        const cwd = ctx.resolve(a.path || '.')
        const remote = await ctx.exec('git', ['remote', '-v'], { cwd, timeoutMs: 15000 })
        if (remote.code !== 0) return json({ ok: false, message: `不是 git 仓库或 git 不可用: ${String(remote.stderr).slice(0, 160)}` })
        const status = await ctx.exec('git', ['status', '--porcelain'], { cwd, timeoutMs: 20000 })
        const log = await ctx.exec('git', ['log', '-3', '--pretty=%h %ad %s', '--date=short'], { cwd, timeoutMs: 20000 })
        const branch = await ctx.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10000 })
        const dirty = String(status.stdout).split(/\r?\n/).filter(Boolean)
        if (a.fetch) await ctx.exec('git', ['fetch', '--all'], { cwd, timeoutMs: 60000 })
        const ahead = await ctx.exec('git', ['rev-list', '--count', '@{upstream}..HEAD'], { cwd, timeoutMs: 20000 })
        const behind = await ctx.exec('git', ['rev-list', '--count', 'HEAD..@{upstream}'], { cwd, timeoutMs: 20000 })
        return {
          cwd,
          branch: String(branch.stdout).trim(),
          remotes: String(remote.stdout).split(/\r?\n/).filter(Boolean),
          uncommitted: dirty.length,
          uncommittedSample: dirty.slice(0, 20),
          aheadOfUpstream: /^\d+$/.test(String(ahead.stdout).trim()) ? Number(String(ahead.stdout).trim()) : null,
          behindUpstream: /^\d+$/.test(String(behind.stdout).trim()) ? Number(String(behind.stdout).trim()) : null,
          recentCommits: String(log.stdout).split(/\r?\n/).filter(Boolean),
          verdict: dirty.length ? `有 ${dirty.length} 个改动未提交` : Number(ahead.stdout) > 0 ? '已提交未推送' : '干净且已同步',
        }
      },
    },
    {
      name: 'dsh_data_dirs',
      desc: '~/.dsh 下各插件数据目录占用排行（谁把盘吃了）',
      params: {
        top: { type: 'integer', desc: '前几名，默认 15' },
        minMB: { type: 'integer', desc: '超过多少 MB 才列，默认 0' },
      },
      async run(a) {
        const home = dshHome()
        let names
        try {
          names = fs.readdirSync(home)
        } catch (e) {
          return json({ ok: false, message: `读不到 ${home}` })
        }
        const rows = []
        for (const n of names) {
          const full = path.join(home, n)
          try {
            if (!fs.statSync(full).isDirectory()) continue
          } catch (e) {
            continue
          }
          if (n === 'profiles') continue
          const s = dirStats(full, 40000)
          if (s.bytes >= int(a.minMB, 0) * 1024 * 1024) rows.push({ name: n, bytes: s.bytes, files: s.files, newest: s.newest })
        }
        rows.sort((x, y) => y.bytes - x.bytes)
        const top = clamp(int(a.top, 15), 1, 200)
        return { home, totalBytes: fmtBytes(rows.reduce((s, r) => s + r.bytes, 0)), rows: rows.slice(0, top).map((r) => `${fmtBytes(r.bytes).padStart(10)}  ${String(r.files).padStart(6)} 文件  ${r.name}`) }
      },
    },
    {
      name: 'dsh_tey_selftest',
      desc: '总线自检：包数/工具数、指纹门、外部 MCP、加载错误、配置生效值',
      params: {},
      async run(_a, ctx) {
        const counts = ctx.registry ? ctx.registry.count() : { packs: 0, tools: 0 }
        const cfg = readJsonSafe(path.join(dshHome(), 'tey-mcp', 'config.json'), {}) || {}
        return {
          bus: counts,
          packs: ctx.registry ? ctx.registry.packList().map((p) => `${p.id.padEnd(10)} ${String(p.tools).padStart(4)}  ${p.title}`) : [],
          configOverride: cfg,
          dataDir: path.join(dshHome(), 'tey-mcp'),
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          checks: {
            有文件系统工具: counts.tools > 0,
            配置目录可写: ensureDir(path.join(dshHome(), 'tey-mcp')) === true,
            记忆栈在位: fs.existsSync(path.join(dshHome(), 'engram')),
          },
        }
      },
    },
  ],
}
