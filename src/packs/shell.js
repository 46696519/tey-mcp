// 系统与进程包：跑命令、看进程端口磁盘、查可执行文件。外部命令一律 ctx.exec，不抛异常。
import { json, int, clamp, fmtBytes, execCmd } from '../util.js'

const MASK = (k) => (/KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL/i.test(k) ? '***' : undefined)

function parseTable(text, cols) {
  const rows = String(text).split(/\r?\n/).filter((l) => l.trim())
  return rows.map((l) => {
    const parts = l.trim().split(/\s{2,}|\t/)
    const o = {}
    cols.forEach((c, i) => {
      o[c] = parts[i] === undefined ? '' : parts[i]
    })
    return o
  })
}

export default {
  id: 'shell',
  title: '系统与进程',
  tags: ['shell', 'exec', 'process', 'system'],
  summary: '跑命令、并发跑一批、进程与端口、磁盘、可执行文件体检',
  tools: [
    {
      name: 'shell_exec',
      desc: '跑一条命令并等它结束（args 数组传参，带超时，返回 code/stdout/stderr）',
      write: true,
      params: {
        command: { type: 'string', required: true, desc: '可执行文件，例如 git / nvidia-smi / node' },
        args: { type: 'array', desc: '参数数组（不要拼成字符串）', items: { type: 'string', desc: '一个参数' } },
        cwd: { type: 'string', desc: '工作目录，默认会话工作区' },
        timeoutMs: { type: 'integer', desc: '超时毫秒，默认 30000' },
        input: { type: 'string', desc: '喂给 stdin 的内容' },
        maxOut: { type: 'integer', desc: 'stdout 最多返回多少字符，默认 8000' },
      },
      async run(a, ctx) {
        const r = await ctx.exec(a.command, a.args || [], { cwd: a.cwd ? ctx.resolve(a.cwd) : ctx.cwd, timeoutMs: a.timeoutMs, input: a.input })
        const cap = clamp(int(a.maxOut, 8000), 200, 200000)
        return {
          command: [a.command, ...(a.args || [])].join(' '),
          cwd: r.cwd || (a.cwd ? ctx.resolve(a.cwd) : ctx.cwd),
          code: r.code,
          timedOut: r.timedOut,
          stdout: r.stdout.length > cap ? `${r.stdout.slice(0, cap)}\n…[stdout 截断 ${r.stdout.length - cap} 字符]` : r.stdout,
          stderr: r.stderr.length > 2000 ? `${r.stderr.slice(0, 2000)}…` : r.stderr,
        }
      },
    },
    {
      name: 'shell_exec_parallel',
      desc: '并发跑多条命令（最多 8 条），逐条返回结果',
      write: true,
      params: {
        commands: { type: 'array', required: true, desc: '命令列表，每项 JSON 文本 {"command":"ls","args":["-l"],"cwd":"."}', items: { type: 'string', desc: '一条命令的 JSON' } },
        concurrency: { type: 'integer', desc: '并发数，默认 4，最多 8' },
        timeoutMs: { type: 'integer', desc: '单条超时，默认 30000' },
      },
      async run(a, ctx) {
        const items = (a.commands || []).slice(0, 8).map((raw) => {
          try {
            return typeof raw === 'string' ? JSON.parse(raw) : raw
          } catch (e) {
            return { __bad: raw }
          }
        })
        const conc = clamp(int(a.concurrency, 4), 1, 8)
        const results = new Array(items.length).fill(null)
        let cursor = 0
        const worker = async () => {
          for (;;) {
            const i = cursor++
            if (i >= items.length) return
            const it = items[i]
            if (!it || it.__bad !== undefined || !it.command) {
              results[i] = { ok: false, message: `不成形: ${JSON.stringify(it).slice(0, 120)}` }
              continue
            }
            const r = await ctx.exec(it.command, it.args || [], { cwd: it.cwd ? ctx.resolve(it.cwd) : ctx.cwd, timeoutMs: it.timeoutMs || a.timeoutMs })
            results[i] = { command: [it.command, ...(it.args || [])].join(' '), code: r.code, timedOut: r.timedOut, stdout: String(r.stdout).slice(0, 4000), stderr: String(r.stderr).slice(0, 800) }
          }
        }
        await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, worker))
        return json({ ran: results.length, results })
      },
    },
    {
      name: 'shell_which',
      desc: '在 PATH 里找可执行文件，报告在不在、在哪',
      params: {
        names: { type: 'array', required: true, desc: '要找的命令名，例如 ["git","ffmpeg","nvidia-smi"]', items: { type: 'string', desc: '命令名' } },
      },
      async run(a, ctx) {
        const out = {}
        const win = process.platform === 'win32'
        for (const name of a.names.slice(0, 40)) {
          const r = win ? await ctx.exec('where', [String(name)]) : await ctx.exec('sh', ['-c', `command -v ${String(name)}`])
          out[name] = r.code === 0 ? { found: true, path: String(r.stdout).split(/\r?\n/)[0].trim() } : { found: false, reason: String(r.stderr).split(/\r?\n/)[0] || '不在 PATH' }
        }
        return out
      },
    },
    {
      name: 'shell_env',
      desc: '列/取环境变量（敏感名自动脱敏）',
      params: {
        name: { type: 'string', desc: '只取这个变量；不给就列全部' },
        filter: { type: 'string', desc: '按名字子串过滤，例如 DSH / CUDA / PATH' },
        limit: { type: 'integer', desc: '最多几条，默认 60' },
      },
      async run(a) {
        if (a.name) {
          const v = process.env[a.name]
          const masked = MASK(a.name)
          return { name: a.name, value: v === undefined ? null : masked || v, exists: v !== undefined }
        }
        const cap = clamp(int(a.limit, 60), 1, 500)
        const rows = Object.entries(process.env)
          .filter(([k]) => !a.filter || k.toUpperCase().includes(String(a.filter).toUpperCase()))
          .slice(0, cap)
          .map(([k, v]) => `${k}=${MASK(k) || String(v).slice(0, 120)}`)
        return rows.join('\n') || '没有匹配的变量'
      },
    },
    {
      name: 'shell_ps',
      desc: '进程列表（按内存/CPU 排序），Windows 与 Linux 都支持',
      params: {
        sort: { type: 'string', desc: 'mem|cpu|name，默认 mem', enum: ['mem', 'cpu', 'name'] },
        filter: { type: 'string', desc: '按进程名过滤（子串）' },
        limit: { type: 'integer', desc: '最多几条，默认 25' },
      },
      async run(a, ctx) {
        const cap = clamp(int(a.limit, 25), 1, 200)
        if (process.platform === 'win32') {
          const r = await ctx.exec('powershell', ['-NoProfile', '-Command', 'Get-Process | Sort-Object WS -Descending | Select-Object -First 60 Id,ProcessName,WS,CPU | Format-Table -AutoSize | Out-String -Width 200'])
          const rows = parseTable(r.stdout, ['Id', 'ProcessName', 'WS', 'CPU']).filter((p) => p.Id && (!a.filter || String(p.ProcessName).toLowerCase().includes(String(a.filter).toLowerCase())))
          return rows.slice(0, cap).map((p) => `${String(p.Id).padEnd(8)} ${String(p.ProcessName).padEnd(30)} ${p.WS}`)
        }
        const key = a.sort === 'cpu' ? '%cpu' : a.sort === 'name' ? 'comm' : '%mem'
        const r = await ctx.exec('ps', ['aux'])
        const lines = String(r.stdout).split(/\r?\n/).filter(Boolean)
        const rows = lines.slice(1).filter((l) => !a.filter || l.toLowerCase().includes(String(a.filter).toLowerCase()))
        const parsed = rows.map((l) => {
          const parts = l.trim().split(/\s+/)
          return { pid: parts[1], cpu: Number(parts[2]) || 0, mem: Number(parts[3]) || 0, cmd: parts.slice(10).join(' ') }
        })
        parsed.sort((x, y) => (a.sort === 'cpu' ? y.cpu - x.cpu : a.sort === 'name' ? x.cmd.localeCompare(y.cmd) : y.mem - x.mem))
        return parsed.slice(0, cap).map((p) => `pid=${p.pid} ${key}=${a.sort === 'cpu' ? p.cpu : p.mem}% ${p.cmd.slice(0, 90)}`)
      },
    },
    {
      name: 'shell_kill',
      desc: '按 pid 结束进程（先 SIGTERM，可 force 用 SIGKILL/taskkill）',
      write: true,
      params: {
        pid: { type: 'integer', required: true, desc: '进程号' },
        force: { type: 'boolean', desc: '强杀，默认 false' },
        dryRun: { type: 'boolean', desc: '只报告会不会命中，默认 true' },
      },
      async run(a, ctx) {
        const pid = int(a.pid, 0)
        if (!pid) return json({ ok: false, message: 'pid 不合法' })
        let alive = true
        try {
          process.kill(pid, 0)
        } catch (e) {
          alive = false
        }
        if (!alive) return json({ ok: false, message: `没有 pid=${pid} 这个进程` })
        if (a.dryRun !== false) return json({ dryRun: true, pid, note: '进程存在；确认要杀传 dryRun=false' })
        const r = process.platform === 'win32' ? await ctx.exec('taskkill', a.force ? ['/PID', String(pid), '/F'] : ['/PID', String(pid)]) : await ctx.exec('kill', a.force ? ['-9', String(pid)] : [String(pid)])
        return json({ pid, forced: !!a.force, code: r.code, message: r.code === 0 ? '已结束' : String(r.stderr).slice(0, 200) })
      },
    },
    {
      name: 'shell_spawn_bg',
      desc: '后台起一个进程（不等结果），返回 pid 与日志文件',
      write: true,
      params: {
        command: { type: 'string', required: true, desc: '可执行文件' },
        args: { type: 'array', desc: '参数数组', items: { type: 'string', desc: '一个参数' } },
        cwd: { type: 'string', desc: '工作目录' },
        logFile: { type: 'string', desc: '日志写到哪，默认插件 tmp 下' },
      },
      async run(a, ctx) {
        const { spawn } = await import('node:child_process')
        const fs = await import('node:fs')
        const path = await import('node:path')
        const log = a.logFile ? ctx.resolve(a.logFile) : ctx.tmp('.log')
        fs.mkdirSync(path.dirname(log), { recursive: true })
        const out = fs.openSync(log, 'a')
        try {
          const child = spawn(a.command, a.args || [], { cwd: a.cwd ? ctx.resolve(a.cwd) : ctx.cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true })
          child.unref()
          return json({ ok: true, pid: child.pid, log, note: '进程已脱离，日志见 log 字段' })
        } catch (e) {
          return json({ ok: false, message: String(e && e.message) })
        }
      },
    },
    {
      name: 'shell_ports',
      desc: '本机监听端口清单（端口/协议/进程），netstat 与 ss 都试',
      params: {
        filter: { type: 'string', desc: '按端口或进程名过滤（子串）' },
        limit: { type: 'integer', desc: '最多几条，默认 40' },
      },
      async run(a, ctx) {
        const cap = clamp(int(a.limit, 40), 1, 300)
        const tries = [['ss', ['-tlnp']], ['netstat', ['-ano']], ['netstat', ['-an']]]
        for (const [cmd, args] of tries) {
          const r = await ctx.exec(cmd, args)
          if (r.code !== 0 || !String(r.stdout).trim()) continue
          const rows = String(r.stdout)
            .split(/\r?\n/)
            .filter((l) => /listen|listening/i.test(l) || /tcp.*listening/i.test(l))
            .filter((l) => !a.filter || l.includes(String(a.filter)))
            .map((l) => l.replace(/\s+/g, ' ').trim().slice(0, 160))
          if (rows.length) return json({ via: `${cmd} ${args.join(' ')}`, total: rows.length, rows: rows.slice(0, cap) })
        }
        return json({ ok: false, message: 'ss / netstat 都没拿到监听端口' })
      },
    },
    {
      name: 'shell_os_info',
      desc: '系统概况：平台/内核/CPU/内存/负载/运行时长/Node 版本',
      params: {},
      async run(_a, ctx) {
        const os = await import('node:os')
        const cpus = os.cpus()
        const load = os.loadavg ? os.loadavg() : []
        const out = {
          platform: os.platform(),
          arch: os.arch(),
          release: os.release(),
          hostname: os.hostname(),
          cpuModel: cpus[0] ? cpus[0].model : '',
          cpuCores: cpus.length,
          cpuSpeedMhz: cpus[0] ? cpus[0].speed : null,
          totalMemory: fmtBytes(os.totalmem()),
          freeMemory: fmtBytes(os.freemem()),
          usedMemoryPercent: Number((100 * (1 - os.freemem() / os.totalmem())).toFixed(1)),
          uptimeSeconds: Math.round(os.uptime()),
          loadAvg: load.map((x) => Number(x.toFixed(2))),
          node: process.version,
          homeDir: os.homedir(),
          platformPathSep: process.platform === 'win32' ? 'C:\\' : '/',
        }
        if (process.platform === 'win32') {
          const r = await ctx.exec('wmic', ['computersystem', 'get', 'manufacturer,model,totalphysicalmemory', '/value'])
          out.system = Object.fromEntries(String(r.stdout).split(/\r?\n/).filter((l) => l.includes('=')).map((l) => {
            const i = l.indexOf('=')
            return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
          }))
        }
        return out
      },
    },
    {
      name: 'shell_disk',
      desc: '各挂载点/盘符的容量与剩余空间',
      params: {},
      async run(_a, ctx) {
        if (process.platform === 'win32') {
          const r = await ctx.exec('wmic', ['logicaldisk', 'get', 'deviceid,size,freespace,volname', '/format:csv'])
          const rows = String(r.stdout).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('Node'))
          const out = rows.map((l) => {
            const p = l.split(',')
            const size = Number(p[3])
            const free = Number(p[2])
            return { device: p[1], free: fmtBytes(free), size: fmtBytes(size), usedPercent: size ? Number((100 * (1 - free / size)).toFixed(1)) : null }
          })
          return out.length ? out : { ok: false, message: 'wmic 没返回盘符信息' }
        }
        const r = await ctx.exec('df', ['-hP'])
        const rows = String(r.stdout).split(/\r?\n/).slice(1).filter((l) => l.trim() && !/^Filesystem/.test(l))
        const out = rows.map((l) => {
          const p = l.trim().split(/\s+/)
          return { filesystem: p[0], size: p[1], used: p[2], free: p[3], percent: p[4], mount: p[5] }
        })
        return out.length ? out : { ok: false, message: 'df 没返回信息' }
      },
    },
    {
      name: 'shell_cmd_health',
      desc: '体检一批常用命令在不在（git/ffmpeg/nvidia-smi/node/python…）',
      params: {
        names: { type: 'array', desc: '要查的命令；不传给常用 20 个默认清单', items: { type: 'string', desc: '命令名' } },
      },
      async run(a, ctx) {
        const defaults = ['git', 'node', 'npm', 'pnpm', 'python', 'pip', 'ffmpeg', 'ffprobe', 'nvidia-smi', 'nvcc', 'cmake', 'gcc', 'make', 'docker', 'kubectl', 'rg', 'jq', 'sqlite3', '7z', 'curl']
        const names = Array.isArray(a.names) && a.names.length ? a.names : defaults
        const out = { missing: [], present: {} }
        for (const name of names.slice(0, 40)) {
          const r = process.platform === 'win32' ? await ctx.exec('where', [String(name)]) : await ctx.exec('sh', ['-c', `command -v ${String(name)}`])
          if (r.code === 0) {
            const first = String(r.stdout).split(/\r?\n/)[0].trim()
            const ver = await ctx.exec(String(name), ['--version'], { timeoutMs: 6000 })
            const vline = String(ver.stdout || ver.stderr).split(/\r?\n/)[0].trim().slice(0, 90)
            out.present[name] = { path: first, version: ver.code === 0 || vline ? vline : null }
          } else out.missing.push(String(name))
        }
        return { checked: names.length, missing: out.missing, present: out.present }
      },
    },
    {
      name: 'shell_tail_log',
      desc: '看日志文件尾部，可按正则过滤并统计命中',
      params: {
        path: { type: 'string', required: true, desc: '日志文件路径' },
        lines: { type: 'integer', desc: '取尾几行，默认 60' },
        pattern: { type: 'string', desc: '只看命中这个正则的行' },
        maxBytes: { type: 'integer', desc: '最多读多少字节，默认 512000' },
      },
      async run(a, ctx) {
        const fs = await import('node:fs')
        const abs = ctx.resolve(a.path)
        const st = fs.statSync(abs)
        const maxBytes = clamp(int(a.maxBytes, 512000), 1024, 8 * 1024 * 1024)
        const size = Math.min(st.size, maxBytes)
        const fd = fs.openSync(abs, 'r')
        const buf = Buffer.alloc(size)
        fs.readSync(fd, buf, 0, size, st.size - size)
        fs.closeSync(fd)
        let rows = buf.toString('utf8').split(/\r?\n/)
        const total = rows.length
        if (a.pattern) {
          const re = new RegExp(a.pattern)
          rows = rows.filter((l) => re.test(l))
        }
        const n = clamp(int(a.lines, 60), 1, 5000)
        return { path: abs, fileSize: fmtBytes(st.size), scannedLines: total, matched: rows.length, tail: rows.slice(-n).map((l) => l.slice(0, 300)) }
      },
    },
    {
      name: 'shell_proc_group',
      desc: '按进程名聚合：各名字的数量、总内存、示例命令行',
      params: {
        minCount: { type: 'integer', desc: '至少几个才列，默认 1' },
        limit: { type: 'integer', desc: '最多几组，默认 25' },
      },
      async run(a, ctx) {
        const cap = clamp(int(a.limit, 25), 1, 200)
        const groups = new Map()
        if (process.platform === 'win32') {
          const r = await ctx.exec('powershell', ['-NoProfile', '-Command', 'Get-Process | Group-Object ProcessName | Sort-Object Count -Descending | Select-Object -First 60 Count,Name | Format-Table -AutoSize | Out-String -Width 120'])
          for (const row of parseTable(r.stdout, ['Count', 'Name'])) {
            if (!row.Count) continue
            groups.set(String(row.Name), { count: Number(row.Count) })
          }
        } else {
          const r = await ctx.exec('ps', ['axo', 'pid=,rss=,comm='])
          for (const line of String(r.stdout).split(/\r?\n/)) {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
            if (!m) continue
            const key = m[3].trim()
            const g = groups.get(key) || { count: 0, rssKb: 0 }
            g.count++
            g.rssKb += Number(m[2]) || 0
            groups.set(key, g)
          }
        }
        const min = int(a.minCount, 1)
        const rows = [...groups.entries()]
          .filter(([, g]) => g.count >= min)
          .sort((x, y) => y[1].count - x[1].count)
          .slice(0, cap)
          .map(([name, g]) => `${String(g.count).padStart(4)}  ${name}${g.rssKb ? `  RSS ${fmtBytes(g.rssKb * 1024)}` : ''}`)
        return rows.length ? rows : { ok: false, message: '没取到进程信息' }
      },
    },
    {
      name: 'shell_path_report',
      desc: 'PATH 各条目是否存在、可写、有多少可执行文件',
      params: {
        limit: { type: 'integer', desc: '最多几条，默认 40' },
        writableOnly: { type: 'boolean', desc: '只列可写的目录' },
      },
      async run(a, ctx) {
        const fs = await import('node:fs')
        const path = await import('node:path')
        const cap = clamp(int(a.limit, 40), 1, 300)
        const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)
        const rows = []
        for (const dir of dirs.slice(0, cap)) {
          const item = { dir, exists: false, writable: false, entries: 0 }
          try {
            const st = fs.statSync(dir)
            item.exists = st.isDirectory()
            if (item.exists) {
              try {
                fs.accessSync(dir, fs.constants.W_OK)
                item.writable = true
              } catch (e) {}
              try {
                item.entries = fs.readdirSync(dir).length
              } catch (e) {}
            }
          } catch (e) {}
          if (a.writableOnly && !item.writable) continue
          rows.push(item)
        }
        return { total: dirs.length, shown: rows.length, rows: rows.map((r) => `${r.exists ? (r.writable ? 'W' : 'r') : '-'} ${String(r.entries).padStart(5)}  ${r.dir}`) }
      },
    },
  ],
}
