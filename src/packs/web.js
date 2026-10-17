// 网页抓取与解析包：抓 URL 转文本/Markdown、抽正文/链接/表格/结构化数据、
// sitemap/RSS 解析、批量抓取与差异对比。零依赖，正则级解析，够用即可。
import fs from 'node:fs'
import path from 'node:path'
import { json, int, clamp, fmtBytes, ensureDir } from '../util.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 tey-mcp/0.1'

async function grab(ctx, url, opts = {}) {
  const res = await ctx.fetch(url, {
    method: opts.method || 'GET',
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', ...(opts.headers || {}) },
    timeoutMs: opts.timeoutMs || 20000,
    redirect: 'follow',
    ...(opts.body === undefined || opts.body === null ? {} : { body: opts.body }),
  })
  const text = await res.text()
  return { status: res.status, ok: res.ok, url: res.url || url, headers: Object.fromEntries(res.headers.entries() || []), text, bytes: Buffer.byteLength(text) }
}

const decode = (s) => String(s)
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, ' ')

function stripHtml(html) {
  return decode(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim())
}

function absUrl(base, href) {
  try {
    return new URL(href, base).href
  } catch (e) {
    return String(href)
  }
}

function extractTables(html) {
  const out = []
  for (const tm of String(html).matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const rows = []
    for (const rm of tm[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [...rm[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => stripHtml(c[1]).replace(/\s+/g, ' ').trim())
      if (cells.length) rows.push(cells)
    }
    if (rows.length >= 2) {
      const header = rows[0]
      out.push({ header, rows: rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === undefined ? '' : r[i]]))) })
    }
  }
  return out
}

function articleFrom(html, url) {
  const src = String(html)
  const title = (src.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]
  const cand = []
  for (const m of src.matchAll(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/gi)) cand.push({ weight: stripHtml(m[2]).length + 5000, html: m[2] })
  for (const m of src.matchAll(/<div[^>]*class=["'][^"']*(content|article|post|body|markdown|prose)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)) cand.push({ weight: stripHtml(m[2]).length, html: m[2] })
  const bodyTag = src.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  cand.push({ weight: bodyTag ? stripHtml(bodyTag[1]).length - 3000 : 0, html: bodyTag ? bodyTag[1] : src })
  cand.sort((x, y) => y.weight - x.weight)
  const best = cand[0] || { html: src }
  const text = stripHtml(best.html)
  return {
    title: title ? decode(title).replace(/\s+/g, ' ').trim() : null,
    url: url || null,
    chars: text.length,
    words: text.split(/\s+/).filter(Boolean).length,
    headings: [...best.html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)].slice(0, 40).map((m) => `${'#'.repeat(Number(m[1]))} ${stripHtml(m[2]).replace(/\s+/g, ' ').trim()}`),
    text,
  }
}

function toMarkdown(html) {
  let s = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n${'#'.repeat(Number(n))} ${stripHtml(t)}\n`)
  s = s.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, h, t) => `[${stripHtml(t).trim()}](${h})`)
  s = s.replace(/<img[^>]+src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, (_m, src, alt) => `![${alt}](${src})`)
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `- ${stripHtml(t).trim()}\n`)
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, x) => `**${stripHtml(x)}**`)
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, x) => `*${stripHtml(x)}*`)
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, x) => `\`${stripHtml(x)}\``)
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, x) => `\n\`\`\`\n${stripHtml(x)}\n\`\`\`\n`)
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, x) => `\n> ${stripHtml(x).trim()}\n`)
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|section|article)>/gi, '\n')
  s = stripHtml(s)
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

export default {
  id: 'web',
  title: '网页抓取与解析',
  tags: ['web', 'scrape', 'html', 'rss', 'crawl'],
  summary: '抓网页转文本/Markdown、抽正文与结构化数据、表格导出、sitemap/RSS、批量抓取与差异',
  tools: [
    {
      name: 'web_fetch_text',
      desc: '抓 URL 转纯文本（去脚本样式、压缩空白）',
      params: {
        url: { type: 'string', required: true, desc: '完整 http(s) 地址' },
        timeoutMs: { type: 'integer', desc: '超时毫秒，默认 20000' },
        maxChars: { type: 'integer', desc: '最多返回字符，默认 12000' },
        headers: { type: 'object', desc: '附加请求头', props: {} },
      },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, a)
        const text = stripHtml(r.text)
        const cap = clamp(int(a.maxChars, 12000), 500, 200000)
        return { url: r.url, status: r.status, bytes: r.bytes, chars: text.length, truncated: text.length > cap, text: text.slice(0, cap) }
      },
    },
    {
      name: 'web_fetch_markdown',
      desc: '抓 URL 转 Markdown（标题/链接/图片/列表/代码块粗转换）',
      params: {
        url: { type: 'string', required: true, desc: '完整地址' },
        timeoutMs: { type: 'integer', desc: '超时，默认 20000' },
        maxChars: { type: 'integer', desc: '最多字符，默认 20000' },
      },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, a)
        const md = toMarkdown(r.text)
        const cap = clamp(int(a.maxChars, 20000), 500, 200000)
        return { url: r.url, status: r.status, chars: md.length, markdown: md.slice(0, cap) }
      },
    },
    {
      name: 'web_article',
      desc: '抽正文：标题 + 正文 + 小标题清单（给知识库喂料用这个）',
      params: {
        url: { type: 'string', required: true, desc: '完整地址' },
        timeoutMs: { type: 'integer', desc: '超时，默认 25000' },
        maxChars: { type: 'integer', desc: '正文最多字符，默认 30000' },
      },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, a)
        const art = articleFrom(r.text, r.url)
        const cap = clamp(int(a.maxChars, 30000), 500, 300000)
        return { url: r.url, status: r.status, title: art.title, chars: art.chars, words: art.words, headings: art.headings, truncated: art.chars > cap, text: art.text.slice(0, cap) }
      },
    },
    {
      name: 'web_save_article',
      desc: '抓正文并存成 Markdown 文件（带来源与时间），返回路径',
      write: true,
      params: {
        url: { type: 'string', required: true, desc: '完整地址' },
        path: { type: 'string', desc: '保存路径，默认 clippings/<域名>-<日期>.md' },
        category: { type: 'string', desc: '放哪个子目录，默认 clippings' },
        maxChars: { type: 'integer', desc: '正文最多字符，默认 60000' },
        timeoutMs: { type: 'integer', desc: '超时，默认 25000' },
      },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, a)
        const art = articleFrom(r.text, r.url)
        const cap = clamp(int(a.maxChars, 60000), 500, 400000)
        const host = (() => {
          try {
            return new URL(r.url).hostname
          } catch (e) {
            return 'site'
          }
        })()
        const day = new Date().toISOString().slice(0, 10)
        const rel = a.path || `${a.category || 'clippings'}/${host}-${day}-${Date.now().toString(36).slice(-4)}.md`
        const abs = ctx.resolve(rel)
        ensureDir(path.dirname(abs))
        const body = `---\nsource: ${r.url}\ntitle: ${JSON.stringify(art.title || '')}\nhost: ${host}\nclipped: ${new Date().toISOString()}\nchars: ${art.chars}\n---\n\n# ${art.title || host}\n\n> 来源：${r.url} ｜ 抓取：${day}\n\n${art.text.slice(0, cap)}\n`
        fs.writeFileSync(abs, body, 'utf8')
        return { saved: rel, abs, bytes: fmtBytes(Buffer.byteLength(body)), title: art.title, chars: art.chars, headings: art.headings.slice(0, 12) }
      },
    },
    {
      name: 'web_meta',
      desc: '抽 title / description / OG / Twitter / canonical / 字符集',
      params: { url: { type: 'string', required: true, desc: '完整地址' }, timeoutMs: { type: 'integer', desc: '超时，默认 20000' } },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, a)
        const src = r.text
        const one = (re) => {
          const m = src.match(re)
          return m ? decode(m[1]).replace(/\s+/g, ' ').trim() : null
        }
        return {
          url: r.url,
          status: r.status,
          title: one(/<title[^>]*>([\s\S]*?)<\/title>/i),
          description: one(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || one(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i),
          keywords: one(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']*)["']/i),
          canonical: one(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i),
          charset: one(/<meta[^>]+charset=["']?([\w-]+)/i),
          generator: one(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']*)["']/i),
          og: Object.fromEntries([...src.matchAll(/<meta[^>]+property=["']og:([\w:]+)["'][^>]+content=["']([^"']*)["']/gi)].slice(0, 20).map((m) => [m[1], decode(m[2])])),
          twitter: Object.fromEntries([...src.matchAll(/<meta[^>]+name=["']twitter:([\w]+)["'][^>]+content=["']([^"']*)["']/gi)].slice(0, 12).map((m) => [m[1], decode(m[2])])),
          langs: [...src.matchAll(/<link[^>]+hreflang=["']([\w-]+)["']/gi)].map((m) => m[1]).slice(0, 20),
        }
      },
    },
    {
      name: 'web_links',
      desc: '抽全部链接（相对自动补全成绝对），可按域名过滤与去重',
      params: {
        url: { type: 'string', required: true, desc: '完整地址' },
        sameHostOnly: { type: 'boolean', desc: '只要同域名，默认 false' },
        pattern: { type: 'string', desc: '按正则过滤链接' },
        limit: { type: 'integer', desc: '最多几条，默认 120' },
        timeoutMs: { type: 'integer', desc: '超时，默认 20000' },
      },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, a)
        const host = (() => {
          try {
            return new URL(r.url).hostname
          } catch (e) {
            return ''
          }
        })()
        const seen = new Set()
        const out = []
        for (const m of r.text.matchAll(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
          const href = absUrl(r.url, decode(m[1]))
          if (href.startsWith('javascript:') || href.startsWith('#') || href.startsWith('mailto:')) continue
          if (a.sameHostOnly && host && new URL(href).hostname !== host) continue
          if (a.pattern && !new RegExp(a.pattern).test(href)) continue
          if (seen.has(href)) continue
          seen.add(href)
          out.push({ href, text: stripHtml(m[2]).replace(/\s+/g, ' ').trim().slice(0, 120) })
          if (out.length >= clamp(int(a.limit, 120), 1, 2000)) break
        }
        return { url: r.url, host, count: out.length, links: out }
      },
    },
    {
      name: 'web_images',
      desc: '抽图片地址与 alt，按域名分组统计',
      params: {
        url: { type: 'string', required: true, desc: '完整地址' },
        limit: { type: 'integer', desc: '最多几条，默认 80' },
        timeoutMs: { type: 'integer', desc: '超时，默认 20000' },
      },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, a)
        const out = []
        const byHost = {}
        for (const m of r.text.matchAll(/<img\b[^>]*>/gi)) {
          const tag = m[0]
          const src = (tag.match(/src=["']([^"']+)["']/i) || [])[1]
          if (!src) continue
          const abs = absUrl(r.url, decode(src))
          const h = (() => {
            try {
              return new URL(abs).hostname
            } catch (e) {
              return 'inline'
            }
          })()
          byHost[h] = (byHost[h] || 0) + 1
          out.push({ src: abs, alt: ((tag.match(/alt=["']([^"']*)["']/i) || [])[1] || '').slice(0, 100), width: (tag.match(/width=["'](\d+)/i) || [])[1] || null, host: h })
          if (out.length >= clamp(int(a.limit, 80), 1, 1000)) break
        }
        return { url: r.url, count: out.length, byHost, images: out }
      },
    },
    {
      name: 'web_tables',
      desc: '抽页面里的表格转 JSON（表头 + 行对象）',
      params: {
        url: { type: 'string', required: true, desc: '完整地址' },
        tableIndex: { type: 'integer', desc: '第几个表，默认全部' },
        limit: { type: 'integer', desc: '每个表最多几行，默认 60' },
        timeoutMs: { type: 'integer', desc: '超时，默认 20000' },
      },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, a)
        let tables = extractTables(r.text)
        if (a.tableIndex !== undefined) tables = tables.slice(a.tableIndex, a.tableIndex + 1)
        const cap = clamp(int(a.limit, 60), 1, 2000)
        return { url: r.url, tableCount: tables.length, tables: tables.slice(0, 10).map((t, i) => ({ index: i, header: t.header, rows: t.rows.length, sample: t.rows.slice(0, cap) })) }
      },
    },
    {
      name: 'web_table_csv',
      desc: '把页面表格导出成 CSV 文件',
      write: true,
      params: {
        url: { type: 'string', required: true, desc: '完整地址' },
        tableIndex: { type: 'integer', desc: '第几个表，默认 0' },
        path: { type: 'string', desc: '输出路径，默认 tables/<域名>-<表序>.csv' },
        timeoutMs: { type: 'integer', desc: '超时，默认 20000' },
      },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, a)
        const tables = extractTables(r.text)
        if (!tables.length) return json({ ok: false, message: '页面里没有 <table>，试试 web_article 或 web_jsonld' })
        const idx = int(a.tableIndex, 0)
        const t = tables[idx]
        if (!t) return json({ ok: false, message: `只有 ${tables.length} 个表，tableIndex=${idx} 超了` })
        const host = (() => {
          try {
            return new URL(r.url).hostname
          } catch (e) {
            return 'site'
          }
        })()
        const rel = a.path || `tables/${host}-${idx}.csv`
        const abs = ctx.resolve(rel)
        ensureDir(path.dirname(abs))
        const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
        const body = [t.header.map(esc).join(','), ...t.rows.map((row) => t.header.map((h) => esc(row[h] === undefined ? '' : row[h])).join(','))].join('\n')
        fs.writeFileSync(abs, body, 'utf8')
        return { saved: rel, abs, rows: t.rows.length, columns: t.header.length, header: t.header, bytes: fmtBytes(Buffer.byteLength(body)) }
      },
    },
    {
      name: 'web_jsonld',
      desc: '抽 JSON-LD 结构化数据（schema.org 类型与关键字段）',
      params: { url: { type: 'string', required: true, desc: '完整地址' }, timeoutMs: { type: 'integer', desc: '超时，默认 20000' } },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, a)
        const blocks = []
        for (const m of r.text.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
          try {
            const parsed = JSON.parse(decode(m[1]))
            for (const item of Array.isArray(parsed) ? parsed : parsed['@graph'] ? parsed['@graph'] : [parsed]) blocks.push(item)
          } catch (e) {
            blocks.push({ __parseFailed: m[1].slice(0, 200) })
          }
        }
        return {
          url: r.url,
          count: blocks.length,
          types: blocks.map((b) => b['@type']),
          blocks: blocks.slice(0, 12).map((b) => JSON.stringify(b).slice(0, 900)),
        }
      },
    },
    {
      name: 'web_sitemap',
      desc: '解析 sitemap.xml / robots.txt 里的 sitemap 地址',
      params: {
        url: { type: 'string', required: true, desc: '站点或 sitemap 地址' },
        fromRobots: { type: 'boolean', desc: '先读 robots.txt 找 sitemap，默认 true' },
        limit: { type: 'integer', desc: '最多几条 URL，默认 100' },
        timeoutMs: { type: 'integer', desc: '超时，默认 20000' },
      },
      async run(a, ctx) {
        let base = a.url
        const sitemaps = []
        if (a.fromRobots !== false) {
          try {
            const root = new URL(base).origin
            const rb = await grab(ctx, `${root}/robots.txt`, { timeoutMs: a.timeoutMs })
            if (rb.ok) for (const m of rb.text.matchAll(/^sitemap:\s*(\S+)/gim)) sitemaps.push(m[1])
          } catch (e) {}
        }
        let target = /sitemap/i.test(base) ? base : sitemaps[0]
        if (!target) {
          try {
            target = new URL(base).origin + '/sitemap.xml'
          } catch (e) {
            target = base
          }
        }
        const r = await grab(ctx, target, { timeoutMs: a.timeoutMs })
        const urls = [...r.text.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decode(m[1].trim()))
        const subs = [...r.text.matchAll(/<sitemap>\s*<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decode(m[1].trim()))
        const cap = clamp(int(a.limit, 100), 1, 5000)
        return { robotsSitemaps: sitemaps, used: target, status: r.status, urlCount: urls.length, subSitemaps: subs.slice(0, 40), urls: urls.slice(0, cap) }
      },
    },
    {
      name: 'web_rss',
      desc: '解析 RSS / Atom 订阅源，返回条目（标题/链接/时间/摘要）',
      params: {
        url: { type: 'string', required: true, desc: '订阅地址' },
        limit: { type: 'integer', desc: '最多几条，默认 20' },
        timeoutMs: { type: 'integer', desc: '超时，默认 20000' },
      },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, a)
        const src = r.text
        const feed = { title: (src.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1], link: (src.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] }
        const items = []
        for (const m of src.matchAll(/<item[\s\S]*?<\/item>/gi)) {
          const g = (re) => {
            const x = m[0].match(re)
            return x ? decode(x[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()) : null
          }
          items.push({ title: g(/<title[^>]*>([\s\S]*?)<\/title>/i), link: g(/<link[^>]*>([\s\S]*?)<\/link>/i) || g(/<guid[^>]*>([\s\S]*?)<\/guid>/i), published: g(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || g(/<published[^>]*>([\s\S]*?)<\/published>/i), summary: (g(/<description[^>]*>([\s\S]*?)<\/description>/i) || '').slice(0, 300) })
        }
        if (!items.length) {
          for (const m of src.matchAll(/<entry[\s\S]*?<\/entry>/gi)) {
            const g = (re) => {
              const x = m[0].match(re)
              return x ? decode(x[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()) : null
            }
            items.push({ title: g(/<title[^>]*>([\s\S]*?)<\/title>/i), link: g(/<link[^>]*href=["']([^"']+)["']/i), published: g(/<updated[^>]*>([\s\S]*?)<\/updated>/i), summary: (g(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || '').slice(0, 300) })
          }
        }
        const cap = clamp(int(a.limit, 20), 1, 500)
        return { feed: { title: feed.title ? decode(feed.title) : null, link: feed.link }, total: items.length, items: items.slice(0, cap) }
      },
    },
    {
      name: 'web_api_paths',
      desc: '从页面与内联脚本里发现接口路径（api/ v1/ graphql 等）',
      params: {
        url: { type: 'string', required: true, desc: '完整地址' },
        limit: { type: 'integer', desc: '最多几条，默认 60' },
        timeoutMs: { type: 'integer', desc: '超时，默认 20000' },
      },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, a)
        const found = new Set()
        for (const m of r.text.matchAll(/["'`](\/(?:api|v\d|graphql|rest|rpc|internal)\/[\w./?=&{}-]{2,120})["'`]/gi)) found.add(m[1])
        for (const m of r.text.matchAll(/https?:\/\/[\w.-]+\/(?:api|v\d|graphql)\/[\w./?=&{}-]{2,120}/gi)) found.add(m[0])
        const scripts = [...r.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => absUrl(r.url, m[1]))
        const cap = clamp(int(a.limit, 60), 1, 500)
        return { url: r.url, paths: [...found].slice(0, cap), scriptFiles: scripts.slice(0, 20) }
      },
    },
    {
      name: 'web_assets',
      desc: '单页资源清单：script/link/img/iframe 数量与域名分布（看依赖）',
      params: { url: { type: 'string', required: true, desc: '完整地址' }, timeoutMs: { type: 'integer', desc: '超时，默认 20000' } },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, a)
        const hosts = {}
        const bump = (u) => {
          try {
            const h = new URL(absUrl(r.url, u)).hostname
            hosts[h] = (hosts[h] || 0) + 1
          } catch (e) {}
        }
        const count = (re) => {
          let n = 0
          for (const m of r.text.matchAll(re)) {
            n++
            bump(m[1])
          }
          return n
        }
        return {
          url: r.url,
          bytes: r.bytes,
          scripts: count(/<script[^>]+src=["']([^"']+)["']/gi),
          inlineScripts: (r.text.match(/<script(?![^>]+src)[^>]*>/gi) || []).length,
          styles: count(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi),
          images: count(/<img[^>]+src=["']([^"']+)["']/gi),
          iframes: count(/<iframe[^>]+src=["']([^"']+)["']/gi),
          trackers: Object.entries(hosts).filter(([h]) => /google|doubleclick|analytics|facebook|googletag|clarity|hotjar/i.test(h)),
          hosts: Object.entries(hosts).sort((x, y) => y[1] - x[1]).slice(0, 20).map(([h, n]) => `${String(n).padStart(4)} ${h}`),
        }
      },
    },
    {
      name: 'web_batch',
      desc: '批量抓多个 URL，返回状态矩阵与正文摘要（并发上限 6）',
      params: {
        urls: { type: 'array', required: true, desc: '地址列表', items: { type: 'string', desc: '一个 URL' } },
        concurrency: { type: 'integer', desc: '并发数，默认 4，最多 6' },
        timeoutMs: { type: 'integer', desc: '单个超时，默认 20000' },
        extract: { type: 'string', desc: 'text|meta|none，默认 meta', enum: ['text', 'meta', 'none'] },
      },
      async run(a, ctx) {
        const urls = (a.urls || []).slice(0, 40)
        const conc = clamp(int(a.concurrency, 4), 1, 6)
        const results = new Array(urls.length).fill(null)
        let cursor = 0
        const worker = async () => {
          for (;;) {
            const i = cursor++
            if (i >= urls.length) return
            try {
              const r = await grab(ctx, urls[i], { timeoutMs: a.timeoutMs })
              const row = { url: urls[i], status: r.status, ok: r.ok, bytes: r.bytes }
              if (a.extract === 'text') {
                const t = stripHtml(r.text)
                row.chars = t.length
                const t2 = r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
                row.title = t2 ? decode(t2[1]).trim().slice(0, 160) : null
                row.snippet = t.slice(0, 200)
              } else if (a.extract !== 'none') {
                row.title = ((r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim().slice(0, 120)
                row.description = ((r.text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '').slice(0, 160)
              }
              results[i] = row
            } catch (e) {
              results[i] = { url: urls[i], ok: false, reason: String(e && e.message).slice(0, 120) }
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(conc, urls.length || 1) }, worker))
        return { total: urls.length, ok: results.filter((r) => r && r.ok).length, results }
      },
    },
    {
      name: 'web_diff',
      desc: '两个地址（或同一地址两次抓）正文差异行数与样例',
      params: {
        left: { type: 'string', required: true, desc: '左边地址' },
        right: { type: 'string', desc: '右边地址；不给=再抓一次 left 与上次比' },
        saveSnapshot: { type: 'boolean', desc: '把本次正文存成快照，默认 true' },
        timeoutMs: { type: 'integer', desc: '超时，默认 25000' },
      },
      async run(a, ctx) {
        const L = await grab(ctx, a.left, { timeoutMs: a.timeoutMs })
        const lt = stripHtml(L.text).split('\n')
        let rt
        let source
        if (a.right) {
          const R = await grab(ctx, a.right, { timeoutMs: a.timeoutMs })
          rt = stripHtml(R.text).split('\n')
          source = 'two-urls'
        } else {
          const snapFile = path.join(ctx.dataDir, 'snapshots', `web-${Buffer.from(a.left).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}.json`)
          const prev = fs.existsSync(snapFile) ? JSON.parse(fs.readFileSync(snapFile, 'utf8')) : null
          if (!prev) {
            ensureDir(path.dirname(snapFile))
            fs.writeFileSync(snapFile, JSON.stringify({ url: a.left, takenAt: Date.now(), lines: lt }), 'utf8')
            return { firstRun: true, saved: snapFile, lines: lt.length, note: '首次抓取已存快照，下次再调就能比差异' }
          }
          rt = prev.lines
          source = `snapshot:${new Date(prev.takenAt).toISOString()}`
          if (a.saveSnapshot !== false) fs.writeFileSync(snapFile, JSON.stringify({ url: a.left, takenAt: Date.now(), lines: lt }), 'utf8')
        }
        const setL = new Set(lt)
        const setR = new Set(rt)
        const onlyL = lt.filter((l) => l.trim() && !setR.has(l))
        const onlyR = rt.filter((l) => l.trim() && !setL.has(l))
        return { left: a.left, compareWith: source, leftLines: lt.length, rightLines: rt.length, removed: onlyL.length, added: onlyR.length, sample: [...onlyL.slice(0, 20).map((l) => `- ${l.slice(0, 160)}`), ...onlyR.slice(0, 20).map((l) => `+ ${l.slice(0, 160)}`)] }
      },
    },
    {
      name: 'web_headers',
      desc: '看响应头与跳转链（服务器、缓存、安全头、内容类型）',
      params: {
        url: { type: 'string', required: true, desc: '完整地址' },
        method: { type: 'string', desc: 'GET|HEAD，默认 GET', enum: ['GET', 'HEAD'] },
        timeoutMs: { type: 'integer', desc: '超时，默认 20000' },
      },
      async run(a, ctx) {
        const r = await grab(ctx, a.url, { method: a.method || 'GET', timeoutMs: a.timeoutMs })
        const h = r.headers
        return {
          url: a.url,
          finalUrl: r.url,
          status: r.status,
          ok: r.ok,
          bytes: r.bytes,
          server: h['server'] || null,
          contentType: h['content-type'] || null,
          contentLength: h['content-length'] || null,
          cacheControl: h['cache-control'] || null,
          via: h['via'] || null,
          cdn: Object.entries(h).filter(([k]) => /cf-ray|x-cache|x-served-by|x-amz-cf|server-timing/i.test(k)).slice(0, 6),
          security: {
            csp: !!h['content-security-policy'],
            hsts: !!h['strict-transport-security'],
            xframe: h['x-frame-options'] || null,
            xcto: h['x-content-type-options'] || null,
          },
          cookieCount: (h['set-cookie'] || '').split(',').length,
        }
      },
    },
    {
      name: 'web_form_post',
      desc: '表单 POST（urlencoded 或 JSON），返回状态与响应片段',
      write: true,
      params: {
        url: { type: 'string', required: true, desc: '提交地址' },
        data: { type: 'object', required: true, desc: '表单字段', props: {} },
        as: { type: 'string', desc: 'form|json，默认 form', enum: ['form', 'json'] },
        headers: { type: 'object', desc: '附加请求头', props: {} },
        timeoutMs: { type: 'integer', desc: '超时，默认 20000' },
      },
      async run(a, ctx) {
        const body = a.as === 'json' ? JSON.stringify(a.data || {}) : new URLSearchParams(Object.entries(a.data || {}).map(([k, v]) => [k, String(v)])).toString()
        const r = await grab(ctx, a.url, {
          method: 'POST',
          timeoutMs: a.timeoutMs,
          body,
          headers: { 'content-type': a.as === 'json' ? 'application/json' : 'application/x-www-form-urlencoded; charset=utf-8', ...(a.headers || {}) },
        })
        return { url: a.url, status: r.status, ok: r.ok, bytes: r.bytes, sentBytes: Buffer.byteLength(body), body: stripHtml(r.text).slice(0, 1200) }
      },
    },
    {
      name: 'web_status_matrix',
      desc: '一批 URL 的状态码矩阵（并发 6），快速看哪些挂了',
      params: {
        urls: { type: 'array', required: true, desc: '地址列表', items: { type: 'string', desc: '一个 URL' } },
        method: { type: 'string', desc: 'GET|HEAD，默认 HEAD', enum: ['GET', 'HEAD'] },
        concurrency: { type: 'integer', desc: '并发，默认 6' },
        timeoutMs: { type: 'integer', desc: '单个超时，默认 10000' },
      },
      async run(a, ctx) {
        const urls = (a.urls || []).slice(0, 100)
        const conc = clamp(int(a.concurrency, 6), 1, 10)
        const results = new Array(urls.length).fill(null)
        let cursor = 0
        const worker = async () => {
          for (;;) {
            const i = cursor++
            if (i >= urls.length) return
            const t0 = Date.now()
            try {
              const res = await ctx.fetch(urls[i], { method: a.method || 'HEAD', timeoutMs: a.timeoutMs, headers: { 'user-agent': UA }, redirect: 'follow' })
              results[i] = { url: urls[i], status: res.status, ok: res.ok, ms: Date.now() - t0 }
            } catch (e) {
              results[i] = { url: urls[i], status: null, ok: false, ms: Date.now() - t0, reason: String(e && e.message).slice(0, 100) }
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(conc, urls.length || 1) }, worker))
        const bad = results.filter((r) => !r || !r.ok)
        return { total: urls.length, ok: urls.length - bad.length, bad: bad.slice(0, 40), rows: results.map((r) => `${r.ok ? '✓' : 'x'} ${String(r.status || '---').padEnd(4)} ${String(r.ms).padStart(6)}ms ${r.url}`) }
      },
    },
    {
      name: 'web_search_saved',
      desc: '在已存到工作区的抓取正文（clippings 等）里按关键词搜索',
      params: {
        query: { type: 'string', required: true, desc: '关键词（子串，忽略大小写）' },
        path: { type: 'string', desc: '搜索根，默认 clippings' },
        include: { type: 'string', desc: '只搜这些文件，glob 例如 *.md' },
        limit: { type: 'integer', desc: '最多几条命中，默认 40' },
      },
      async run(a, ctx) {
        const { walkFiles, globToRe, readTextSafe } = await import('../util.js')
        const root = ctx.resolve(a.path || 'clippings')
        const inc = a.include ? globToRe(a.include) : globToRe('*.md')
        const cap = clamp(int(a.limit, 40), 1, 500)
        const q = String(a.query).toLowerCase()
        const out = []
        for (const f of walkFiles(root, { maxFiles: 5000 })) {
          if (!inc.test(path.relative(root, f).replace(/\\/g, '/'))) continue
          const r = await readTextSafe(f, 1024 * 1024)
          if (!r.ok) continue
          const lines = r.text.split(/\r?\n/)
          const hits = []
          for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(q)) hits.push(`${i + 1}: ${lines[i].slice(0, 200)}`)
          if (!hits.length) continue
          out.push({ file: path.relative(root, f), hits: hits.length, sample: hits.slice(0, 4) })
          if (out.length >= cap) break
        }
        return { root, query: a.query, files: out.length, matches: out }
      },
    },
    {
      name: 'web_cookie_parse',
      desc: '解析 Cookie / Set-Cookie 头成结构化字段',
      params: { header: { type: 'string', required: true, desc: 'Cookie 或 Set-Cookie 原文' } },
      async run(a) {
        const src = String(a.header).trim()
        if (/set-cookie/i.test(src) || /=\s*[^;]*;\s*(path|domain|expires|httponly|secure|samesite)/i.test(src)) {
          const parts = src.split(/,\s*(?=[^;]+=[^;]+;)/)
          return {
            kind: 'set-cookie',
            cookies: parts.map((p) => {
              const seg = p.split(';').map((s) => s.trim())
              const [kv] = seg
              const eq = kv.indexOf('=')
              return {
                name: eq < 0 ? kv : kv.slice(0, eq),
                value: eq < 0 ? '' : kv.slice(eq + 1),
                attrs: Object.fromEntries(seg.slice(1).map((s) => {
                  const i = s.indexOf('=')
                  return i < 0 ? [s.toLowerCase(), true] : [s.slice(0, i).toLowerCase(), s.slice(i + 1)]
                })),
              }
            }),
          }
        }
        return {
          kind: 'cookie',
          cookies: src.split(/;\s*/).filter(Boolean).map((p) => {
            const i = p.indexOf('=')
            return { name: i < 0 ? p : p.slice(0, i), value: i < 0 ? '' : p.slice(i + 1) }
          }),
        }
      },
    },
  ],
}
