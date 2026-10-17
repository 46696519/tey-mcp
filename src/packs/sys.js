// 操作系统状态包：服务、开机启动、计划任务、用户、软件包、防火墙、剪贴板、
// 区域设置、临时目录、环境快照。命令侧交给 shell 包，这里只管"系统状态"。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { json, int, clamp, fmtBytes, fmtMs, readJsonSafe, writeJsonSafe, ensureDir, walkFiles } from '../util.js'

async function ps(ctx, script, timeoutMs = 30000) {
  const r = await ctx.exec('powershell', ['-NoProfile', '-Command', script], { timeoutMs })
  return { ok: r.code === 0, stdout: String(r.stdout), stderr: String(r.stderr), code: r.code }
}

export default {
  id: 'sys',
  title: '操作系统状态',
  tags: ['system', 'service', 'startup', 'packages', 'windows', 'linux'],
  summary: '服务与启动项、计划任务、用户与权限、软件包、防火墙、剪贴板、区域时区、临时目录、环境快照',
  tools: [
    {
      name: 'sys_summary',
      desc: '系统一页摘要：主机/内核/CPU/内存/负载/运行时长/Node',
      params: {},
      async run(_a, ctx) {
        const cpus = os.cpus()
        return {
          hostname: os.hostname(),
          platform: `${os.platform()}/${os.arch()}`,
          kernel: os.release(),
          cpu: cpus[0] ? `${cpus[0].model} × ${cpus.length}` : '未知',
          memory: `${fmtBytes(os.totalmem())} 总 / ${fmtBytes(os.freemem())} 空闲`,
          memoryUsedPercent: Number((100 * (1 - os.freemem() / os.totalmem())).toFixed(1)),
          loadAvg: os.loadavg().map((x) => Number(x.toFixed(2))),
          uptime: fmtMs(Math.round(os.uptime() * 1000)),
          node: process.version,
          pid: process.pid,
          home: os.homedir(),
          tmpdir: os.tmpdir(),
        }
      },
    },
    {
      name: 'sys_memory_detail',
      desc: '内存明细：总量/空闲/RSS/堆、Linux 加 MemAvailable 与 Swap、Windows 加提交限制',
      params: { topProcesses: { type: 'integer', desc: '顺带列前几个吃内存的进程，默认 8' } },
      async run(a, ctx) {
        const m = process.memoryUsage()
        const out = {
          process: { rss: fmtBytes(m.rss), heapTotal: fmtBytes(m.heapTotal), heapUsed: fmtBytes(m.heapUsed), external: fmtBytes(m.external), arrayBuffers: fmtBytes(m.arrayBuffers || 0) },
          system: { total: fmtBytes(os.totalmem()), free: fmtBytes(os.freemem()), usedPercent: Number((100 * (1 - os.freemem() / os.totalmem())).toFixed(1)) },
        }
        if (process.platform === 'linux') {
          try {
            const txt = fs.readFileSync('/proc/meminfo', 'utf8')
            const grab = (k) => {
              const m2 = txt.match(new RegExp(`^${k}:\\s+(\\d+)`))
              return m2 ? fmtBytes(Number(m2[1]) * 1024) : null
            }
            out.meminfo = { MemTotal: grab('MemTotal'), MemAvailable: grab('MemAvailable'), Buffers: grab('Buffers'), Cached: grab('Cached'), SwapTotal: grab('SwapTotal'), SwapFree: grab('SwapFree'), Dirty: grab('Dirty'), Slab: grab('Slab') }
          } catch (e) {}
        } else {
          const r = await ps(ctx, 'Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory,TotalVirtualMemorySize,FreeVirtualMemory,TotalSwapSpaceSize | ConvertTo-Json -Compress')
          try {
            const j = JSON.parse(r.stdout.trim())
            const kb = (v) => (v ? fmtBytes(Number(v) * 1024) : null)
            out.win = { totalPhysical: kb(j.TotalVisibleMemorySize), freePhysical: kb(j.FreePhysicalMemory), totalVirtual: kb(j.TotalVirtualMemorySize), freeVirtual: kb(j.FreeVirtualMemory), swap: kb(j.TotalSwapSpaceSize) }
          } catch (e) {}
        }
        const n = int(a.topProcesses, 8)
        if (n > 0) {
          if (process.platform === 'win32') {
            const r = await ps(ctx, 'Get-Process | Sort-Object WS -Descending | Select-Object -First ' + n + ' Id,ProcessName,@{n="MB";e={[math]::Round($_.WS/1MB,1)}} | ConvertTo-Json -Compress')
            try {
              const arr = JSON.parse(r.stdout.trim())
              out.topProcesses = (Array.isArray(arr) ? arr : [arr]).map((p) => `${String(p.Id).padEnd(7)} ${String(p.MB).padStart(8)}MB  ${p.ProcessName}`)
            } catch (e) {}
          } else {
            const r = await ctx.exec('ps', ['axo', 'pid,rss,comm', '--sort=-rss'], { timeoutMs: 20000 })
            out.topProcesses = String(r.stdout).split(/\r?\n/).slice(1, 1 + n).map((l) => {
              const m2 = l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
              return m2 ? `${m2[1].padEnd(7)} ${fmtBytes(Number(m2[2]) * 1024).padStart(8)}  ${m2[3]}` : l
            })
          }
        }
        return out
      },
    },
    {
      name: 'sys_services',
      desc: '服务清单（systemd unit / Windows 服务），可按状态与关键词过滤',
      params: {
        filter: { type: 'string', desc: '按名字过滤（子串）' },
        state: { type: 'string', desc: 'running|stopped|all，Windows 用 running|stopped，默认 all', enum: ['running', 'stopped', 'all'] },
        limit: { type: 'integer', desc: '最多几条，默认 40' },
      },
      async run(a, ctx) {
        const cap = clamp(int(a.limit, 40), 1, 400)
        if (process.platform === 'win32') {
          const where = a.state === 'running' ? "Where-Object {$_.Status -eq 'Running'}" : a.state === 'stopped' ? "Where-Object {$_.Status -ne 'Running'}" : ''
          const r = await ps(ctx, `Get-CimInstance Win32_Service ${where ? '| ' + where : ''} | Select-Object Name,DisplayName,State,StartMode,ProcessId | Sort-Object Name | ConvertTo-Json -Compress`)
          let arr = []
          try {
            arr = JSON.parse(r.stdout.trim())
            arr = Array.isArray(arr) ? arr : [arr]
          } catch (e) {
            return json({ ok: false, message: String(r.stderr).slice(0, 200) })
          }
          if (a.filter) arr = arr.filter((s) => `${s.Name} ${s.DisplayName}`.toLowerCase().includes(String(a.filter).toLowerCase()))
          return { total: arr.length, services: arr.slice(0, cap).map((s) => `${s.State === 'Running' ? '✓' : 'x'} ${String(s.StartMode).padEnd(9)} ${String(s.Name).padEnd(34)} ${s.DisplayName}`) }
        }
        const args = a.state === 'running' ? ['list-units', '--type=service', '--state=running', '--no-pager', '--plain'] : ['list-units', '--type=service', '--all', '--no-pager', '--plain']
        const r = await ctx.exec('systemctl', args, { timeoutMs: 25000 })
        const rows = String(r.stdout).split(/\r?\n/).slice(1).filter((l) => l.trim()).filter((l) => !a.filter || l.toLowerCase().includes(String(a.filter).toLowerCase()))
        return { total: rows.length, services: rows.slice(0, cap).map((l) => l.replace(/\s+/g, ' ').slice(0, 160)) }
      },
    },
    {
      name: 'sys_service_detail',
      desc: '单个服务详情：状态、启动方式、可执行路径、最近日志行',
      params: {
        name: { type: 'string', required: true, desc: '服务名，例如 nvidia-persistenced / ssh / Docker' },
        logLines: { type: 'integer', desc: '带几行日志，默认 15' },
      },
      async run(a, ctx) {
        const n = clamp(int(a.logLines, 15), 0, 200)
        if (process.platform === 'win32') {
          const r = await ps(ctx, `Get-CimInstance Win32_Service -Filter "Name='${String(a.name).replace(/'/g, "''")}'" | Select-Object * | ConvertTo-Json -Compress`)
          let svc = null
          try {
            svc = JSON.parse(r.stdout.trim())
          } catch (e) {}
          if (!svc) return json({ ok: false, message: `找不到服务 ${a.name}` })
          let events = []
          if (n > 0) {
            const ev = await ps(ctx, `Get-WinEvent -LogName System -MaxEvents 200 -ErrorAction SilentlyContinue | Where-Object {$_.Message -like '*${String(a.name).replace(/'/g, "''")}*'} | Select-Object -First ${n} TimeCreated,LevelDisplayName,Message | ConvertTo-Json -Compress`)
            try {
              const arr = JSON.parse(ev.stdout.trim())
              events = (Array.isArray(arr) ? arr : [arr]).map((e2) => `${e2.TimeCreated} [${e2.LevelDisplayName}] ${String(e2.Message).slice(0, 160)}`)
            } catch (e) {}
          }
          return { name: svc.Name, displayName: svc.DisplayName, state: svc.State, startMode: svc.StartMode, desktopInteract: svc.DesktopInteract, processId: svc.ProcessId, serviceAccount: svc.StartName, pathName: svc.PathName, description: svc.Description, events }
        }
        const s = await ctx.exec('systemctl', ['status', String(a.name), '--no-pager', '--lines', String(n)], { timeoutMs: 25000 })
        const show = await ctx.exec('systemctl', ['show', String(a.name), '-p', 'ExecStart,FragmentPath,LoadState,ActiveState,SubState,UnitFileState,Description,MainPID,MemoryCurrent', '--no-pager'], { timeoutMs: 25000 })
        const props = Object.fromEntries(String(show.stdout).split(/\r?\n/).filter((l) => l.includes('=')).map((l) => {
          const i = l.indexOf('=')
          return [l.slice(0, i), l.slice(i + 1)]
        }))
        return { name: a.name, props, statusOutput: String(s.stdout).split(/\r?\n/).filter(Boolean).slice(0, 40).map((l) => l.slice(0, 200)) }
      },
    },
    {
      name: 'sys_startup_items',
      desc: '开机自启项（注册表 Run / 启动文件夹 / systemd 用户服务）',
      params: { limit: { type: 'integer', desc: '最多几条，默认 40' } },
      async run(a, ctx) {
        const cap = clamp(int(a.limit, 40), 1, 300)
        if (process.platform === 'win32') {
          const r = await ps(ctx, 'Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location,User | ConvertTo-Json -Compress')
          let arr = []
          try {
            const j = JSON.parse(r.stdout.trim())
            arr = Array.isArray(j) ? j : [j]
          } catch (e) {}
          const rows = arr.map((s) => `${String(s.Name).padEnd(28)} ${String(s.Location).slice(0, 40).padEnd(42)} ${String(s.Command).slice(0, 110)}`)
          const reg = await ps(ctx, 'Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" | ConvertTo-Json -Compress')
          let run = {}
          try {
            run = JSON.parse(reg.stdout.trim()) || {}
          } catch (e) {}
          return { total: rows.length, items: rows.slice(0, cap), registryRun: Object.entries(run).filter(([k]) => k !== 'PSPath').map(([k, v]) => `${k} = ${String(v).slice(0, 140)}`) }
        }
        const units = await ctx.exec('systemctl', ['--user', 'list-unit-files', '--type=service', '--no-pager', '--plain'], { timeoutMs: 25000 })
        const enabled = String(units.stdout).split(/\r?\n/).filter((l) => /\benabled\b/.test(l)).map((l) => l.replace(/\s+/g, ' ').slice(0, 160))
        const autostart = path.join(os.homedir(), '.config', 'autostart')
        let desktop = []
        try {
          desktop = fs.readdirSync(autostart).filter((f) => f.endsWith('.desktop'))
        } catch (e) {}
        const cron = await ctx.exec('crontab', ['-l'], { timeoutMs: 15000 })
        return { systemdUserEnabled: enabled.slice(0, cap), autostartDesktop: desktop.slice(0, cap), crontab: String(cron.stdout).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).slice(0, cap) }
      },
    },
    {
      name: 'sys_scheduled_tasks',
      desc: '计划任务（Windows 任务计划程序 / Linux cron 与 timer）',
      params: {
        state: { type: 'string', desc: 'ready|running|disabled|all，默认 all', enum: ['ready', 'running', 'disabled', 'all'] },
        limit: { type: 'integer', desc: '最多几条，默认 40' },
      },
      async run(a, ctx) {
        const cap = clamp(int(a.limit, 40), 1, 300)
        if (process.platform === 'win32') {
          const r = await ps(ctx, 'Get-ScheduledTask | ForEach-Object { $i=$_.TaskPath+$_.TaskName; [pscustomobject]@{Task=$i;State=$_.State;Last=(Get-ScheduledTaskInfo -TaskName $_.TaskName -TaskPath $_.TaskPath -ErrorAction SilentlyContinue).LastRunTime} } | Sort-Object Task | ConvertTo-Json -Compress')
          let arr = []
          try {
            const j = JSON.parse(r.stdout.trim())
            arr = Array.isArray(j) ? j : [j]
          } catch (e) {
            return json({ ok: false, message: String(r.stderr).slice(0, 200) })
          }
          if (a.state && a.state !== 'all') arr = arr.filter((t) => String(t.State).toLowerCase() === a.state)
          return { total: arr.length, tasks: arr.slice(0, cap).map((t) => `${String(t.State).padEnd(9)} ${t.Task}`) }
        }
        const timers = await ctx.exec('systemctl', ['list-timers', '--all', '--no-pager', '--plain'], { timeoutMs: 25000 })
        const cronFiles = []
        for (const d of ['/etc/cron.d', '/etc/cron.daily', '/etc/cron.hourly', '/etc/cron.weekly']) {
          try {
            cronFiles.push(`${d}: ${fs.readdirSync(d).join(', ')}`)
          } catch (e) {}
        }
        const userCron = await ctx.exec('crontab', ['-l'], { timeoutMs: 15000 })
        return {
          timers: String(timers.stdout).split(/\r?\n/).slice(1).filter((l) => l.trim()).slice(0, cap).map((l) => l.replace(/\s+/g, ' ').slice(0, 170)),
          cronFiles,
          userCrontab: String(userCron.stdout).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).slice(0, cap),
        }
      },
    },
    {
      name: 'sys_users',
      desc: '当前用户与系统用户清单、所属组、是否管理员',
      params: {},
      async run(_a, ctx) {
        const out = { currentUser: os.userInfo().username, uid: os.userInfo().uid, home: os.homedir(), shell: os.userInfo().shell }
        if (process.platform === 'win32') {
          const r = await ps(ctx, 'whoami /groups | Select-String "S-1-5-32-544","S-1-5-32-545","Mandatory Label" | Out-String')
          out.groups = String(r.stdout).split(/\r?\n/).filter((l) => l.trim()).slice(0, 12)
          const users = await ps(ctx, 'Get-LocalUser | Select-Object Name,Enabled,LastLogon | ConvertTo-Json -Compress')
          try {
            const j = JSON.parse(users.stdout.trim())
            out.localUsers = (Array.isArray(j) ? j : [j]).map((u) => `${u.Enabled ? '✓' : 'x'} ${u.Name}  ${u.LastLogon || ''}`)
          } catch (e) {}
          out.isAdmin = /S-1-5-32-544/.test(String(r.stdout))
        } else {
          const r = await ctx.exec('id', [], { timeoutMs: 10000 })
          out.id = String(r.stdout).trim()
          const passwd = await fs.promises.readFile('/etc/passwd', 'utf8').catch(() => '')
          out.users = passwd.split(/\r?\n/).filter((l) => l.trim() && Number((l.split(':')[2] || '9999')) < 1000).map((l) => l.split(':').slice(0, 3).join(':')).slice(0, 40)
          out.isAdmin = Number(os.userInfo().uid) === 0
        }
        return out
      },
    },
    {
      name: 'sys_packages',
      desc: '已装软件包统计（dpkg/rpm/npm -g/pip），各来源取前 N',
      params: {
        source: { type: 'string', desc: 'auto|dpkg|rpm|npm|pip|choco|winget，默认 auto', enum: ['auto', 'dpkg', 'rpm', 'npm', 'pip', 'choco', 'winget'] },
        filter: { type: 'string', desc: '按包名过滤' },
        limit: { type: 'integer', desc: '每种最多几条，默认 25' },
      },
      async run(a, ctx) {
        const cap = clamp(int(a.limit, 25), 1, 500)
        const f = a.filter ? String(a.filter).toLowerCase() : null
        const out = {}
        const run = async (label, cmd, args, parse) => {
          const r = await ctx.exec(cmd, args, { timeoutMs: 60000 })
          if (r.code !== 0 && !String(r.stdout).trim()) {
            out[label] = { unavailable: String(r.stderr).split(/\r?\n/)[0] || '命令不可用' }
            return
          }
          const rows = parse(String(r.stdout)).filter((x) => !f || x.toLowerCase().includes(f))
          out[label] = { total: rows.length, sample: rows.slice(0, cap) }
        }
        const src = a.source || 'auto'
        if (src === 'auto' || src === 'dpkg') if (process.platform !== 'win32') await run('dpkg', 'dpkg-query', ['-W', '${Package} ${Version}'], (t) => t.split(/\r?\n/).filter(Boolean))
        if (src === 'auto' || src === 'rpm') if (process.platform !== 'win32') await run('rpm', 'rpm', ['-qa', '--queryformat', '%{NAME} %{VERSION}\\n'], (t) => t.split(/\r?\n/).filter(Boolean))
        if (src === 'auto' || src === 'npm') await run('npm-global', 'npm', ['-g', 'ls', '--depth=0', '--parseable'], (t) => t.split(/\r?\n/).map((l) => l.split(':').slice(-1)[0]).filter((x) => x && x !== 'null'))
        if (src === 'auto' || src === 'pip') await run('pip', 'pip', ['list', '--format=freeze'], (t) => t.split(/\r?\n/).filter(Boolean))
        if (src === 'choco') await run('choco', 'choco', ['list', '--local-only', '--limit-output'], (t) => t.split(/\r?\n/).map((l) => l.replace('|', ' ')).filter(Boolean))
        if (src === 'winget') await run('winget', 'winget', ['list', '--accept-source-agreements'], (t) => t.split(/\r?\n/).slice(2).filter(Boolean))
        return out
      },
    },
    {
      name: 'sys_firewall',
      desc: '防火墙状态（Windows 三档配置文件 / ufw / firewalld）',
      params: {},
      async run(_a, ctx) {
        if (process.platform === 'win32') {
          const r = await ps(ctx, 'Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction | ConvertTo-Json -Compress')
          try {
            const j = JSON.parse(r.stdout.trim())
            const arr = Array.isArray(j) ? j : [j]
            return { profiles: arr.map((p) => `${p.Enabled ? '开' : '关'} ${String(p.Name).padEnd(10)} 入站:${p.DefaultInboundAction} 出站:${p.DefaultOutboundAction}`) }
          } catch (e) {
            const r2 = await ctx.exec('netsh', ['advfirewall', 'firewall', 'show', 'allprofiles', 'state'], { timeoutMs: 25000 })
            return { raw: String(r2.stdout).split(/\r?\n/).filter(Boolean).slice(0, 20) }
          }
        }
        const ufw = await ctx.exec('ufw', ['status', 'numbered'], { timeoutMs: 20000 })
        const fw = await ctx.exec('firewall-cmd', ['--state', '--list-all'], { timeoutMs: 20000 })
        return {
          ufw: ufw.code === 0 ? String(ufw.stdout).split(/\r?\n/).filter(Boolean).slice(0, 30) : { unavailable: String(ufw.stderr).slice(0, 120) },
          firewalld: fw.code === 0 ? String(fw.stdout).split(/\r?\n/).filter(Boolean).slice(0, 30) : { unavailable: String(fw.stderr).slice(0, 120) },
        }
      },
    },
    {
      name: 'sys_locale_tz',
      desc: '区域设置与时区：locale、系统时区、UTC 偏移、语言、字符集',
      params: {},
      async run(_a, ctx) {
        const d = new Date()
        const out = {
          nodeLocale: Intl.DateTimeFormat().resolvedOptions().locale,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          tzOffsetMinutes: -d.getTimezoneOffset(),
          tzOffsetLabel: `UTC${-d.getTimezoneOffset() / 60 >= 0 ? '+' : ''}${-d.getTimezoneOffset() / 60}`,
          nowLocal: d.toString(),
          nowUtc: d.toISOString(),
          env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(LANG|LC_|TZ|LANGUAGE|CODESET|SYSTEMROOT)$/i.test(k))),
        }
        if (process.platform === 'win32') {
          const r = await ps(ctx, 'Get-Culture | Select-Object Name,DisplayName | ConvertTo-Json -Compress; Get-TimeZone | Select-Object Id,DisplayName,BaseUtcOffset | ConvertTo-Json -Compress')
          const parts = String(r.stdout).split(/\r?\n/).filter((l) => l.trim())
          try {
            out.culture = JSON.parse(parts[0])
            out.winTz = JSON.parse(parts[1])
          } catch (e) {}
        } else {
          const loc = await ctx.exec('locale', [], { timeoutMs: 15000 })
          out.locale = Object.fromEntries(String(loc.stdout).split(/\r?\n/).filter((l) => l.includes('=')).map((l) => {
            const i = l.indexOf('=')
            return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]
          }))
          const tz = await ctx.exec('timedatectl', ['show', '-p', 'Timezone,LocalRTC,NTPSynchronized'], { timeoutMs: 15000 })
          out.timedate = Object.fromEntries(String(tz.stdout).split(/\r?\n/).filter((l) => l.includes('=')).map((l) => {
            const i = l.indexOf('=')
            return [l.slice(0, i), l.slice(i + 1)]
          }))
        }
        return out
      },
    },
    {
      name: 'sys_uptime_boot',
      desc: '开机时间与运行时长（含上次启动的绝对时间）',
      params: {},
      async run(_a, ctx) {
        const upMs = Math.round(os.uptime() * 1000)
        const boot = new Date(Date.now() - upMs)
        const out = { uptimeMs: upMs, uptimeHuman: fmtMs(upMs), bootTime: boot.toISOString(), now: new Date().toISOString() }
        if (process.platform === 'win32') {
          const r = await ps(ctx, '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime | ConvertTo-Json -Compress')
          out.lastBoot = String(r.stdout).trim().replace(/^"|"$/g, '')
        } else {
          const r = await ctx.exec('uptime', ['-s'], { timeoutMs: 10000 })
          out.bootViaUptime = String(r.stdout).trim()
          const load = await ctx.exec('uptime', [], { timeoutMs: 10000 })
          out.uptimeLine = String(load.stdout).trim()
        }
        return out
      },
    },
    {
      name: 'sys_tmp_usage',
      desc: '临时目录占用：目录、文件数、大小、最老文件（清理前先看这个）',
      params: {
        path: { type: 'string', desc: '要看的目录，默认 os.tmpdir() 与插件 tmp' },
        maxFiles: { type: 'integer', desc: '最多统计多少个，默认 20000' },
        oldest: { type: 'integer', desc: '列最老几个文件，默认 10' },
      },
      async run(a, ctx) {
        const targets = a.path ? [ctx.resolve(a.path)] : [os.tmpdir(), ctx.tmp('.probe').replace(/[^\\/]*\.[a-z0-9]+$/i, '')]
        const maxFiles = clamp(int(a.maxFiles, 20000), 100, 200000)
        const rows = []
        for (const dir of targets) {
          const files = walkFiles(dir, { maxFiles })
          let bytes = 0
          const items = []
          for (const f of files) {
            try {
              const st = await fs.promises.stat(f)
              bytes += st.size
              items.push({ f, size: st.size, mtime: st.mtimeMs })
            } catch (e) {}
          }
          items.sort((x, y) => x.mtime - y.mtime)
          rows.push({ dir, exists: fs.existsSync(dir), files: files.length, size: fmtBytes(bytes), oldest: items.slice(0, clamp(int(a.oldest, 10), 0, 100)).map((i) => `${new Date(i.mtime).toISOString().slice(0, 16)} ${fmtBytes(i.size).padStart(9)} ${i.f.replace(dir, '.')}`) })
        }
        return { tmpdir: os.tmpdir(), scanned: rows }
      },
    },
    {
      name: 'sys_env_snapshot',
      desc: '环境变量快照：存一份基线，之后可 diff 看谁改了环境变量',
      write: true,
      params: {
        action: { type: 'string', required: true, desc: 'save|diff|list', enum: ['save', 'diff', 'list'] },
        name: { type: 'string', desc: '快照名，默认 default' },
      },
      async run(a) {
        const dir = path.join(process.env.DSH_HOME_DIR || path.join(os.homedir(), '.dsh'), 'tey-mcp', 'env')
        ensureDir(dir)
        const file = path.join(dir, `${String(a.name || 'default').replace(/[^\w.-]/g, '_')}.json`)
        const cur = {}
        for (const [k, v] of Object.entries(process.env)) cur[k] = /KEY|PASSWORD|SECRET|TOKEN/i.test(k) ? '***' : String(v)
        if (a.action === 'save') {
          writeJsonSafe(file, { takenAt: Date.now(), count: Object.keys(cur).length, vars: cur })
          return { saved: file, count: Object.keys(cur).length }
        }
        if (a.action === 'list') return { file, exists: fs.existsSync(file), count: Object.keys(cur).length, keys: Object.keys(cur).sort().slice(0, 200) }
        const snap = readJsonSafe(file, null)
        if (!snap) return json({ ok: false, message: `没有快照 ${file}，先 action=save` })
        const added = Object.keys(cur).filter((k) => !(k in snap.vars))
        const removed = Object.keys(snap.vars).filter((k) => !(k in cur))
        const changed = Object.keys(cur).filter((k) => k in snap.vars && snap.vars[k] !== cur[k])
        return { snapshotTakenAt: new Date(snap.takenAt).toISOString(), added, removed, changed: changed.map((k) => `${k}: ${String(snap.vars[k]).slice(0, 60)} → ${String(cur[k]).slice(0, 60)}`) }
      },
    },
    {
      name: 'sys_clipboard',
      desc: '读/写系统剪贴板文本（Windows 用 Get-Clipboard，Linux 试 xclip/wl-paste）',
      write: true,
      params: {
        action: { type: 'string', required: true, desc: 'read|write|append', enum: ['read', 'write', 'append'] },
        text: { type: 'string', desc: 'write/append 的文本' },
        maxChars: { type: 'integer', desc: 'read 最多返回字符，默认 4000' },
      },
      async run(a, ctx) {
        const cap = clamp(int(a.maxChars, 4000), 100, 200000)
        const readCmd = process.platform === 'win32' ? ['powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']] : (await ctx.exec('wl-paste', ['--no-newline'], { timeoutMs: 5000 })).code === 0 ? ['wl-paste', ['--no-newline']] : ['xclip', ['-selection', 'clipboard', '-o']]
        if (a.action === 'read') {
          const r = await ctx.exec(readCmd[0], readCmd[1], { timeoutMs: 15000 })
          return r.code === 0 ? { text: String(r.stdout).slice(0, cap), chars: String(r.stdout).length } : json({ ok: false, message: String(r.stderr).slice(0, 200) })
        }
        const t = String(a.text === undefined ? '' : a.text)
        if (process.platform === 'win32') {
          const script = a.action === 'append' ? `$s=Get-Clipboard -Raw; Set-Clipboard -Value ($s + ${JSON.stringify(t)})` : `Set-Clipboard -Value ${JSON.stringify(t)}`
          const r = await ctx.exec('powershell', ['-NoProfile', '-Command', script], { timeoutMs: 15000 })
          return r.code === 0 ? { ok: true, chars: t.length } : json({ ok: false, message: String(r.stderr).slice(0, 200) })
        }
        const tool = (await ctx.exec('wl-copy', [], { timeoutMs: 4000 })).code === 0 ? 'wl-copy' : 'xclip'
        const args = tool === 'wl-copy' ? (a.action === 'append' ? ['--append'] : []) : ['-selection', 'clipboard']
        const prev = a.action === 'append' ? String((await ctx.exec(readCmd[0], readCmd[1], { timeoutMs: 10000 })).stdout) : ''
        const r = await ctx.exec(tool, args, { timeoutMs: 15000, input: prev + t })
        return r.code === 0 ? { ok: true, via: tool, chars: t.length } : json({ ok: false, message: String(r.stderr).slice(0, 200) })
      },
    },
    {
      name: 'sys_clip_history',
      desc: '读 dsh-clipper 剪贴板历史库（装了才可用）：条数、最近内容、搜索',
      params: {
        query: { type: 'string', desc: '按内容搜（子串）' },
        limit: { type: 'integer', desc: '最多几条，默认 20' },
      },
      async run(a) {
        const { DatabaseSync } = await import('node:sqlite').catch(() => ({}))
        const base = path.join(process.env.DSH_HOME_DIR || path.join(os.homedir(), '.dsh'), 'clipper')
        let file = null
        try {
          const dbs = fs.readdirSync(base).filter((f) => f.endsWith('.db')).map((f) => ({ f, s: fs.statSync(path.join(base, f)).size })).sort((x, y) => y.s - x.s)
          if (dbs.length) file = path.join(base, dbs[0].f)
        } catch (e) {}
        if (!file) return json({ ok: false, message: `没找到剪贴板历史库（${base}）。没装 dsh-clipper 就用 sys_clipboard read` })
        const out = { file, size: fmtBytes(fs.statSync(file).size) }
        if (!DatabaseSync) return { ...out, note: '本机 Node 没有 node:sqlite' }
        try {
          const db = new DatabaseSync(file, { readOnly: true })
          try {
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name)
            out.tables = tables
            const main = tables.find((t) => /clip|entry|item|history/i.test(t)) || tables[0]
            if (main) {
              const cols = db.prepare(`PRAGMA table_info("${main}")`).all().map((c) => c.name)
              out.columns = cols
              const textCol = cols.find((c) => /text|content|value|body/i.test(c))
              const tsCol = cols.find((c) => /time|created|at|ts/i.test(c))
              const cap = clamp(int(a.limit, 20), 1, 200)
              const where = a.query && textCol ? ` WHERE "${textCol}" LIKE ?` : ''
              const sql = `SELECT * FROM "${main}"${where}${tsCol ? ` ORDER BY "${tsCol}" DESC` : ''} LIMIT ${cap}`
              out.rows = db.prepare(sql).all(...(a.query && textCol ? [`%${a.query}%`] : [])).map((r) => JSON.stringify(r).slice(0, 300))
              out.total = db.prepare(`SELECT COUNT(*) AS c FROM "${main}"`).get().c
            }
          } finally {
            db.close()
          }
        } catch (e) {
          out.note = `读库失败: ${String(e && e.message).slice(0, 140)}`
        }
        return out
      },
    },
    {
      name: 'sys_gpu_raw',
      desc: 'nvidia-smi 原文直传（要什么参数给什么），没有驱动就返回原因',
      params: {
        args: { type: 'array', desc: '参数数组，默认 ["-q"]', items: { type: 'string', desc: '一个参数' } },
        timeoutMs: { type: 'integer', desc: '超时，默认 25000' },
        maxChars: { type: 'integer', desc: '最多返回字符，默认 12000' },
      },
      async run(a, ctx) {
        const args = Array.isArray(a.args) && a.args.length ? a.args : ['-q']
        const r = await ctx.exec('nvidia-smi', args, { timeoutMs: clamp(int(a.timeoutMs, 25000), 3000, 120000) })
        const txt = String(r.stdout)
        if (!txt.trim()) return json({ ok: false, message: `nvidia-smi 无输出: ${String(r.stderr).slice(0, 200)}` })
        const cap = clamp(int(a.maxChars, 12000), 500, 200000)
        return { command: `nvidia-smi ${args.join(' ')}`, code: r.code, chars: txt.length, output: txt.slice(0, cap) }
      },
    },
    {
      name: 'sys_disk_io',
      desc: '磁盘 IO 采样（Linux /proc/diskstats 两次差值；Windows 用 Get-Counter）',
      params: {
        seconds: { type: 'integer', desc: '采样间隔秒，默认 2' },
        device: { type: 'string', desc: '只看某设备，例如 sda / nvme0n1' },
      },
      async run(a, ctx) {
        const secs = clamp(int(a.seconds, 2), 1, 15)
        if (process.platform === 'linux') {
          const read = () => {
            const txt = fs.readFileSync('/proc/diskstats', 'utf8')
            const out = {}
            for (const line of txt.split(/\r?\n/)) {
              const p = line.trim().split(/\s+/)
              if (p.length < 14) continue
              const dev = p[2]
              if (a.device && dev !== a.device) continue
              if (!/^(sd[a-z]|nvme\d+n\d|vd[a-z]|hd[a-z])$/.test(dev)) continue
              out[dev] = { reads: Number(p[3]), writes: Number(p[6]), readSectors: Number(p[5]), writeSectors: Number(p[9]), ioMs: Number(p[12]) }
            }
            return out
          }
          const t1 = read()
          await new Promise((r) => setTimeout(r, secs * 1000))
          const t2 = read()
          const rows = []
          for (const dev of Object.keys(t2)) {
            const a2 = t1[dev]
            if (!a2) continue
            const rps = (t2[dev].reads - a2.reads) / secs
            const wps = (t2[dev].writes - a2.writes) / secs
            const rmb = ((t2[dev].readSectors - a2.readSectors) * 512 / secs) / 1048576
            const wmb = ((t2[dev].writeSectors - a2.writeSectors) * 512 / secs) / 1048576
            const util = ((t2[dev].ioMs - a2.ioMs) / (secs * 1000) * 100).toFixed(1)
            rows.push({ dev, readIops: Number(rps.toFixed(1)), writeIops: Number(wps.toFixed(1)), readMBs: Number(rmb.toFixed(2)), writeMBs: Number(wmb.toFixed(2)), utilPercent: Number(util) })
          }
          return { seconds: secs, devices: rows.length, rows: rows.map((r) => `${r.dev.padEnd(10)} R ${String(r.readIops).padStart(7)} iops ${String(r.readMBs).padStart(8)} MB/s | W ${String(r.writeIops).padStart(7)} iops ${String(r.writeMBs).padStart(8)} MB/s | util ${r.utilPercent}%`), note: rows.length ? null : '没匹配到整盘设备（容器里可能读不到）' }
        }
        const r = await ps(ctx, `Get-Counter '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec','\\PhysicalDisk(_Total)\\Disk Write Bytes/sec','\\PhysicalDisk(_Total)\\% Disk Time','\\PhysicalDisk(_Total)\\Current Disk Queue Length' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CounterSamples | Select-Object Path,CookedValue | ConvertTo-Json -Compress`, 40000)
        try {
          const j = JSON.parse(r.stdout.trim())
          const arr = Array.isArray(j) ? j : [j]
          return { via: 'Get-Counter', counters: arr.map((c) => `${String(c.CookedValue).padStart(14)}  ${c.Path.replace('localhost\\', '')}`) }
        } catch (e) {
          return json({ ok: false, message: String(r.stderr).slice(0, 240) })
        }
      },
    },
    {
      name: 'sys_process_io',
      desc: '看某进程的 IO 与句柄（Linux /proc/PID/io；Windows 进程对象）',
      params: { pid: { type: 'integer', required: true, desc: '进程号' } },
      async run(a, ctx) {
        const pid = int(a.pid, 0)
        if (!pid) return json({ ok: false, message: 'pid 不合法' })
        if (process.platform === 'linux') {
          const base = `/proc/${pid}`
          if (!fs.existsSync(base)) return json({ ok: false, message: `没有 pid=${pid}` })
          const readKv = async (f) => Object.fromEntries((await fs.promises.readFile(`${base}/${f}`, 'utf8').catch(() => '')).split(/\r?\n/).filter((l) => l.includes(':')).map((l) => {
            const i = l.indexOf(':')
            return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
          }))
          const io = await readKv('io')
          const status = await readKv('status')
          let fds = null
          try {
            fds = fs.readdirSync(`${base}/fd`).length
          } catch (e) {}
          return {
            pid,
            name: status.Name,
            state: status.State,
            threads: status.Threads,
            rssKb: status.VmRSS,
            fds,
            ioReadBytes: io.read_bytes ? fmtBytes(Number(io.read_bytes)) : null,
            ioWriteBytes: io.write_bytes ? fmtBytes(Number(io.write_bytes)) : null,
            ioCancelled: io.cancelled_write_bytes ? fmtBytes(Number(io.cancelled_write_bytes)) : null,
            cmdline: (await fs.promises.readFile(`${base}/cmdline`, 'utf8').catch(() => '')).replace(/\0/g, ' ').trim().slice(0, 300),
          }
        }
        const r = await ps(ctx, `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WS,HandleCount,ThreadCount,IOReadBytes,IOWriteBytes,Path,StartTime | ConvertTo-Json -Compress`)
        try {
          const j = JSON.parse(r.stdout.trim())
          return { pid, name: j.ProcessName, workingSet: j.WS ? fmtBytes(j.WS) : null, handles: j.HandleCount, threads: j.ThreadCount, ioRead: j.IOReadBytes ? fmtBytes(j.IOReadBytes) : null, ioWrite: j.IOWriteBytes ? fmtBytes(j.IOWriteBytes) : null, path: j.Path, startTime: j.StartTime }
        } catch (e) {
          return json({ ok: false, message: `拿不到 pid=${pid}：${String(r.stderr).slice(0, 160)}` })
        }
      },
    },
    {
      name: 'sys_open_files',
      desc: '某进程打开的文件（Linux /proc/PID/fd；Windows 需 handle.exe，缺则给模块列表）',
      params: {
        pid: { type: 'integer', required: true, desc: '进程号' },
        filter: { type: 'string', desc: '按路径子串过滤' },
        limit: { type: 'integer', desc: '最多几条，默认 60' },
      },
      async run(a, ctx) {
        const pid = int(a.pid, 0)
        const cap = clamp(int(a.limit, 60), 1, 2000)
        if (process.platform === 'linux') {
          const dir = `/proc/${pid}/fd`
          if (!fs.existsSync(`/proc/${pid}`)) return json({ ok: false, message: `没有 pid=${pid}` })
          let names = []
          try {
            names = fs.readdirSync(dir)
          } catch (e) {
            return json({ ok: false, message: `读不了 ${dir}（权限不足？加 sudo）` })
          }
          const rows = []
          for (const n of names) {
            try {
              const link = await fs.promises.readlink(path.join(dir, n))
              if (a.filter && !link.includes(a.filter)) continue
              rows.push(`${n} → ${link}`)
            } catch (e) {}
            if (rows.length >= cap) break
          }
          return { pid, total: names.length, shown: rows.length, files: rows }
        }
        const r = await ps(ctx, `Get-Process -Id ${pid} -Module -ErrorAction SilentlyContinue | Select-Object -First ${cap} ModuleName,FileName | ConvertTo-Json -Compress`)
        try {
          const j = JSON.parse(r.stdout.trim())
          const arr = (Array.isArray(j) ? j : [j]).filter((m) => !a.filter || String(m.FileName).includes(a.filter))
          return { pid, note: 'Windows 列模块（完整句柄需 Sysinternals handle.exe）', count: arr.length, modules: arr.map((m) => `${m.ModuleName}  ${m.FileName}`) }
        } catch (e) {
          return json({ ok: false, message: String(r.stderr).slice(0, 200) })
        }
      },
    },
    {
      name: 'sys_hardware',
      desc: '硬件画像：主板/CPU/内存条/磁盘型号/BIOS（Windows CIM，Linux dmidecode）',
      params: {},
      async run(_a, ctx) {
        if (process.platform === 'win32') {
          const grab = async (label, script) => {
            const r = await ps(ctx, script, 40000)
            try {
              const j = JSON.parse(r.stdout.trim())
              return (Array.isArray(j) ? j : [j]).map((x) => JSON.stringify(x)).slice(0, 12)
            } catch (e) {
              return [String(r.stderr).slice(0, 120)]
            }
          }
          return {
            bios: await grab('bios', 'Get-CimInstance Win32_BIOS | Select-Object Manufacturer,SMBIOSBIOSVersion,ReleaseDate | ConvertTo-Json -Compress'),
            board: await grab('board', 'Get-CimInstance Win32_BaseBoard | Select-Object Manufacturer,Product,Version | ConvertTo-Json -Compress'),
            cpu: await grab('cpu', 'Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,Manufacturer | ConvertTo-Json -Compress'),
            memory: await grab('memory', 'Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity,Speed,Manufacturer,PartNumber,DeviceLocator | ConvertTo-Json -Compress'),
            disks: await grab('disks', 'Get-PhysicalDisk | Select-Object FriendlyName,MediaType,Size,BusType,HealthStatus | ConvertTo-Json -Compress'),
          }
        }
        const dmi = await ctx.exec('dmidecode', ['-t', 'bios', '-t', 'baseboard', '-t', 'processor', '-t', 'memory'], { timeoutMs: 40000 })
        const lsblk = await ctx.exec('lsblk', ['-d', '-o', 'NAME,MODEL,SIZE,TYPE,ROTA,TRAN'], { timeoutMs: 20000 })
        return {
          dmidecode: dmi.code === 0 ? String(dmi.stdout).split(/\r?\n/).filter((l) => /Vendor|Version|Product Name|Manufacturer|Speed|Size|Part Number|Model Name/.test(l)).slice(0, 40) : { unavailable: String(dmi.stderr).slice(0, 140) },
          disks: String(lsblk.stdout).split(/\r?\n/).filter(Boolean).slice(0, 30),
          cpuinfo: (() => {
            try {
              const t = fs.readFileSync('/proc/cpuinfo', 'utf8')
              return { model: (t.match(/model name\s*:\s*(.+)/) || [])[1], siblings: (t.match(/siblings\s*:\s*(.+)/) || [])[1], flagsAvx2: /flags.*\savx2\s/.test(t), flagsAvx512: /avx512/.test(t) }
            } catch (e) {
              return null
            }
          })(),
        }
      },
    },
    {
      name: 'sys_power_plan',
      desc: '电源方案与睡眠设置（Windows 电源计划；Linux 读 /sys 与 logind 配置）',
      params: {},
      async run(_a, ctx) {
        if (process.platform === 'win32') {
          const r = await ctx.exec('powercfg', ['/getactivescheme'], { timeoutMs: 20000 })
          const list = await ctx.exec('powercfg', ['/list'], { timeoutMs: 20000 })
          const sleep = await ctx.exec('powercfg', ['/query', '/SCHEME_CURRENT', '/SUB_SLEEP'], { timeoutMs: 25000 })
          const hibernate = await ctx.exec('powercfg', ['/availablesleepstates'], { timeoutMs: 20000 })
          return {
            active: String(r.stdout).trim().slice(0, 200),
            schemes: String(list.stdout).split(/\r?\n/).filter((l) => /GUID/.test(l)).slice(0, 10),
            sleepTimeouts: String(sleep.stdout).split(/\r?\n/).filter((l) => /设置|Setting|Index/.test(l)).slice(0, 12),
            sleepStates: String(hibernate.stdout).split(/\r?\n/).filter((l) => /可用|Available|S[1-5]|Hibernate|Fast/.test(l)).slice(0, 12),
          }
        }
        const out = {}
        for (const f of ['/sys/power/state', '/sys/power/disk', '/etc/systemd/logind.conf']) {
          try {
            const t = fs.readFileSync(f, 'utf8')
            out[f] = f.endsWith('.conf') ? t.split(/\r?\n/).filter((l) => /^\s*(HandleLidSwitch|IdleAction|SleepInhibit)/i.test(l)) : t.trim()
          } catch (e) {}
        }
        const timers = await ctx.exec('systemctl', ['list-timers', 'timer-*sleep*', '--no-pager'], { timeoutMs: 15000 })
        out.logindTimers = String(timers.stdout).split(/\r?\n/).slice(1, 6)
        return out
      },
    },
  ],
}
