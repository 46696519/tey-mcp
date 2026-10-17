// Git 与仓库包：状态、日志、差异、分支、暂存与提交推送（写操作只在显式调用时发生）。
// 所有命令走 ctx.exec，git 不可用或不是仓库时返回中文原因。
import fs from 'node:fs'
import path from 'node:path'
import { json, int, clamp, fmtBytes, walkFiles } from '../util.js'

async function g(ctx, args, cwd, timeoutMs = 30000) {
  const r = await ctx.exec('git', args, { cwd, timeoutMs })
  return { code: r.code, out: String(r.stdout), err: String(r.stderr), cmd: `git ${args.join(' ')}` }
}

function repoOf(ctx, a) {
  return ctx.resolve(a && a.path ? a.path : '.')
}

function lines(s) {
  return String(s).split(/\r?\n/).filter((l) => l.trim())
}

export default {
  id: 'git',
  title: 'Git 与仓库',
  tags: ['git', 'repo', 'commit', 'github'],
  summary: '状态/日志/差异/分支/标签/贡献者/仓库体检，以及显式的 add commit push pull',
  tools: [
    {
      name: 'git_status',
      desc: '工作区状态：分支、领先落后、改动文件分类（改/新/删/未跟踪）',
      params: { path: { type: 'string', desc: '仓库目录，默认会话工作区' }, limit: { type: 'integer', desc: '每类最多列几条，默认 40' } },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const s = await g(ctx, ['status', '--porcelain=v1', '-b'], cwd)
        if (s.code !== 0) return json({ ok: false, message: `${cwd} 不是 git 仓库或 git 不可用`, detail: s.err.slice(0, 200) })
        const rows = lines(s.out)
        const branchLine = rows[0] || ''
        const cap = clamp(int(a.limit, 40), 1, 500)
        const buckets = { modified: [], addedIndex: [], untracked: [], deleted: [], renamed: [], conflicted: [] }
        for (const l of rows.slice(1)) {
          const x = l[0]
          const y = l[1]
          const f = l.slice(3)
          if (x === '?' && y === '?') buckets.untracked.push(f)
          else if (x === 'U' || y === 'U') buckets.conflicted.push(f)
          else if (x === 'R' || y === 'R') buckets.renamed.push(f)
          else if (y === 'D' || x === 'D') buckets.deleted.push(f)
          else if (x !== ' ') buckets.addedIndex.push(f)
          else if (y !== ' ') buckets.modified.push(f)
        }
        const ahead = (branchLine.match(/ahead (\d+)/) || [])[1]
        const behind = (branchLine.match(/behind (\d+)/) || [])[1]
        return {
          cwd,
          branch: (branchLine.match(/^## (?:HEAD )?(?:No branch on |)?([^.\s(]+)/) || [, branchLine.replace(/^## /, '')])[1],
          ahead: ahead ? Number(ahead) : 0,
          behind: behind ? Number(behind) : 0,
          counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
          files: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.slice(0, cap)])),
          verdict: rows.length <= 1 ? '干净' : `有 ${rows.length - 1} 项改动`,
        }
      },
    },
    {
      name: 'git_log',
      desc: '最近提交列表（可限作者/天数/条数）',
      params: {
        path: { type: 'string', desc: '仓库目录' },
        limit: { type: 'integer', desc: '几条，默认 20' },
        author: { type: 'string', desc: '按作者过滤' },
        sinceDays: { type: 'integer', desc: '只看最近几天' },
        oneline: { type: 'boolean', desc: '一行一条（默认 true）；false 带改动统计' },
      },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const cap = clamp(int(a.limit, 20), 1, 500)
        const args = ['log', `-${cap}`, '--pretty=%h|%ad|%an|%s', '--date=iso']
        if (a.author) args.push(`--author=${a.author}`)
        if (a.sinceDays) args.push(`--since=${int(a.sinceDays, 1)} days ago`)
        const r = await g(ctx, args, cwd)
        if (r.code !== 0) return json({ ok: false, message: r.err.slice(0, 200) })
        const rows = lines(r.out).map((l) => {
          const [h, d, an, ...rest] = l.split('|')
          return { hash: h, date: d, author: an, subject: rest.join('|') }
        })
        let stats = null
        if (a.oneline === false) {
          const st = await g(ctx, ['log', `-${Math.min(cap, 30)}`, '--pretty=format:%h', '--shortstat'], cwd)
          stats = lines(st.out).join('\n').slice(0, 4000)
        }
        return { cwd, count: rows.length, commits: rows, stats }
      },
    },
    {
      name: 'git_diff_stat',
      desc: '改动统计：工作区 vs HEAD（或两个 ref 之间），按文件列增删行',
      params: {
        path: { type: 'string', desc: '仓库目录' },
        from: { type: 'string', desc: '起点 ref，默认 HEAD' },
        to: { type: 'string', desc: '终点 ref，给了就和 from 比；不给就比工作区' },
        staged: { type: 'boolean', desc: '只看已暂存的改动' },
        limit: { type: 'integer', desc: '最多几个文件，默认 60' },
      },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const args = ['diff', '--numstat']
        if (a.staged) args.push('--cached')
        if (a.from && a.to) args.push(`${a.from}...${a.to}`)
        else if (a.from && !a.staged) args.push(a.from)
        const r = await g(ctx, args, cwd)
        if (r.code !== 0) return json({ ok: false, message: r.err.slice(0, 200) })
        const cap = clamp(int(a.limit, 60), 1, 2000)
        const rows = lines(r.out).map((l) => {
          const [add, del, ...f] = l.split('\t')
          return { added: add === '-' ? null : Number(add), deleted: del === '-' ? null : Number(del), file: f.join('\t') }
        })
        const totalAdd = rows.reduce((s, x) => s + (x.added || 0), 0)
        const totalDel = rows.reduce((s, x) => s + (x.deleted || 0), 0)
        return {
          cwd,
          scope: a.from && a.to ? `${a.from}...${a.to}` : a.staged ? 'staged vs HEAD' : '工作区 vs HEAD',
          files: rows.length,
          totalAdded: totalAdd,
          totalDeleted: totalDel,
          rows: rows.slice(0, cap).map((x) => `+${String(x.added ?? '-').padStart(6)} -${String(x.deleted ?? '-').padStart(6)}  ${x.file}`),
        }
      },
    },
    {
      name: 'git_branches',
      desc: '分支清单：本地/远端、当前分支、跟踪关系、最后提交时间',
      params: { path: { type: 'string', desc: '仓库目录' }, remote: { type: 'boolean', desc: '也列远端分支，默认 true' } },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const r = await g(ctx, ['branch', '-vv', '--sort=-committerdate', '--format=%(refname:short)|%(HEAD)|%(committerdate:short)|%(upstream:short)|%(contents:subject)'], cwd)
        if (r.code !== 0) return json({ ok: false, message: r.err.slice(0, 200) })
        const local = lines(r.out).map((l) => {
          const [name, head, date, upstream, subject] = l.split('|')
          return { name, current: head === '*', lastDate: date, upstream: upstream || null, subject: (subject || '').slice(0, 80) }
        })
        let remote = []
        if (a.remote !== false) {
          const rr = await g(ctx, ['branch', '-r', '--sort=-committerdate', '--format=%(refname:short)|%(committerdate:short)'], cwd)
          remote = lines(rr.out).map((l) => {
            const [name, date] = l.split('|')
            return { name, lastDate: date }
          }).slice(0, 40)
        }
        return { cwd, current: (local.find((b) => b.current) || {}).name || null, localCount: local.length, local, remote }
      },
    },
    {
      name: 'git_show',
      desc: '看某个提交：说明、改动文件与行数',
      params: {
        path: { type: 'string', desc: '仓库目录' },
        ref: { type: 'string', desc: '提交号或 ref，默认 HEAD' },
        patch: { type: 'boolean', desc: '带补丁正文（截断），默认 false' },
      },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const ref = a.ref || 'HEAD'
        const meta = await g(ctx, ['show', '--no-patch', '--pretty=%H%n%an <%ae>%n%ad%n%s%n%b', '--date=iso', ref], cwd)
        if (meta.code !== 0) return json({ ok: false, message: meta.err.slice(0, 200) })
        const stat = await g(ctx, ['show', '--numstat', '--pretty=format:', ref], cwd)
        const rows = lines(stat.out).map((l) => {
          const [add, del, ...f] = l.split('\t')
          return `+${String(add).padStart(5)} -${String(del).padStart(5)}  ${f.join('\t')}`
        })
        const out = { cwd, ref, meta: lines(meta.out) }
        const parts = lines(meta.out)
        out.commit = { hash: parts[0], author: parts[1], date: parts[2], subject: parts[3], body: parts.slice(4).join('\n') }
        out.files = rows.length
        out.changed = rows.slice(0, 80)
        if (a.patch) {
          const p = await g(ctx, ['show', '--pretty=format:', '--unified=2', ref], cwd)
          out.patch = String(p.stdout).slice(0, 8000)
        }
        return out
      },
    },
    {
      name: 'git_contributors',
      desc: '贡献者排行（提交数）与最近活跃度',
      params: { path: { type: 'string', desc: '仓库目录' }, limit: { type: 'integer', desc: '前几名，默认 20' } },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const r = await g(ctx, ['shortlog', '-sne', 'HEAD'], cwd, 60000)
        if (r.code !== 0) return json({ ok: false, message: r.err.slice(0, 200) })
        const cap = clamp(int(a.limit, 20), 1, 500)
        const rows = lines(r.out).map((l) => {
          const m = l.trim().match(/^(\d+)\s+(.+)$/)
          return m ? { commits: Number(m[1]), who: m[2] } : null
        }).filter(Boolean)
        const first = await g(ctx, ['log', '--reverse', '--pretty=%ad %an', '--date=short'], cwd, 60000)
        const last = await g(ctx, ['log', '-1', '--pretty=%ad %an %s', '--date=iso'], cwd)
        const total = await g(ctx, ['rev-list', '--count', 'HEAD'], cwd)
        return {
          cwd,
          totalCommits: /^\d+$/.test(total.out.trim()) ? Number(total.out.trim()) : null,
          contributors: rows.length,
          ranking: rows.slice(0, cap).map((x) => `${String(x.commits).padStart(5)}  ${x.who}`),
          firstCommit: lines(first.out)[0] || null,
          lastCommit: lines(last.out)[0] || null,
        }
      },
    },
    {
      name: 'git_file_history',
      desc: '某个文件的改动历史（谁在什么时候改过它）',
      params: {
        path: { type: 'string', desc: '仓库目录' },
        file: { type: 'string', required: true, desc: '仓库内相对路径' },
        limit: { type: 'integer', desc: '几条，默认 20' },
        withDiff: { type: 'boolean', desc: '带最近一次改动补丁', },
      },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const cap = clamp(int(a.limit, 20), 1, 500)
        const args = ['log', `-${cap}`, '--follow', '--numstat', '--pretty=%h|%ad|%an|%s', '--date=short', '--', a.file]
        const r = await g(ctx, args, cwd, 60000)
        if (r.code !== 0) return json({ ok: false, message: r.err.slice(0, 200) })
        const commits = []
        for (const l of lines(r.out)) {
          const parts = l.split('|')
          if (parts.length >= 4 && /^[0-9a-f]{6,40}$/.test(parts[0])) commits.push({ hash: parts[0], date: parts[1], author: parts[2], subject: parts.slice(3).join('|') })
        }
        const out = { cwd, file: a.file, commits: commits.length, history: commits }
        if (a.withDiff) {
          const d = await g(ctx, ['log', '-1', '-p', '--unified=2', '--', a.file], cwd)
          out.lastPatch = String(d.stdout).slice(0, 6000)
        }
        return out
      },
    },
    {
      name: 'git_remap',
      desc: '仓库体检：提交数、贡献者、.git 体积、最大文件、分支数、标签数',
      params: { path: { type: 'string', desc: '仓库目录' }, topFiles: { type: 'integer', desc: '列最大的几个文件，默认 10' } },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const count = await g(ctx, ['rev-list', '--count', 'HEAD'], cwd)
        const branches = await g(ctx, ['branch', '-a', '--format=%(refname:short)'], cwd)
        const tags = await g(ctx, ['tag', '-l'], cwd)
        const remotes = await g(ctx, ['remote', '-v'], cwd)
        const size = await g(ctx, ['count-objects', '-v'], cwd)
        const top = await g(ctx, ['ls-tree', '-r', '--long', '-z', 'HEAD'], cwd, 60000)
        const files = String(top.out).split('\0').filter(Boolean).map((l) => {
          const m = l.match(/^\S+ \S+ \S+ (\d+|-) (.+)$/)
          return m && m[1] !== '-' ? { bytes: Number(m[1]), file: m[2] } : null
        }).filter(Boolean)
        files.sort((x, y) => y.bytes - x.bytes)
        const n = clamp(int(a.topFiles, 10), 1, 100)
        return {
          cwd,
          commits: /^\d+$/.test(count.out.trim()) ? Number(count.out.trim()) : null,
          branches: lines(branches.out).length,
          tags: lines(tags.out).length,
          remotes: lines(remotes.out),
          gitObjects: lines(size.out),
          trackedFiles: files.length,
          trackedBytes: fmtBytes(files.reduce((s, x) => s + x.bytes, 0)),
          largest: files.slice(0, n).map((f) => `${fmtBytes(f.bytes).padStart(10)}  ${f.file}`),
        }
      },
    },
    {
      name: 'git_ls_files',
      desc: '列被跟踪的文件（按扩展名统计 + 前 N 个）',
      params: {
        path: { type: 'string', desc: '仓库目录' },
        pattern: { type: 'string', desc: '路径过滤（子串）' },
        limit: { type: 'integer', desc: '最多列几条，默认 60' },
      },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const r = await g(ctx, ['ls-files'], cwd, 60000)
        if (r.code !== 0) return json({ ok: false, message: r.err.slice(0, 200) })
        let all = lines(r.out)
        const byExt = {}
        for (const f of all) {
          const ext = path.extname(f) || '(无扩展)'
          byExt[ext] = (byExt[ext] || 0) + 1
        }
        if (a.pattern) all = all.filter((f) => f.includes(a.pattern))
        const cap = clamp(int(a.limit, 60), 1, 5000)
        return { cwd, total: all.length, byExtension: Object.entries(byExt).sort((x, y) => y[1] - x[1]).slice(0, 25).map(([e, n]) => `${String(n).padStart(5)} ${e}`), files: all.slice(0, cap) }
      },
    },
    {
      name: 'git_untracked',
      desc: '未跟踪与忽略文件清单（看有什么没纳入版本管理）',
      params: {
        path: { type: 'string', desc: '仓库目录' },
        includeIgnored: { type: 'boolean', desc: '也列 .gitignore 忽略的，默认 false' },
        limit: { type: 'integer', desc: '最多几条，默认 80' },
      },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const args = ['ls-files', '--others', '--exclude-standard']
        if (a.includeIgnored) args.push('-i', '--directory')
        const r = await g(ctx, args, cwd, 60000)
        const rows = lines(r.out)
        const cap = clamp(int(a.limit, 80), 1, 2000)
        const byTop = {}
        for (const f of rows) {
          const top = f.split('/')[0]
          byTop[top] = (byTop[top] || 0) + 1
        }
        return { cwd, total: rows.length, byTopLevel: Object.entries(byTop).sort((x, y) => y[1] - x[1]).slice(0, 20).map(([k, v]) => `${String(v).padStart(5)} ${k}`), files: rows.slice(0, cap) }
      },
    },
    {
      name: 'git_stash',
      desc: '暂存清单，或显式 push/pop/apply/drop',
      write: true,
      params: {
        path: { type: 'string', desc: '仓库目录' },
        action: { type: 'string', desc: 'list|push|pop|apply|drop，默认 list', enum: ['list', 'push', 'pop', 'apply', 'drop'] },
        message: { type: 'string', desc: 'push 的说明' },
        index: { type: 'integer', desc: 'pop/apply/drop 的第几个，默认 0' },
        confirm: { type: 'boolean', desc: '写操作必须 true' },
      },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const action = a.action || 'list'
        if (action === 'list') {
          const r = await g(ctx, ['stash', 'list'], cwd)
          return { cwd, count: lines(r.out).length, stashes: lines(r.out).slice(0, 40) }
        }
        if (a.confirm !== true) return json({ ok: false, message: `${action} 会改动工作区/暂存栈，传 confirm=true 才执行` })
        const args = action === 'push' ? ['stash', 'push', '-m', a.message || 'tey-mcp stash'] : ['stash', action, `stash@{${int(a.index, 0)}}`]
        const r = await g(ctx, args, cwd, 60000)
        return { command: r.cmd, code: r.code, output: lines(r.out).slice(0, 20), stderr: r.err.slice(0, 300) }
      },
    },
    {
      name: 'git_stage',
      desc: 'git add 指定路径（显式调用，confirm 必给）',
      write: true,
      params: {
        path: { type: 'string', desc: '仓库目录' },
        paths: { type: 'array', required: true, desc: '要暂存的路径，例如 ["src","README.md"]', items: { type: 'string', desc: '一个路径' } },
        all: { type: 'boolean', desc: 'true=git add -A（整个仓库）' },
        confirm: { type: 'boolean', desc: '必须 true' },
      },
      async run(a, ctx) {
        if (a.confirm !== true) return json({ ok: false, message: '要暂存文件请传 confirm=true' })
        const cwd = repoOf(ctx, a)
        const args = a.all ? ['add', '-A'] : ['add', '--', ...(a.paths || [])]
        const r = await g(ctx, args, cwd, 60000)
        const after = await g(ctx, ['diff', '--cached', '--stat'], cwd)
        return { command: r.cmd, code: r.code, stderr: r.err.slice(0, 300), stagedNow: lines(after.out).slice(-1)[0] || '（无）', stagedDetail: lines(after.out).slice(0, 30) }
      },
    },
    {
      name: 'git_commit',
      desc: '提交已暂存内容（消息必填 + confirm 必给，不自动推送）',
      write: true,
      params: {
        path: { type: 'string', desc: '仓库目录' },
        message: { type: 'string', required: true, desc: '提交说明' },
        stageAll: { type: 'boolean', desc: '先 git add -A 再提交' },
        confirm: { type: 'boolean', desc: '必须 true' },
      },
      async run(a, ctx) {
        if (a.confirm !== true) return json({ ok: false, message: '提交会写入历史，传 confirm=true 才执行' })
        const cwd = repoOf(ctx, a)
        if (a.stageAll) await g(ctx, ['add', '-A'], cwd, 60000)
        const staged = await g(ctx, ['diff', '--cached', '--name-only'], cwd)
        if (!lines(staged.out).length) return json({ ok: false, message: '没有已暂存的改动，先 git_stage 或传 stageAll=true' })
        const r = await g(ctx, ['commit', '-m', a.message], cwd, 60000)
        const log = await g(ctx, ['log', '-1', '--pretty=%h %ad %s', '--date=short'], cwd)
        return { command: r.cmd, code: r.code, output: lines(r.out).slice(0, 10), stderr: r.err.slice(0, 300), filesCommitted: lines(staged.out).length, head: lines(log.out)[0] }
      },
    },
    {
      name: 'git_push',
      desc: '推送到远端（默认当前分支到 origin，confirm 必给）',
      write: true,
      params: {
        path: { type: 'string', desc: '仓库目录' },
        remote: { type: 'string', desc: '远端名，默认 origin' },
        branch: { type: 'string', desc: '分支，默认当前分支' },
        setUpstream: { type: 'boolean', desc: '加 -u 建立跟踪，默认 true' },
        force: { type: 'boolean', desc: '--force-with-lease' },
        confirm: { type: 'boolean', desc: '必须 true' },
      },
      async run(a, ctx) {
        if (a.confirm !== true) return json({ ok: false, message: '推送会改远端，传 confirm=true 才执行' })
        const cwd = repoOf(ctx, a)
        const br = a.branch || String((await g(ctx, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).out).trim()
        const args = ['push']
        if (a.setUpstream !== false) args.push('-u')
        if (a.force) args.push('--force-with-lease')
        args.push(a.remote || 'origin', br)
        const r = await g(ctx, args, cwd, 180000)
        return { command: r.cmd, code: r.code, output: lines(r.out).slice(0, 12), stderr: lines(r.err).slice(-8) }
      },
    },
    {
      name: 'git_pull',
      desc: '拉取远端（默认 --ff-only，安全；confirm 必给）',
      write: true,
      params: {
        path: { type: 'string', desc: '仓库目录' },
        remote: { type: 'string', desc: '远端名，默认 origin' },
        branch: { type: 'string', desc: '分支，默认当前' },
        rebase: { type: 'boolean', desc: '用 --rebase 而不是 --ff-only' },
        confirm: { type: 'boolean', desc: '必须 true' },
      },
      async run(a, ctx) {
        if (a.confirm !== true) return json({ ok: false, message: '拉取会改工作区，传 confirm=true 才执行' })
        const cwd = repoOf(ctx, a)
        const br = a.branch || String((await g(ctx, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).out).trim()
        const args = ['pull', a.rebase ? '--rebase' : '--ff-only', a.remote || 'origin', br]
        const r = await g(ctx, args, cwd, 180000)
        return { command: r.cmd, code: r.code, output: lines(r.out).slice(0, 15), stderr: lines(r.err).slice(-8) }
      },
    },
    {
      name: 'git_remote_check',
      desc: '远端连通与同步状态：URL、fetch 后领先落后、默认分支',
      params: {
        path: { type: 'string', desc: '仓库目录' },
        fetch: { type: 'boolean', desc: '先 git fetch（慢），默认 true' },
      },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const remotes = await g(ctx, ['remote', '-v'], cwd)
        if (remotes.code !== 0) return json({ ok: false, message: remotes.err.slice(0, 200) })
        const urls = [...new Set(lines(remotes.out).map((l) => l.split(/\s+/)[1]))]
        if (a.fetch !== false) await g(ctx, ['fetch', '--all', '--prune'], cwd, 180000)
        const br = String((await g(ctx, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).out).trim()
        const ahead = await g(ctx, ['rev-list', '--count', `origin/${br}..HEAD`], cwd)
        const behind = await g(ctx, ['rev-list', '--count', `HEAD..origin/${br}`], cwd)
        const head = await g(ctx, ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd)
        return {
          cwd,
          branch: br,
          remotes: lines(remotes.out),
          urls,
          aheadOfOrigin: /^\d+$/.test(ahead.out.trim()) ? Number(ahead.out.trim()) : null,
          behindOrigin: /^\d+$/.test(behind.out.trim()) ? Number(behind.out.trim()) : null,
          originDefaultBranch: head.code === 0 ? head.out.trim() : null,
          verdict: /^\d+$/.test(ahead.out.trim()) && Number(ahead.out.trim()) > 0 ? `本地领先 ${ahead.out.trim()} 个提交，该推了` : '与远端同步',
        }
      },
    },
    {
      name: 'git_tags',
      desc: '标签清单（按创建时间倒序）与最近标签',
      params: { path: { type: 'string', desc: '仓库目录' }, limit: { type: 'integer', desc: '最多几个，默认 30' } },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const r = await g(ctx, ['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)|%(creatordate:short)|%(subject)', 'refs/tags'], cwd)
        const cap = clamp(int(a.limit, 30), 1, 500)
        const rows = lines(r.out).map((l) => {
          const [name, date, subject] = l.split('|')
          return { name, date, subject: (subject || '').slice(0, 80) }
        })
        return { cwd, count: rows.length, tags: rows.slice(0, cap).map((t) => `${t.date}  ${t.name.padEnd(24)} ${t.subject}`), latest: rows[0] || null }
      },
    },
    {
      name: 'git_config_show',
      desc: '仓库 git 配置（user/remote/pull 策略等，敏感项脱敏）',
      params: { path: { type: 'string', desc: '仓库目录' }, localOnly: { type: 'boolean', desc: '只看仓库本地配置，默认 true' } },
      async run(a, ctx) {
        const cwd = repoOf(ctx, a)
        const r = await g(ctx, ['config', a.localOnly === false ? '--list' : '--local', '--list'], cwd)
        if (r.code !== 0) return json({ ok: false, message: r.err.slice(0, 200) })
        const rows = lines(r.out).map((l) => {
          const i = l.indexOf('=')
          const k = l.slice(0, i)
          const v = l.slice(i + 1)
          return `${k} = ${/password|token|credential/i.test(k) ? '***' : v.slice(0, 160)}`
        })
        return { cwd, count: rows.length, config: rows.slice(0, 120) }
      },
    },
  ],
}
