// 网络诊断包：ping / TCP / HTTP 计时、DNS 全类型、证书链与 TLS 能力、端口扫描、
// RDAP 归属、CIDR 计算、测速。全部用 node 内置模块 + 系统命令，零依赖。
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import os from 'node:os'
import { json, int, clamp, fmtBytes, fmtMs } from '../util.js'

const UA = 'Mozilla/5.0 tey-mcp/0.1 net-probe'

function tcpConnect(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const sock = net.connect({ host, port, timeout: timeoutMs })
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch (e) {}
      resolve({ ...r, ms: Date.now() - t0 })
    }
    sock.on('connect', () => finish({ ok: true }))
    sock.on('timeout', () => finish({ ok: false, reason: `超时 ${timeoutMs}ms` }))
    sock.on('error', (e) => finish({ ok: false, reason: `${e.code || ''} ${e.message}`.trim() }))
  })
}

function bannerGrab(host, port, payload, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const sock = net.connect({ host, port, timeout: timeoutMs })
    let buf = ''
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch (e) {}
      resolve({ ...r, ms: Date.now() - t0 })
    }
    sock.on('connect', () => {
      if (payload) sock.write(payload)
    })
    sock.on('data', (d) => {
      buf += d.toString('latin1')
      if (buf.length > 4096) finish({ ok: true, banner: buf.slice(0, 4096) })
    })
    sock.on('timeout', () => finish({ ok: !!buf, banner: buf.slice(0, 4096), reason: buf ? '读满超时' : `无回显 ${timeoutMs}ms` }))
    sock.on('end', () => finish({ ok: true, banner: buf.slice(0, 4096) }))
    sock.on('error', (e) => finish({ ok: !!buf, banner: buf.slice(0, 4096), reason: `${e.code || ''} ${e.message}`.trim() }))
  })
}

function tlsInfo(host, port = 443, timeoutMs = 8000, servername) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch (e) {}
      resolve({ ...r, ms: Date.now() - t0 })
    }
    const sock = tls.connect({ host, port, servername: servername || host, timeout: timeoutMs, rejectUnauthorized: false })
    sock.on('secureConnect', () => {
      const cert = sock.getPeerCertificate(true)
      const now = Date.now()
      const notAfter = cert.valid_to ? Date.parse(cert.valid_to) : null
      finish({
        ok: true,
        authorized: sock.authorized,
        authorizationError: sock.authorizationError || null,
        protocol: sock.getProtocol(),
        cipher: sock.getCipher(),
        servername: sock.servername || null,
        alpn: sock.alpnProtocol || null,
        cert: {
          subject: cert.subject,
          issuer: cert.issuer,
          notBefore: cert.valid_from,
          notAfter: cert.valid_to,
          daysLeft: notAfter ? Math.round((notAfter - now) / 86400000) : null,
          serialNumber: cert.serialNumber,
          fingerprint256: cert.fingerprint256,
          subjectAltName: (cert.subjectaltname || '').split(',').map((s) => s.trim().replace(/^(DNS|IP Address):/, '')).slice(0, 40),
          keyType: cert.asymmetricKeyType,
          keyBits: cert.asymmetricKeyDetails ? cert.asymmetricKeyDetails.modulusLength || cert.asymmetricKeyDetails.publicKeyLength : null,
        },
        certCount: (() => {
          let n = 0
          let c = cert
          const seen = new Set()
          while (c && c.issuerCertificate && c !== c.issuerCertificate && !seen.has(c.fingerprint256)) {
            seen.add(c.fingerprint256)
            n++
            c = c.issuerCertificate
          }
          return n + 1
        })(),
      })
    })
    sock.on('timeout', () => finish({ ok: false, reason: `TLS 握手超时 ${timeoutMs}ms` }))
    sock.on('error', (e) => finish({ ok: false, reason: `${e.code || ''} ${e.message}`.trim() }))
  })
}

function hostOf(url) {
  try {
    return new URL(/^https?:\/\//.test(url) ? url : `https://${url}`)
  } catch (e) {
    return null
  }
}

export default {
  id: 'net',
  title: '网络诊断',
  tags: ['network', 'dns', 'tls', 'http', 'scan'],
  summary: 'ping/TCP/HTTP 计时、DNS 全类型、证书链与 TLS 能力、端口扫描、RDAP 归属、CIDR、测速',
  tools: [
    {
      name: 'net_ping',
      desc: 'ping 主机，返回丢包率与 RTT（走系统 ping）',
      params: {
        host: { type: 'string', required: true, desc: '主机名或 IP' },
        count: { type: 'integer', desc: '包数，默认 4' },
        timeoutMs: { type: 'integer', desc: '总超时，默认 20000' },
      },
      async run(a, ctx) {
        const n = clamp(int(a.count, 4), 1, 20)
        const args = process.platform === 'win32' ? ['-n', String(n), String(a.host)] : ['-c', String(n), '-W', '2', String(a.host)]
        const r = await ctx.exec('ping', args, { timeoutMs: clamp(int(a.timeoutMs, 20000), 3000, 120000) })
        const txt = String(r.stdout)
        const lost = txt.match(/(\d+)%\s*丢[失包]|(\d+)%\s*packet loss/i)
        const rtt = txt.match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/) || txt.match(/=\s*([\d.]+)ms/)
        return {
          host: a.host,
          code: r.code,
          sent: n,
          lossPercent: lost ? Number(lost[1] || lost[2]) : null,
          rttMinMs: rtt ? Number(rtt[1]) : null,
          rttAvgMs: rtt ? Number(rtt[2] || rtt[1]) : null,
          rttMaxMs: rtt ? Number(rtt[3] || rtt[1]) : null,
          output: txt.split(/\r?\n/).filter((l) => l.trim()).slice(-8),
        }
      },
    },
    {
      name: 'net_tcp_probe',
      desc: 'TCP 连接探测（可批量 host:port），返回通/不通与耗时',
      params: {
        targets: { type: 'array', required: true, desc: '形如 127.0.0.1:8080 或 host:port 列表', items: { type: 'string', desc: '一个目标' } },
        timeoutMs: { type: 'integer', desc: '单个超时，默认 3000' },
        concurrency: { type: 'integer', desc: '并发，默认 8' },
      },
      async run(a) {
        const items = (a.targets || []).slice(0, 60).map((t) => {
          const s = String(t).trim()
          const m = s.match(/^(?:\[(.+)\]|([^:]+))(?::(\d+))?$/)
          return { host: m ? m[1] || m[2] : s, port: m && m[3] ? Number(m[3]) : 80 }
        })
        const conc = clamp(int(a.concurrency, 8), 1, 32)
        const results = new Array(items.length).fill(null)
        let cursor = 0
        const worker = async () => {
          for (;;) {
            const i = cursor++
            if (i >= items.length) return
            const it = items[i]
            const r = await tcpConnect(it.host, it.port, clamp(int(a.timeoutMs, 3000), 200, 30000))
            results[i] = { target: `${it.host}:${it.port}`, open: r.ok, ms: r.ms, reason: r.reason || null }
          }
        }
        await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, worker))
        return { total: items.length, open: results.filter((r) => r.open).length, results }
      },
    },
    {
      name: 'net_port_scan',
      desc: '对单主机扫一段端口（并发限流，默认常见 20 个）',
      params: {
        host: { type: 'string', required: true, desc: '主机名或 IP' },
        ports: { type: 'string', desc: '端口写法：80,443,8000-8100 或逗号列表，默认常见端口', },
        timeoutMs: { type: 'integer', desc: '单端口超时，默认 1200' },
        concurrency: { type: 'integer', desc: '并发，默认 24' },
        maxPorts: { type: 'integer', desc: '最多扫多少个，默认 200' },
      },
      async run(a) {
        const parsePorts = (spec) => {
          if (!spec) return [21, 22, 23, 25, 53, 80, 135, 139, 443, 445, 1433, 1521, 3000, 3306, 3389, 5432, 5900, 6379, 8000, 8080, 8443, 9000, 11434, 27017]
          const out = []
          for (const chunk of String(spec).split(',')) {
            const c = chunk.trim()
            const range = c.match(/^(\d+)\s*-\s*(\d+)$/)
            if (range) for (let p = Number(range[1]); p <= Number(range[2]); p++) out.push(p)
            else if (/^\d+$/.test(c)) out.push(Number(c))
          }
          return out
        }
        const maxPorts = clamp(int(a.maxPorts, 200), 1, 2000)
        const ports = [...new Set(parsePorts(a.ports))].slice(0, maxPorts)
        const conc = clamp(int(a.concurrency, 24), 1, 64)
        const open = []
        const closed = []
        let cursor = 0
        const worker = async () => {
          for (;;) {
            const i = cursor++
            if (i >= ports.length) return
            const p = ports[i]
            const r = await tcpConnect(a.host, p, clamp(int(a.timeoutMs, 1200), 100, 15000))
            if (r.ok) open.push({ port: p, ms: r.ms })
            else closed.push({ port: p, reason: r.reason })
          }
        }
        await Promise.all(Array.from({ length: Math.min(conc, ports.length) }, worker))
        open.sort((x, y) => x.port - y.port)
        return { host: a.host, scanned: ports.length, openCount: open.length, open: open.map((o) => `${o.port} (${o.ms}ms)`), openPorts: open.map((o) => o.port), note: closed.length === ports.length ? '全部超时/拒绝：可能被防火墙静默丢包' : null }
      },
    },
    {
      name: 'net_http_probe',
      desc: 'HTTP 请求计时：状态码、耗时分解、大小、跳转链',
      params: {
        url: { type: 'string', required: true, desc: '完整地址' },
        method: { type: 'string', desc: 'GET|HEAD|POST，默认 GET', enum: ['GET', 'HEAD', 'POST'] },
        timeoutMs: { type: 'integer', desc: '超时，默认 15000' },
        rounds: { type: 'integer', desc: '连测几轮看稳定性，默认 1' },
        body: { type: 'string', desc: 'POST 体' },
      },
      async run(a, ctx) {
        const rounds = clamp(int(a.rounds, 1), 1, 20)
        const rows = []
        for (let i = 0; i < rounds; i++) {
          const t0 = Date.now()
          try {
            const res = await ctx.fetch(a.url, { method: a.method || 'GET', timeoutMs: clamp(int(a.timeoutMs, 15000), 500, 60000), headers: { 'user-agent': UA }, redirect: 'follow', body: a.method === 'POST' ? a.body : undefined })
            const text = await res.text()
            rows.push({ status: res.status, ok: res.ok, ms: Date.now() - t0, bytes: Buffer.byteLength(text), finalUrl: res.url, contentType: res.headers.get('content-type'), redirected: res.url !== a.url })
          } catch (e) {
            rows.push({ status: null, ok: false, ms: Date.now() - t0, reason: String(e && e.message).slice(0, 140) })
          }
        }
        const okRows = rows.filter((r) => r.ok)
        return {
          url: a.url,
          rounds: rows.length,
          okCount: okRows.length,
          avgMs: okRows.length ? Math.round(okRows.reduce((s, r) => s + r.ms, 0) / okRows.length) : null,
          minMs: okRows.length ? Math.min(...okRows.map((r) => r.ms)) : null,
          maxMs: okRows.length ? Math.max(...okRows.map((r) => r.ms)) : null,
          rows,
        }
      },
    },
    {
      name: 'net_dns_lookup',
      desc: 'DNS 查询：A/AAAA/CNAME/MX/TXT/NS/SOA/CAA/SRV',
      params: {
        domain: { type: 'string', required: true, desc: '域名' },
        types: { type: 'array', desc: '记录类型，默认 A/AAAA/CNAME/MX/TXT/NS', items: { type: 'string', desc: '一种类型' } },
        server: { type: 'string', desc: '指定 DNS 服务器 IP，例如 1.1.1.1' },
      },
      async run(a) {
        const types = (Array.isArray(a.types) && a.types.length ? a.types : ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS']).map((t) => String(t).toLowerCase())
        const resolver = new dns.Resolver()
        if (a.server) resolver.setServers([String(a.server)])
        const api = { a: resolver.resolve4.bind(resolver), aaaa: resolver.resolve6.bind(resolver), cname: resolver.resolveCname.bind(resolver), mx: resolver.resolveMx.bind(resolver), txt: resolver.resolveTxt.bind(resolver), ns: resolver.resolveNs.bind(resolver), soa: resolver.resolveSoa.bind(resolver), caa: resolver.resolveCaa.bind(resolver), srv: resolver.resolveSrv.bind(resolver) }
        const out = { domain: a.domain, server: a.server || 'system' }
        for (const t of types) {
          const fn = api[t]
          if (!fn) {
            out[t] = '不支持的类型'
            continue
          }
          const t0 = Date.now()
          try {
            const r = await fn(a.domain)
            out[t] = { ms: Date.now() - t0, value: t === 'txt' ? r.map((x) => x.join('')) : r }
          } catch (e) {
            out[t] = { ms: Date.now() - t0, error: `${e.code || ''} ${e.message}`.trim() }
          }
        }
        return out
      },
    },
    {
      name: 'net_dns_ptr',
      desc: '反向解析（IP → 域名）与本机 DNS 服务器',
      params: { ip: { type: 'string', desc: 'IPv4/IPv6；不给就解析本机出口 IP 的 PTR' } },
      async run(a) {
        const servers = dns.getServers()
        if (!a.ip) return { systemDnsServers: servers, note: '没给 ip，只返回系统 DNS 配置' }
        try {
          const r = await dns.promises.reverse(a.ip)
          return { ip: a.ip, ptr: r, systemDnsServers: servers }
        } catch (e) {
          return { ip: a.ip, ptr: [], error: `${e.code || ''} ${e.message}`.trim(), systemDnsServers: servers }
        }
      },
    },
    {
      name: 'net_traceroute',
      desc: '路由跟踪（Linux traceroute / Windows tracert）',
      params: {
        host: { type: 'string', required: true, desc: '目标主机' },
        maxHops: { type: 'integer', desc: '最大跳数，默认 20' },
        timeoutMs: { type: 'integer', desc: '总超时，默认 60000' },
      },
      async run(a, ctx) {
        const hops = clamp(int(a.maxHops, 20), 1, 40)
        const args = process.platform === 'win32' ? ['-d', '-h', String(hops), String(a.host)] : ['-m', String(hops), '-w', '2', '-q', '1', String(a.host)]
        const r = await ctx.exec(process.platform === 'win32' ? 'tracert' : 'traceroute', args, { timeoutMs: clamp(int(a.timeoutMs, 60000), 5000, 180000) })
        const lines = String(r.stdout).split(/\r?\n/).filter((l) => l.trim())
        const hopsParsed = lines
          .map((l) => {
            const m = l.trim().match(/^(\d+)\s+(.*?)(?:\((\d+\.\d+\.\d+\.\d+)\))?\s+([\d.*<>ms\s]+)$/)
            return m ? { hop: Number(m[1]), host: m[2].trim().slice(0, 60), ip: m[3] || null, rtt: m[4].trim().slice(0, 40) } : null
          })
          .filter(Boolean)
        return { host: a.host, code: r.code, lines: lines.slice(0, 40), hops: hopsParsed.slice(0, 40), note: hopsParsed.length ? null : 'Windows tracert 输出格式差异大，看 lines 字段' }
      },
    },
    {
      name: 'net_interfaces',
      desc: '本机网卡与 IP（含 MAC、IPv4/IPv6、是否内部），默认路由猜测',
      params: {},
      async run(_a, ctx) {
        const ifs = os.networkInterfaces()
        const rows = []
        for (const [name, addrs] of Object.entries(ifs)) {
          for (const ad of addrs || []) rows.push({ name, family: ad.family, address: ad.address, netmask: ad.netmask, cidr: ad.cidr, mac: ad.mac, internal: ad.internal, scopeid: ad.scopeid })
        }
        const v4 = rows.filter((r) => r.family === 'IPv4' && !r.internal)
        let gateway = null
        if (v4.length) {
          const parts = v4[0].address.split('.')
          gateway = `${parts[0]}.${parts[1]}.${parts[2]}.1`
        }
        const route = process.platform === 'win32' ? await ctx.exec('route', ['print', '0.0.0.0'], { timeoutMs: 15000 }) : await ctx.exec('ip', ['route', 'show', 'default'], { timeoutMs: 15000 })
        const gw = String(route.stdout).match(/(?:Gateway|via)\s*[:\s]+([\d.]+)/)
        return { interfaces: rows, nonInternalIpv4: v4.map((r) => `${r.name} ${r.address}/${r.netmask}`), guessedGateway: gw ? gw[1] : gateway, dnsServers: dns.getServers(), hostname: os.hostname() }
      },
    },
    {
      name: 'net_cert_info',
      desc: 'TLS 证书详情：颁发者/有效期/剩余天数/SAN/协议/加密套件',
      params: {
        target: { type: 'string', required: true, desc: '域名，或 host:port' },
        timeoutMs: { type: 'integer', desc: '超时，默认 8000' },
        servername: { type: 'string', desc: 'SNI 名字（IP 直连时填域名）' },
      },
      async run(a) {
        const t = String(a.target).trim()
        const m = t.match(/^(?:https?:\/\/)?([^:/]+)(?::(\d+))?/)
        const host = m ? m[1] : t
        const port = m && m[2] ? Number(m[2]) : 443
        const r = await tlsInfo(host, port, clamp(int(a.timeoutMs, 8000), 1000, 30000), a.servername)
        if (!r.ok) return { target: t, ok: false, reason: r.reason, ms: r.ms }
        return { target: `${host}:${port}`, ...r }
      },
    },
    {
      name: 'net_cert_expiry_scan',
      desc: '批量查多个域名证书剩余天数，按快到期排序',
      params: {
        domains: { type: 'array', required: true, desc: '域名列表', items: { type: 'string', desc: '一个域名' } },
        port: { type: 'integer', desc: '端口，默认 443' },
        warnDays: { type: 'integer', desc: '少于这几天标警告，默认 21' },
        concurrency: { type: 'integer', desc: '并发，默认 8' },
      },
      async run(a) {
        const items = (a.domains || []).slice(0, 60).map((d) => String(d).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
        const conc = clamp(int(a.concurrency, 8), 1, 20)
        const warn = int(a.warnDays, 21)
        const results = new Array(items.length).fill(null)
        let cursor = 0
        const worker = async () => {
          for (;;) {
            const i = cursor++
            if (i >= items.length) return
            const r = await tlsInfo(items[i], int(a.port, 443), 8000)
            results[i] = { domain: items[i], ok: r.ok, daysLeft: r.ok && r.cert ? r.cert.daysLeft : null, issuer: r.ok && r.cert ? (r.cert.issuer && (r.cert.issuer.O || r.cert.issuer.CN)) || null : null, expires: r.ok && r.cert ? r.cert.notAfter : null, protocol: r.ok ? r.protocol : null, reason: r.reason || null, warn: r.ok && r.cert && r.cert.daysLeft !== null && r.cert.daysLeft <= warn }
          }
        }
        await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, worker))
        results.sort((x, y) => (x.daysLeft === null ? 9e9 : x.daysLeft) - (y.daysLeft === null ? 9e9 : y.daysLeft))
        return { total: items.length, warnDays: warn, expiringSoon: results.filter((r) => r.warn).length, rows: results.map((r) => `${r.warn ? '!' : r.ok ? ' ' : 'x'} ${String(r.daysLeft === null ? '??' : r.daysLeft).padStart(5)}天  ${(r.issuer || '').padEnd(24)} ${r.domain}`) }
      },
    },
    {
      name: 'net_tls_capability',
      desc: '探测目标支持的 TLS 版本与套件（1.0/1.1/1.2/1.3）',
      params: {
        target: { type: 'string', required: true, desc: '域名或 host:port' },
        versions: { type: 'array', desc: '要试的版本，默认全试', items: { type: 'string', desc: 'TLSv1|TLSv1.1|TLSv1.2|TLSv1.3' } },
      },
      async run(a) {
        const t = String(a.target).trim()
        const m = t.match(/^(?:https?:\/\/)?([^:/]+)(?::(\d+))?$/)
        const host = m ? m[1] : t
        const port = m && m[2] ? Number(m[2]) : 443
        const versions = Array.isArray(a.versions) && a.versions.length ? a.versions : ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']
        const out = {}
        for (const v of versions) {
          const r = await tlsInfo(host, port, 6000).catch(() => null)
          out[v] = { supported: r && r.ok && r.protocol === v, negotiated: r ? r.protocol : null, cipher: r && r.cipher ? `${r.cipher.name}/${r.cipher.size}bit` : null, reason: r && r.reason ? r.reason : null }
        }
        return { target: `${host}:${port}`, results: out, note: 'Node 24 默认禁用 TLS1.0/1.1，显示不支持不代表对端不支持' }
      },
    },
    {
      name: 'net_banner_grab',
      desc: '抓服务横幅（发 payload 读回显），识别协议指纹',
      params: {
        host: { type: 'string', required: true, desc: '主机' },
        port: { type: 'integer', required: true, desc: '端口' },
        payload: { type: 'string', desc: '先发这个（支持 \\r\\n 转义），不给就只读' },
        timeoutMs: { type: 'integer', desc: '超时，默认 4000' },
      },
      async run(a) {
        const payload = a.payload ? a.payload.replace(/\\r/g, '\r').replace(/\\n/g, '\n') : null
        const r = await bannerGrab(String(a.host), int(a.port, 0), payload, clamp(int(a.timeoutMs, 4000), 500, 30000))
        const b = r.banner || ''
        const guess = /SSH-2\.0/.test(b) ? 'SSH' : /HTTP\/1|HTTP\/2/.test(b) ? 'HTTP' : /220 .*FTP|220-/.test(b) ? 'FTP' : /redis|redis-cli/i.test(b) ? 'Redis' : /MongoDB|BSON/i.test(b) ? 'MongoDB' : /MySQL|mysql_native/i.test(b) ? 'MySQL' : /SMB|NTLMSSP/.test(b) ? 'SMB' : /RTSP|SIP/.test(b) ? 'RTSP/SIP' : b ? '未知文本协议' : '无回显'
        return { target: `${a.host}:${a.port}`, ms: r.ms, bytes: b.length, protocolGuess: guess, banner: b.slice(0, 800), reason: r.reason || null }
      },
    },
    {
      name: 'net_rdap_domain',
      desc: '域名注册信息（RDAP）：注册商、创建/到期日、状态、DNS',
      params: { domain: { type: 'string', required: true, desc: '域名（取主域）' }, timeoutMs: { type: 'integer', desc: '超时，默认 15000' } },
      async run(a, ctx) {
        const dom = String(a.domain).trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]
        const tryUrls = [`https://rdap.org/domain/${dom}`, `https://rdap.verisign.com/com/v1/domain/${dom}`]
        for (const url of tryUrls) {
          try {
            const res = await ctx.fetch(url, { timeoutMs: clamp(int(a.timeoutMs, 15000), 1000, 60000), headers: { accept: 'application/rdap+json, application/json' } })
            if (!res.ok) continue
            const j = JSON.parse(await res.text())
            const ev = (j.events || []).map((e) => ({ event: e.eventAction, date: e.eventDate }))
            return {
              domain: j.ldhName || dom,
              registrar: (j.entities || []).map((e) => (e.vcardArray && e.vcardArray[1] || []).map((v) => (v[3] === 'fn' ? v[3] : null)).filter(Boolean)).flat(),
              status: j.status,
              nameservers: (j.nameservers || []).map((n) => n.ldhName).slice(0, 10),
              events: ev,
              expires: (ev.find((e) => /expiration/i.test(e.event)) || {}).date || null,
              created: (ev.find((e) => /registration/i.test(e.event)) || {}).date || null,
              dnssec: j.secureDNS && j.secureDNS.delegationSigned,
              source: url,
            }
          } catch (e) {}
        }
        return { ok: false, message: `RDAP 没查到 ${dom}（TLD 可能不支持 rdap.org）` }
      },
    },
    {
      name: 'net_ip_info',
      desc: 'IP 归属查询（ipwho.is / ipapi.co 免密钥），含运营商与地理位置',
      params: {
        ip: { type: 'string', desc: '要查的 IP；不给查自己的出口 IP' },
        timeoutMs: { type: 'integer', desc: '超时，默认 10000' },
      },
      async run(a, ctx) {
        const url = a.ip ? `https://ipwho.is/${encodeURIComponent(a.ip)}` : 'https://ipwho.is/'
        try {
          const res = await ctx.fetch(url, { timeoutMs: clamp(int(a.timeoutMs, 10000), 1000, 30000) })
          const j = JSON.parse(await res.text())
          if (j.success === false) return { ok: false, message: j.message || '查询失败', raw: j }
          return {
            ip: j.ip,
            type: j.type,
            country: j.country,
            region: j.region,
            city: j.city,
            lat: j.latitude,
            lon: j.longitude,
            isp: j.connection && j.connection.isp,
            org: j.connection && j.connection.org,
            asn: j.connection && j.connection.asn,
            reverse: j.connection && j.connection.reverse,
            proxy: j.connection && j.connection.proxy,
            source: url,
          }
        } catch (e) {
          return { ok: false, message: String(e && e.message).slice(0, 160), source: url }
        }
      },
    },
    {
      name: 'net_ip_range',
      desc: 'CIDR 计算：网络号/广播/可用范围/地址数，或 IP 属于哪个网段',
      params: {
        cidr: { type: 'string', desc: '例如 192.168.168.0/24' },
        ip: { type: 'string', desc: '要判断归属的 IP' },
      },
      async run(a) {
        const toInt = (s) => s.split('.').reduce((acc, p) => (acc << 8) + (Number(p) & 255) >>> 0, 0)
        const toIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')
        if (!a.cidr) return json({ ok: false, message: '要填 cidr，例如 192.168.168.0/24' })
        const [netPart, bitsPart] = String(a.cidr).split('/')
        const bits = Number(bitsPart === undefined ? 32 : bitsPart)
        if (!(bits >= 0 && bits <= 32)) return json({ ok: false, message: '掩码位数要 0-32' })
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
        const base = toInt(netPart) & mask
        const size = 2 ** (32 - bits)
        const first = bits === 32 ? base : base + 1
        const last = bits === 32 ? base : base + size - 2
        const broadcast = base + size - 1
        return {
          cidr: `${toIp(base)}/${bits}`,
          network: toIp(base),
          mask: toIp(mask),
          wildcard: toIp(~mask >>> 0),
          broadcast: toIp(broadcast),
          totalAddresses: size,
          usableRange: size <= 2 ? `${toIp(base)}-${toIp(broadcast)}` : `${toIp(first)}-${toIp(last)}`,
          usableCount: Math.max(0, size - 2),
          containsIp: a.ip ? (toInt(a.ip) & mask) >>> 0 === base : null,
          checkedIp: a.ip || null,
        }
      },
    },
    {
      name: 'net_speed_test',
      desc: '下载测速：下 URL 测吞吐（bytes/s），可多轮',
      params: {
        url: { type: 'string', desc: '下载地址；默认用 cloudflare 测速端点' },
        rounds: { type: 'integer', desc: '几轮，默认 2' },
        maxBytes: { type: 'integer', desc: '每轮最多下多少字节，默认 8388608（8MiB）' },
        timeoutMs: { type: 'integer', desc: '每轮超时，默认 30000' },
      },
      async run(a, ctx) {
        const url = a.url || 'https://speed.cloudflare.com/__down?bytes=8388608'
        const rounds = clamp(int(a.rounds, 2), 1, 10)
        const rows = []
        for (let i = 0; i < rounds; i++) {
          const t0 = Date.now()
          try {
            const res = await ctx.fetch(url, { timeoutMs: clamp(int(a.timeoutMs, 30000), 1000, 120000), headers: { 'user-agent': UA } })
            const buf = Buffer.from(await res.arrayBuffer())
            const ms = Date.now() - t0
            rows.push({ status: res.status, bytes: buf.length, ms, mbps: Number((buf.length * 8 / (ms / 1000) / 1e6).toFixed(2)), mbs: Number((buf.length / (ms / 1000) / 1024 / 1024).toFixed(2)) })
          } catch (e) {
            rows.push({ ok: false, ms: Date.now() - t0, reason: String(e && e.message).slice(0, 140) })
          }
        }
        const ok = rows.filter((r) => r.bytes)
        return { url, rounds: rows.length, rows, avgMbps: ok.length ? Number((ok.reduce((s, r) => s + r.mbps, 0) / ok.length).toFixed(2)) : null, note: ok.length ? null : '全部失败：可能没外网或被墙' }
      },
    },
    {
      name: 'net_latency_batch',
      desc: '一批主机的 TCP 连接延迟矩阵（默认探 443），看谁快谁慢',
      params: {
        hosts: { type: 'array', required: true, desc: '主机列表', items: { type: 'string', desc: '一个主机' } },
        port: { type: 'integer', desc: '端口，默认 443' },
        rounds: { type: 'integer', desc: '每台几次，默认 3' },
        timeoutMs: { type: 'integer', desc: '单次超时，默认 3000' },
      },
      async run(a) {
        const hosts = (a.hosts || []).slice(0, 40).map((h) => String(h).trim())
        const port = int(a.port, 443)
        const rounds = clamp(int(a.rounds, 3), 1, 10)
        const to = clamp(int(a.timeoutMs, 3000), 200, 20000)
        const out = []
        for (const h of hosts) {
          const ms = []
          for (let i = 0; i < rounds; i++) {
            const r = await tcpConnect(h, port, to)
            if (r.ok) ms.push(r.ms)
            else if (i === 0) ms.push(null)
          }
          const good = ms.filter((x) => typeof x === 'number')
          out.push({ host: h, port, ok: good.length > 0, minMs: good.length ? Math.min(...good) : null, avgMs: good.length ? Math.round(good.reduce((s, x) => s + x, 0) / good.length) : null, samples: ms })
        }
        out.sort((x, y) => (x.avgMs === null ? 9e9 : x.avgMs) - (y.avgMs === null ? 9e9 : y.avgMs))
        return { port, rows: out.map((r) => `${r.ok ? '✓' : 'x'} ${String(r.avgMs === null ? '不通' : r.avgMs + 'ms').padStart(9)}  ${r.host}`), ranked: out }
      },
    },
    {
      name: 'net_lan_neighbors',
      desc: '局域网邻居：解析 arp -a（IP↔MAC），按网段分组',
      params: { limit: { type: 'integer', desc: '最多几条，默认 60' } },
      async run(a, ctx) {
        const r = await ctx.exec('arp', ['-a'], { timeoutMs: 20000 })
        const txt = String(r.stdout) + String(r.stderr)
        const rows = []
        for (const m of txt.matchAll(/(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/gi)) rows.push({ ip: m[1], mac: m[0].replace(m[1], '').trim() })
        for (const m of txt.matchAll(/(\d+\.\d+\.\d+\.\d+)\s+\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]{17})/gi)) rows.push({ ip: m[1], mac: m[3] })
        const uniq = [...new Map(rows.map((x) => [x.ip, x])).values()]
        const bySubnet = {}
        for (const x of uniq) {
          const k = x.ip.split('.').slice(0, 3).join('.')
          bySubnet[k] = (bySubnet[k] || 0) + 1
        }
        const cap = clamp(int(a.limit, 60), 1, 500)
        return { total: uniq.length, bySubnet, neighbors: uniq.slice(0, cap).map((x) => `${x.ip.padEnd(16)} ${x.mac}`), note: uniq.length ? null : 'arp 表空：先 ping 一圈再查（net_latency_batch 打一遍常见段）' }
      },
    },
    {
      name: 'net_route_table',
      desc: '路由表与默认网关（ip route / route print）',
      params: {},
      async run(_a, ctx) {
        const r = process.platform === 'win32' ? await ctx.exec('route', ['print', '0.0.0.0'], { timeoutMs: 20000 }) : await ctx.exec('ip', ['route', 'show'], { timeoutMs: 20000 })
        const lines = String(r.stdout).split(/\r?\n/).filter((l) => l.trim())
        const def = lines.filter((l) => /default|0\.0\.0\.0/i.test(l)).slice(0, 6)
        const gw = String(r.stdout).match(/(?:via|Gateway[:\s]+)\s*([\d.]+)/)
        return { gateway: gw ? gw[1] : null, defaultRoutes: def, entries: lines.length, table: lines.slice(0, 40).map((l) => l.slice(0, 160)) }
      },
    },
    {
      name: 'net_dns_servers',
      desc: '当前 DNS 服务器与连通性（逐个 53 端口探测 + 解析测试）',
      params: {},
      async run(_a, ctx) {
        const servers = dns.getServers()
        const rows = []
        for (const s of servers) {
          const tcp = await tcpConnect(s, 53, 2000)
          const t0 = Date.now()
          let resolveOk = false
          let resolveErr = null
          try {
            const r = new dns.Resolver()
            r.setServers([s])
            await r.resolve4('example.com')
            resolveOk = true
          } catch (e) {
            resolveErr = `${e.code || ''} ${e.message}`.trim()
          }
          rows.push({ server: s, tcp53: tcp.ok, tcpMs: tcp.ms, resolveOk, resolveMs: Date.now() - t0, resolveErr })
        }
        return { count: servers.length, servers: rows, working: rows.filter((r) => r.resolveOk).map((r) => r.server) }
      },
    },
    {
      name: 'net_upnp_map',
      desc: '用 miniupnpc 加/查端口映射（有 miniupnpc 才可用）',
      write: true,
      params: {
        action: { type: 'string', required: true, desc: 'list|add|remove', enum: ['list', 'add', 'remove'] },
        port: { type: 'integer', desc: '外部端口' },
        internalPort: { type: 'integer', desc: '内部端口，默认同 port' },
        proto: { type: 'string', desc: 'TCP|UDP，默认 TCP', enum: ['TCP', 'UDP'] },
        host: { type: 'string', desc: '内网 IP（add 必填）' },
      },
      async run(a, ctx) {
        const which = process.platform === 'win32' ? await ctx.exec('where', ['upnpc']) : await ctx.exec('sh', ['-c', 'command -v upnpc'])
        if (which.code !== 0) return json({ ok: false, message: '没装 miniupnpc（upnpc）。Linux: apt install miniupnpc；Windows: 从 miniupnp 项目取 exe 放 PATH' })
        const args = a.action === 'list' ? ['-l'] : a.action === 'add' ? ['-e', `tey-${a.port}`, a.proto, String(a.port), String(a.internalPort || a.port), a.host] : ['-d', a.proto, String(a.port)]
        const r = await ctx.exec('upnpc', args, { timeoutMs: 30000 })
        return { command: `upnpc ${args.join(' ')}`, code: r.code, output: String(r.stdout).split(/\r?\n/).filter(Boolean).slice(0, 40), stderr: String(r.stderr).slice(0, 400) }
      },
    },
    {
      name: 'net_http_headers_build',
      desc: '拼一份请求头模板（浏览器/接口/带 cookie），可直接拿去用',
      params: {
        kind: { type: 'string', desc: 'browser|api|form|raw，默认 browser', enum: ['browser', 'api', 'form', 'raw'] },
        url: { type: 'string', desc: '目标地址（用来填 Origin/Referer）' },
        cookie: { type: 'string', desc: 'Cookie 串' },
        token: { type: 'string', desc: 'Bearer token' },
      },
      async run(a) {
        const origin = (() => {
          try {
            return new URL(a.url).origin
          } catch (e) {
            return null
          }
        })()
        const base = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36' }
        let headers
        if (a.kind === 'api') headers = { ...base, accept: 'application/json, text/plain, */*', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', origin: origin || '', referer: origin || '', 'x-requested-with': 'XMLHttpRequest' }
        else if (a.kind === 'form') headers = { ...base, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', origin: origin || '', referer: a.url || origin || '' }
        else if (a.kind === 'raw') headers = { host: origin ? new URL(origin).host : '', connection: 'keep-alive', 'accept-encoding': 'gzip, deflate, br' }
        else headers = { ...base, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9', 'upgrade-insecure-requests': '1', 'sec-ch-ua': '"Chromium";v="131"', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': origin ? 'same-origin' : '', referer: origin || '' }
        if (a.cookie) headers.cookie = a.cookie
        if (a.token) headers.authorization = `Bearer ${a.token}`
        return { kind: a.kind || 'browser', headers, curl: `curl -i ${Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(' ')} ${a.url || 'URL'}` }
      },
    },
  ],
}
