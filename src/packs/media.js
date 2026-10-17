// 媒体文件包：图片/PDF/音视频的元数据解析（纯 node:zlib + 手写二进制头），
// 有 ffmpeg/ffprobe 就用，没有就自己读文件头。零依赖。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { json, int, clamp, fmtBytes, fmtMs, readTextSafe, walkFiles, md5, sha256 } from '../util.js'

/** readTextSafe 返回 {ok,text}；这里收成字符串或 null。 */
async function readStr(abs, limitBytes = 4000000) {
  const r = await readTextSafe(abs, limitBytes)
  return r && r.ok ? r.text : null
}

const MAGIC = [
  [/^89504e47/, 'PNG'],
  [/^ffd8ffe0..4a464946/, 'JPEG (JFIF)'],
  [/^ffd8ffe1..45786966/, 'JPEG (Exif)'],
  [/^ffd8/, 'JPEG'],
  [/^47494638/, 'GIF'],
  [/^52494646(.{8})57454250/, 'WebP'],
  [/^52494646(.{8})41564920/, 'AVI'],
  [/^52494646(.{8})57415645/, 'WAV'],
  [/^255044462d/, 'PDF'],
  [/^1a45dfa3/, 'Matroska/WebM'],
  [/^000000..66747970/, 'MP4/MOV'],
  [/^66747970/, 'MP4/MOV'],
  [/^494433/, 'MP3 (ID3)'],
  [/^ff[fe][fcfb]/, 'MP3'],
  [/^4f676753/, 'OGG'],
  [/^664c6143/, 'FLAC'],
  [/^7b5c727466/, 'RTF'],
  [/^504b0304/, 'ZIP/DOCX/XLSX/PPTX/EPUB'],
  [/^7b0a|^7b20|^7b22/, 'JSON'],
  [/^3c3f786d6c/, 'XML/SVG'],
  [/^3c21444f4354595045|^3c68746d6c|^3c21646f6374797065/, 'HTML'],
  [/^474946383761|^474946383961/, 'GIF'],
  [/^7573706163/, 'SQLite'],
  [/^53514c69746520666f726d6174203300/, 'SQLite'],
  [/^7f454c46/, 'ELF'],
  [/^4d5a/, 'PE/DLL/EXE'],
  [/^cafebabe/, 'Mach-O (fat)/class'],
  [/^feedfacf|^cffaedfe|^cefaedfe|^213c617263683e/, 'Mach-O'],
  [/^25215053462d/, 'PostScript'],
  [/^3c3f786d6c2076657273696f6e2e312e30223e3c737667/, 'SVG'],
  [/^edabeef8|^0e776270/, 'npm tarball/其他'],
  [/^424d/, 'BMP'],
  [/^3d73646b/, '未知'],
]

function hex(buf, n = 24) {
  return buf.subarray(0, n).toString('hex')
}

function detectKind(buf) {
  const h = buf.subarray(0, 16).toString('hex')
  for (const [re, name] of MAGIC) if (re.test(h)) return name
  // 文本判定
  let nonPrintable = 0
  for (let i = 0; i < Math.min(buf.length, 512); i++) {
    const c = buf[i]
    if (c === 9 || c === 10 || c === 13) continue
    if (c < 32 || c > 126) {
      if (c >= 0xc0 || (c >= 0x80 && c <= 0xbf)) continue
      nonPrintable++
    }
  }
  return nonPrintable > 8 ? '二进制(未知)' : '文本'
}

function readU32(buf, off) {
  return buf.length < off + 4 ? null : buf.readUInt32BE(off)
}

function decodePng(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { error: '不是 PNG' }
  const ihdr = buf.subarray(33, 33)
  const w = readU32(buf, 16)
  const h = readU32(buf, 20)
  const bitDepth = buf[24]
  const colorType = buf[25]
  const interlace = buf[28]
  const chunks = []
  let off = 8
  let idat = []
  let palette = null
  let trns = null
  let text = {}
  while (off + 8 <= buf.length) {
    const len = readU32(buf, off)
    if (len === null || off + 12 + len > buf.length) break
    const type = buf.subarray(off + 4, off + 8).toString('latin1')
    const data = buf.subarray(off + 8, off + 8 + len)
    chunks.push({ type, bytes: len })
    if (type === 'IDAT') idat.push(data)
    else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const s = data.toString('latin1')
      const i = s.indexOf('\0')
      if (i > 0) text[s.slice(0, i)] = s.slice(i + 1, i + 100)
    }
    off += 12 + len
  }
  const out = { width: w, height: h, bitDepth, colorType, interlace, chunks: chunks.length, chunkTypes: [...new Set(chunks.map((c) => c.type))], metadataKeys: Object.keys(text).slice(0, 10), paletteColors: palette ? palette.length / 3 : 0 }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (bitDepth === 8 && channels && !interlace && w > 0 && h > 0) {
    try {
      const raw = zlib.inflateSync(Buffer.concat(idat))
      const stride = w * channels
      const px = Buffer.alloc(stride * h)
      let pos = 0
      for (let y = 0; y < h; y++) {
        const filter = raw[pos++]
        const line = raw.subarray(pos, pos + stride)
        pos += stride
        const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
        const cur = px.subarray(y * stride, (y + 1) * stride)
        for (let x = 0; x < stride; x++) {
          const a = x >= channels ? cur[x - channels] : 0
          const b = prev[x]
          const c = x >= channels ? prev[x - channels] : 0
          let v = line[x]
          if (filter === 1) v = (v + a) & 255
          else if (filter === 2) v = (v + b) & 255
          else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
          else if (filter === 4) {
            const p = a + b - c
            const pa = Math.abs(p - a)
            const pb = Math.abs(p - b)
            const pc = Math.abs(p - c)
            v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
          }
          cur[x] = v
        }
      }
      out.decoded = true
      // 采样取主色 + 平均哈希
      const colorCount = new Map()
      let graySum = 0
      const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4096)))
      const hashBits = []
      let hashCount = 0
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const i = y * stride + x * channels
          let r, g, b
          if (colorType === 3) {
            const p = px[i] * 3
            r = palette ? palette[p] : 0
            g = palette ? palette[p + 1] : 0
            b = palette ? palette[p + 2] : 0
          } else if (colorType === 0) r = g = b = px[i]
          else if (colorType === 4) r = g = b = px[i]
          else {
            r = px[i]
            g = px[i + 1]
            b = px[i + 2]
          }
          const key = `${r >> 5}-${g >> 5}-${b >> 5}`
          colorCount.set(key, (colorCount.get(key) || 0) + 1)
          const gray = 0.299 * r + 0.587 * g + 0.114 * b
          graySum += gray
          if (hashCount < 64) {
            hashBits.push(gray)
            hashCount++
          }
        }
      }
      out.averageGray = Math.round(graySum / Math.max(1, Math.floor(h / step) * Math.floor(w / step)))
      out.dominantColors = [...colorCount.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, n]) => {
        const [r, g, b] = k.split('-').map((x) => Number(x) * 32 + 16)
        return { rgb: `#${[r, g, b].map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('')}`, share: Number((100 * n / Math.max(1, Math.floor(h / step) * Math.floor(w / step))).toFixed(1)) }
      })
      if (hashBits.length >= 16) {
        const avg = hashBits.reduce((s, v) => s + v, 0) / hashBits.length
        out.averageHash = hashBits.map((v) => (v > avg ? '1' : '0')).join('')
      }
    } catch (e) {
      out.decodeNote = `像素解码失败: ${String(e && e.message).slice(0, 100)}`
    }
  }
  return out
}

function decodeJpeg(buf) {
  const out = { markers: [], comments: {} }
  let off = 2
  let sof = null
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) break
    const marker = buf[off + 1]
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2
      continue
    }
    if (marker === 0xd9) break
    const len = buf.readUInt16BE(off + 2)
    const seg = buf.subarray(off + 4, off + 2 + len)
    const name = marker.toString(16).padStart(2, '0')
    out.markers.push(`${name}(${len})`)
    if (marker === 0xc0 || marker === 0xc2 || marker === 0xc3) {
      sof = { progressive: marker === 0xc2, height: seg.readUInt16BE(1), width: seg.readUInt16BE(3), components: seg[0], bits: seg.readUInt16BE(1) }
      const comps = []
      for (let i = 0; i < seg[0]; i++) {
        const base = 1 + 3 + i * 3
        if (base + 2 < seg.length) comps.push({ id: seg[base], h: seg[base + 1] >> 4, v: seg[base + 1] & 15 })
      }
      if (sof) {
        sof.channels = seg[0]
        sof.sampling = comps.map((c) => `${c.h}x${c.v}`).join(' ')
      }
    } else if (marker === 0xe1 && seg.subarray(0, 4).toString('latin1') === 'Exif') {
      out.exif = parseExif(seg.subarray(6))
    } else if (marker === 0xfe) {
      out.comments.comment = seg.toString('latin1').slice(0, 200)
    } else if (marker === 0xed && seg.subarray(0, 14).toString('latin1').startsWith('Adobe')) {
      out.adobe = true
    }
    off += 2 + len
  }
  return { ...out, sof: sof || null, markers: out.markers.slice(0, 30) }
}

function parseExif(tiff) {
  if (!tiff || tiff.length < 8) return null
  const little = tiff.subarray(0, 2).toString('latin1') === 'II'
  const u16 = (o) => (o + 2 <= tiff.length ? (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)) : 0)
  const u32 = (o) => (o + 4 <= tiff.length ? (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)) : 0)
  if (u16(0) !== 0x2a) return null
  const ifd0 = u32(4)
  const tags = {}
  const readIfd = (base) => {
    const n = u16(base)
    for (let i = 0; i < n; i++) {
      const e = base + 2 + i * 12
      if (e + 12 > tiff.length) break
      const tag = u16(e)
      const type = u16(e + 2)
      const count = u32(e + 4)
      const valOff = count * (type === 2 || type === 7 ? 1 : type === 3 ? 2 : 4) <= 4 ? e + 8 : u32(e + 8)
      if (tag === 0x010f || tag === 0x0110 || tag === 0x0131 || tag === 0x0132 || tag === 0x9003 || tag === 0x9004 || tag === 0x8298 || tag === 0x8769) {
        const s = tiff.subarray(valOff, valOff + Math.min(count, 64)).toString('latin1').replace(/\0.*/g, '')
        tags[tag.toString(16)] = s
      } else if (tag === 0x0112 || tag === 0x011a || tag === 0x8825 || tag === 0xa002 || tag === 0xa003) {
        tags[tag.toString(16)] = type === 5 ? `${u32(valOff)}/${u32(valOff + 4)}` : u32(valOff) || u16(valOff)
      }
    }
    return u32(base + 2 + n * 12)
  }
  const ifd1 = readIfd(ifd0)
  if (tags['8769']) readIfd(u32(4 + Number(tags['8769']) * 0) + (u32(ifd0 + 2 + u16(ifd0) * 12 + 4) || 0))
  const names = { 'f': 'make', '10': 'model', '31': 'software', '32': 'modifyDate', '112': 'orientation', '11a': 'xres', '9003': 'dateTimeOriginal', '9004': 'dateTimeDigitized', 'a002': 'width', 'a003': 'height', '8825': 'gpsIfd' }
  const out = {}
  for (const [k, v] of Object.entries(tags)) out[names[k] || `tag_${k}`] = v
  return out
}

function decodePdf(buf) {
  const head = buf.subarray(0, 1024).toString('latin1')
  const version = (head.match(/%PDF-([\d.]+)/) || [])[1] || null
  const tail = buf.subarray(Math.max(0, buf.length - 4096)).toString('latin1')
  const startxref = (tail.match(/startxref\s+(\d+)/) || [])[1]
  const pages = [...buf.toString('latin1').matchAll(/\/Type\s*\/Page[^s]/g)].length
  const info = {}
  const all = buf.toString('latin1')
  for (const key of ['Title', 'Author', 'Subject', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Keywords']) {
    const m = all.match(new RegExp(`/${key}\\s*\\(([^)]{0,200})\\)`))
    if (m) info[key] = m[1]
  }
  const fonts = [...new Set([...all.matchAll(/\/BaseFont\s*\/([\w+-]+)/g)].map((m) => m[1]))].slice(0, 20)
  const images = [...all.matchAll(/\/Subtype\s*\/(?:Image|DCTDecode|FlateDecode)/g)].length
  return { version, pages: pages || null, startxref: startxref || null, encrypted: /\/Encrypt\b/.test(all), linearized: /\/Linearized\b/.test(all), info, fonts, imageObjects: images, streams: (all.match(/stream/g) || []).length / 2 | 0 }
}

function decodeMp4(buf) {
  const out = { boxes: [] }
  let off = 0
  const scan = (start, end, depth) => {
    let p = start
    while (p + 8 <= end) {
      let size = buf.readUInt32BE(p)
      const type = buf.subarray(p + 4, p + 8).toString('latin1')
      let headerSize = 8
      if (size === 1) {
        size = Number(buf.readBigUInt64BE(p + 8))
        headerSize = 16
      } else if (size === 0) size = end - p
      if (size < 8 || p + size > end) break
      out.boxes.push(`${'  '.repeat(depth)}${type} ${fmtBytes(size)}`)
      if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl') scan(p + headerSize + 0, p + size, depth + 1)
      if (type === 'mvhd') {
        const ver = buf[p + headerSize]
        const timescale = ver === 1 ? buf.readUInt32BE(p + headerSize + 20) : buf.readUInt32BE(p + headerSize + 12)
        const dur = ver === 1 ? Number(buf.readBigUInt64BE(p + headerSize + 24)) : buf.readUInt32BE(p + headerSize + 16)
        out.timescale = timescale
        out.durationSeconds = timescale ? Number((dur / timescale).toFixed(2)) : null
      }
      if (type === 'tkhd') {
        const ver = buf[p + headerSize]
        const base = p + headerSize + (ver === 1 ? 32 : 20)
        if (base + 8 <= end) {
          out.width = buf.readUInt32BE(base + 4) >> 16
          out.height = buf.readUInt32BE(base + 8) >> 16
        }
      }
      if (type === 'ftyp') out.brands = buf.subarray(p + headerSize + 4, p + Math.min(size, headerSize + 16)).toString('latin1').replace(/\0/g, ' ').trim()
      p += size
    }
  }
  scan(0, Math.min(buf.length, 2000000), 0)
  out.boxes = out.boxes.slice(0, 40)
  return out
}

function decodeWav(buf) {
  if (buf.subarray(0, 4).toString('latin1') !== 'RIFF') return null
  const fmt = buf.subarray(12, 16).toString('latin1')
  const ch = buf.readUInt16LE(22)
  const rate = buf.readUInt32LE(24)
  const byteRate = buf.readUInt32LE(28)
  const bits = buf.readUInt16LE(34)
  let dataLen = 0
  let p = 12
  while (p + 8 <= buf.length) {
    const id = buf.subarray(p, p + 4).toString('latin1')
    const sz = buf.readUInt32LE(p + 4)
    if (id === 'data') dataLen = sz
    p += 8 + sz + (sz % 2)
  }
  return { format: fmt, channels: ch, sampleRate: rate, bitsPerSample: bits, byteRate, dataSize: dataLen || null, durationSeconds: byteRate ? Number(((dataLen || buf.length) / byteRate).toFixed(2)) : null }
}

function decodeMp3(buf) {
  let off = 0
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
    off = 10 + size
  }
  const tags = {}
  if (buf.length >= 128) {
    const tail = buf.subarray(buf.length - 128).toString('latin1')
    if (tail.startsWith('TAG')) tags.id3v1 = { title: tail.slice(3, 33).trim(), artist: tail.slice(33, 63).trim(), album: tail.slice(63, 93).trim(), year: tail.slice(93, 97).trim(), genre: tail[127].charCodeAt(0) }
  }
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
  for (let i = off; i < Math.min(buf.length - 4, off + 200000); i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const ver = (buf[i + 1] >> 3) & 3
      const layer = (buf[i + 1] >> 1) & 3
      const brIdx = (buf[i + 2] >> 4) & 15
      const srIdx = (buf[i + 2] >> 2) & 3
      const bitrate = bitrates[brIdx]
      const rates = ver === 3 ? [44100, 48000, 32000, 0] : ver === 2 ? [22050, 24000, 16000, 0] : [11025, 12000, 8000, 0]
      return { version: ver === 3 ? 'MPEG1' : ver === 2 ? 'MPEG2' : 'MPEG2.5', layer: `Layer${4 - layer}`, bitrateKbps: bitrate, sampleRate: rates[srIdx], channelMode: (buf[i + 3] >> 6) & 3 === 3 ? 'mono' : 'stereo', id3v1: tags.id3v1 || null, frameOffset: i }
    }
  }
  return { id3v1: tags.id3v1 || null, note: '没找到 MPEG 帧头' }
}

function decodeSvg(text) {
  const out = {}
  const root = (text.match(/<svg[^>]*>/i) || [''])[0]
  out.width = (root.match(/\bwidth\s*=\s*["']([^"']+)["']/i) || [])[1] || null
  out.height = (root.match(/\bheight\s*=\s*["']([^"']+)["']/i) || [])[1] || null
  out.viewBox = (root.match(/\bviewBox\s*=\s*["']([^"']+)["']/i) || [])[1] || null
  out.textNodes = (text.match(/>\s*[^<>]+</g) || []).length
  out.paths = (text.match(/<path\b/gi) || []).length
  out.texts = (text.match(/<text\b/gi) || []).length
  out.images = (text.match(/<image\b/gi) || []).length
  out.embeddedBase64 = (text.match(/data:image\/[a-z+]+;base64/gi) || []).length
  out.defs = (text.match(/<(linearGradient|radialGradient|filter|clipPath|mask|symbol|use)\b/gi) || []).length
  out.fonts = [...new Set([...text.matchAll(/font-family\s*[:=]\s*["']?([^"';<]+)/gi)].map((m) => m[1].trim()))].slice(0, 10)
  return out
}

async function probeWith(ctx, file, timeoutMs) {
  const r = await ctx.exec('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: clamp(int(timeoutMs, 30000), 3000, 180000) })
  if (r.code !== 0 && !String(r.stdout).trim()) return { available: false, message: String(r.stderr).slice(0, 200) || 'ffprobe 不可用' }
  try {
    const j = JSON.parse(String(r.stdout))
    const v = (j.streams || []).find((s) => s.codec_type === 'video')
    const a = (j.streams || []).find((s) => s.codec_type === 'audio')
    return {
      available: true,
      format: j.format && { formatName: j.format.format_name, duration: j.format.duration, bitrate: j.format.bit_rate, size: j.format.size ? fmtBytes(Number(j.format.size)) : null, tags: j.format.tags },
      video: v && { codec: v.codec_name, width: v.width, height: v.height, fps: v.r_frame_rate, pixFmt: v.pix_fmt, bitRate: v.bit_rate, profile: v.profile },
      audio: a && { codec: a.codec_name, sampleRate: a.sample_rate, channels: a.channels, bitRate: a.bit_rate, profile: a.profile },
      streams: (j.streams || []).map((s) => `${s.index}:${s.codec_type}:${s.codec_name}`),
    }
  } catch (e) {
    return { available: true, raw: String(r.stdout).slice(0, 3000) }
  }
}

export default {
  id: 'media',
  title: '媒体与文件类型',
  tags: ['media', 'image', 'pdf', 'audio', 'video', 'ffmpeg'],
  summary: '图片/PDF/音视频元数据、主色与平均哈希、文件魔数识别、校验和、ffprobe/ffmpeg 调用',
  tools: [
    {
      name: 'media_file_kind',
      desc: '魔数识别文件真实类型（不看扩展名），给头部十六进制',
      params: {
        path: { type: 'string', required: true, desc: '文件路径' },
        headerBytes: { type: 'integer', desc: '读多少字节判断，默认 512' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        if (!fs.existsSync(abs)) return json({ ok: false, message: `找不到文件: ${abs}` })
        const st = fs.statSync(abs)
        if (st.isDirectory()) return json({ ok: false, message: '这是目录，不是文件' })
        const n = clamp(int(a.headerBytes, 512), 32, 65536)
        const fd = await fs.promises.open(abs, 'r')
        const buf = Buffer.alloc(Math.min(n, st.size))
        await fd.read(buf, 0, buf.length, 0)
        await fd.close()
        const ext = (path.extname(abs) || '').toLowerCase()
        const kind = detectKind(buf)
        const guessByExt = { '.js': 'JavaScript', '.ts': 'TypeScript', '.json': 'JSON', '.md': 'Markdown', '.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.gif': 'GIF', '.pdf': 'PDF', '.mp3': 'MP3', '.mp4': 'MP4', '.zip': 'ZIP', '.db': 'SQLite', '.sqlite': 'SQLite', '.svg': 'SVG', '.html': 'HTML', '.exe': 'PE', '.dll': 'PE', '.so': 'ELF' }
        return {
          file: a.path,
          size: fmtBytes(st.size),
          mtime: new Date(st.mtimeMs).toISOString(),
          detected: kind,
          extensionSays: guessByExt[ext] || ext || '(无扩展名)',
          mismatch: guessByExt[ext] && !kind.startsWith(guessByExt[ext].split(' ')[0]) && !kind.includes(guessByExt[ext].split(' ')[0]) ? '扩展名与内容不符' : null,
          headerHex: hex(buf, 32),
          headerText: buf.subarray(0, 64).toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
        }
      },
    },
    {
      name: 'media_image_info',
      desc: '图片信息：尺寸/位深/色彩类型/主色/平均哈希（PNG/JPEG/GIF/WebP/BMP 自解）',
      params: {
        path: { type: 'string', required: true, desc: '图片路径' },
        withColors: { type: 'boolean', desc: 'PNG 解像素取主色，默认 true' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        if (!fs.existsSync(abs)) return json({ ok: false, message: `找不到文件: ${abs}` })
        const st = fs.statSync(abs)
        const buf = fs.readFileSync(abs).subarray(0, Math.min(st.size, 40 * 1024 * 1024))
        const base = { file: a.path, size: fmtBytes(st.size), mtime: new Date(st.mtimeMs).toISOString(), kind: detectKind(buf) }
        const h = buf.subarray(0, 8).toString('hex')
        if (h.startsWith('89504e47')) {
          const info = decodePng(buf)
          if (a.withColors === false) delete info.dominantColors
          return { ...base, format: 'PNG', ...info }
        }
        if (h.startsWith('ffd8')) return { ...base, format: 'JPEG', ...decodeJpeg(buf) }
        if (h.startsWith('47494638')) {
          const w = buf.readUInt16LE(6)
          const g = buf.readUInt16LE(8)
          const frames = (buf.toString('latin1').match(/\x00\x21\xf9\x04/g) || []).length
          return { ...base, format: 'GIF', width: w, height: g, frames: frames || 1, globalPalette: !!(buf[10] & 0x80), paletteColors: buf[10] & 0x80 ? ((buf[10] & 7) + 1) * 2 : 0, aspectRatio: (w / g).toFixed(3) }
        }
        if (h.startsWith('52494646') && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
          const vp8 = buf.subarray(12, 16).toString('latin1')
          let w = null
          let g = null
          if (vp8 === 'VP8X') {
            w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
            g = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
          } else if (vp8 === 'VP8 ') {
            w = buf.readUInt16LE(26) & 0x3fff
            g = buf.readUInt16LE(28) & 0x3fff
          } else if (vp8 === 'VP8L') {
            const bits = buf.readUInt32LE(21)
            w = (bits & 0x3fff) + 1
            g = ((buf.readUInt32LE(24) & 0xffff) >> 2) + 1
          }
          return { ...base, format: 'WebP', subtype: vp8.trim(), width: w, height: g }
        }
        if (h.startsWith('424d')) return { ...base, format: 'BMP', width: buf.readInt32LE(18), height: buf.readInt32LE(22), bitsPerPixel: buf.readUInt16LE(28) }
        return { ...base, note: '不是常见图片格式（可试 media_ffprobe 或 media_svg_info）' }
      },
    },
    {
      name: 'media_image_exif',
      desc: 'JPEG EXIF 拍摄信息：机型/时间/方向/GPS/尺寸（手写 TIFF 解析）',
      params: { path: { type: 'string', required: true, desc: 'JPEG 路径' } },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        if (!fs.existsSync(abs)) return json({ ok: false, message: `找不到文件: ${abs}` })
        const buf = fs.readFileSync(abs).subarray(0, 20 * 1024 * 1024)
        if (buf.subarray(0, 2).toString('hex') !== 'ffd8') return json({ ok: false, message: '不是 JPEG' })
        const info = decodeJpeg(buf)
        return { file: a.path, size: fmtBytes(buf.length), sof: info.sof, exif: info.exif || null, comment: info.comments.comment || null, note: info.exif ? null : '没找到 Exif 段（截图/压缩过的图通常已剥离）' }
      },
    },
    {
      name: 'media_image_compare',
      desc: '比两张图：字节/哈希/尺寸/平均哈希汉明距离（找重复图）',
      params: {
        a: { type: 'string', required: true, desc: '图 A 路径' },
        b: { type: 'string', required: true, desc: '图 B 路径' },
      },
      async run(a, ctx) {
        const read = async (p) => {
          const abs = ctx.resolve(p)
          if (!fs.existsSync(abs)) return { file: p, missing: true }
          const buf = fs.readFileSync(abs)
          const h = buf.subarray(0, 8).toString('hex')
          let dims = null
          let hash = null
          if (h.startsWith('89504e47')) {
            const d = decodePng(buf)
            dims = d.width && d.height ? `${d.width}x${d.height}` : null
            hash = d.averageHash || null
          } else if (h.startsWith('ffd8')) {
            const d = decodeJpeg(buf)
            dims = d.sof ? `${d.sof.width}x${d.sof.height}` : null
          } else if (h.startsWith('47494638')) dims = `${buf.readUInt16LE(6)}x${buf.readUInt16LE(8)}`
          return { file: p, size: buf.length, sizeHuman: fmtBytes(buf.length), md5: md5(buf), sha256: sha256(buf), dims, averageHash: hash, kind: detectKind(buf.subarray(0, 16)) }
        }
        const A = await read(a.a)
        const B = await read(a.b)
        let hamming = null
        if (A.averageHash && B.averageHash && A.averageHash.length === B.averageHash.length) {
          let d = 0
          for (let i = 0; i < A.averageHash.length; i++) if (A.averageHash[i] !== B.averageHash[i]) d++
          hamming = { distance: d, length: A.averageHash.length, similarPercent: Number((100 * (1 - d / A.averageHash.length)).toFixed(1)) }
        }
        return {
          a: A,
          b: B,
          identicalBytes: A.sha256 && A.sha256 === B.sha256,
          sameDimensions: A.dims && A.dims === B.dims,
          perceptual: hamming,
          verdict: A.sha256 && A.sha256 === B.sha256 ? '完全相同' : hamming && hamming.similarPercent >= 90 ? '高度相似（可能是缩放/重压缩）' : hamming && hamming.similarPercent >= 70 ? '有点相似' : '看起来不同',
        }
      },
    },
    {
      name: 'media_pdf_info',
      desc: 'PDF 元数据：版本、页数、加密、作者/生产者、字体、图片对象数',
      params: { path: { type: 'string', required: true, desc: 'PDF 路径' }, deep: { type: 'boolean', desc: '全量扫（大 PDF 慢），默认只扫前 8MB', } },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        if (!fs.existsSync(abs)) return json({ ok: false, message: `找不到文件: ${abs}` })
        const st = fs.statSync(abs)
        const cap = a.deep ? st.size : Math.min(st.size, 8 * 1024 * 1024)
        const fd = await fs.promises.open(abs, 'r')
        const buf = Buffer.alloc(cap)
        await fd.read(buf, 0, cap, 0)
        await fd.close()
        const info = decodePdf(buf)
        return { file: a.path, size: fmtBytes(st.size), mtime: new Date(st.mtimeMs).toISOString(), scannedBytes: fmtBytes(cap), ...info, note: info.pages ? null : '页数没数到（可能加密或超出扫描范围），传 deep=true 再试' }
      },
    },
    {
      name: 'media_pdf_text_sample',
      desc: '从 PDF 抽文本样本（解压内容流找 Tj/TJ 字符串），验证正文在不在',
      params: {
        path: { type: 'string', required: true, desc: 'PDF 路径' },
        maxChars: { type: 'integer', desc: '最多返回字符，默认 3000' },
        scanBytes: { type: 'integer', desc: '扫多少字节，默认 4194304（4MB）' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        if (!fs.existsSync(abs)) return json({ ok: false, message: `找不到文件: ${abs}` })
        const st = fs.statSync(abs)
        const cap = clamp(int(a.scanBytes, 4194304), 65536, 64 * 1024 * 1024)
        const fd = await fs.promises.open(abs, 'r')
        const buf = Buffer.alloc(Math.min(cap, st.size))
        await fd.read(buf, 0, buf.length, 0)
        await fd.close()
        const cap2 = clamp(int(a.maxChars, 3000), 200, 100000)
        const chunks = []
        let inflated = 0
        for (const m of buf.toString('latin1').matchAll(/stream\r?\n/g)) {
          const start = m.index + m[0].length
          const end = buf.toString('latin1').indexOf('endstream', start)
          if (end < 0) continue
          const raw = buf.subarray(start, end)
          try {
            const out = zlib.inflateSync(raw)
            inflated++
            const txt = out.toString('latin1')
            for (const t of txt.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj|\[((?:[^\[\]]|\[[^\]]*\])*)\]\s*TJ/g)) {
              const s = t[1] !== undefined ? t[1] : t[2]
              const clean = s.replace(/\(([^)]*)\)/g, '$1').replace(/\\[()\\]/g, (x) => x.slice(1)).replace(/<[0-9a-fA-F\s]+>/g, ' ').replace(/[-\d.]+/g, ' ').replace(/\s+/g, ' ').trim()
              if (clean.length > 1) chunks.push(clean)
            }
          } catch (e) {}
          if (chunks.join('').length > cap2 * 2) break
        }
        const text = chunks.join(' ').slice(0, cap2)
        return {
          file: a.path,
          size: fmtBytes(st.size),
          streamsInflated: inflated,
          extractedChars: text.length,
          cjkChars: (text.match(/[\u4e00-\u9fff]/g) || []).length,
          text: text || null,
          note: text ? null : '没抽到文本：可能是扫描版图片 PDF（要 OCR）或字体子集用 CID 编码',
        }
      },
    },
    {
      name: 'media_audio_info',
      desc: '音频信息：WAV 头 / MP3 帧头 / ID3 标签，给时长与码率',
      params: { path: { type: 'string', required: true, desc: '音频路径' }, useFfprobe: { type: 'boolean', desc: '有 ffprobe 就用它，默认 true' } },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        if (!fs.existsSync(abs)) return json({ ok: false, message: `找不到文件: ${abs}` })
        const st = fs.statSync(abs)
        const buf = fs.readFileSync(abs).subarray(0, Math.min(st.size, 8 * 1024 * 1024))
        const base = { file: a.path, size: fmtBytes(st.size), kind: detectKind(buf) }
        const h = buf.subarray(0, 4).toString('latin1')
        const out = { ...base, format: h === 'RIFF' ? 'WAV' : buf.subarray(0, 3).toString('latin1') === 'ID3' ? 'MP3' : h === 'OggS' ? 'OGG' : h === 'fLaC' ? 'FLAC' : detectKind(buf) }
        if (h === 'RIFF') out.wav = decodeWav(buf)
        else if (buf.subarray(0, 3).toString('latin1') === 'ID3' || /^ff[fe]/.test(buf.subarray(0, 2).toString('hex'))) out.mp3 = decodeMp3(buf)
        if (a.useFfprobe !== false) {
          const p = await probeWith(ctx, abs, 30000)
          if (p.available) {
            out.ffprobe = p
            if (p.audio) out.durationSeconds = p.format && p.format.duration ? Number(p.format.duration) : out.durationSeconds
          }
        }
        return out
      },
    },
    {
      name: 'media_video_info',
      desc: '视频信息：MP4 box / MKV / WebM 结构 + ffprobe 编码与分辨率',
      params: { path: { type: 'string', required: true, desc: '视频路径' }, useFfprobe: { type: 'boolean', desc: '有 ffprobe 就用，默认 true' } },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        if (!fs.existsSync(abs)) return json({ ok: false, message: `找不到文件: ${abs}` })
        const st = fs.statSync(abs)
        const fd = await fs.promises.open(abs, 'r')
        const head = Buffer.alloc(Math.min(2 * 1024 * 1024, st.size))
        await fd.read(head, 0, head.length, 0)
        await fd.close()
        const out = { file: a.path, size: fmtBytes(st.size), kind: detectKind(head.subarray(0, 16)) }
        const h = head.subarray(0, 4).toString('hex')
        if (h === '1a45dfa3') out.container = 'Matroska/WebM'
        else if (head.subarray(4, 8).toString('latin1') === 'ftyp' || head.subarray(0, 4).toString('latin1') === 'ftyp') {
          out.container = 'MP4/MOV'
          out.mp4 = decodeMp4(head)
        } else if (head.subarray(0, 4).toString('latin1') === 'RIFF') out.container = 'AVI'
        if (a.useFfprobe !== false) {
          const p = await probeWith(ctx, abs, 40000)
          out.ffprobe = p.available ? p : { available: false, message: p.message }
        }
        return out
      },
    },
    {
      name: 'media_ffprobe',
      desc: '直接跑 ffprobe 拿完整 JSON（有 ffmpeg 才可用）',
      params: {
        path: { type: 'string', required: true, desc: '媒体文件路径' },
        show: { type: 'array', desc: '要 show 的部分，默认 format+streams', items: { type: 'string', desc: 'format|streams|packets|frames|chapters' } },
        timeoutMs: { type: 'integer', desc: '超时，默认 60000' },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        if (!fs.existsSync(abs)) return json({ ok: false, message: `找不到文件: ${abs}` })
        const show = Array.isArray(a.show) && a.show.length ? a.show : ['format', 'streams']
        const args = ['-v', 'error', '-print_format', 'json']
        for (const s of show) if (/^(format|streams|packets|frames|chapters)$/.test(s)) args.push(`-show_${s}`)
        args.push(abs)
        const r = await ctx.exec('ffprobe', args, { timeoutMs: clamp(int(a.timeoutMs, 60000), 5000, 300000) })
        if (r.code !== 0 && !String(r.stdout).trim()) return json({ ok: false, message: String(r.stderr).slice(0, 300) || 'ffprobe 不可用（装 ffmpeg 并放 PATH）' })
        try {
          return { file: a.path, data: JSON.parse(String(r.stdout)) }
        } catch (e) {
          return { file: a.path, raw: String(r.stdout).slice(0, 6000) }
        }
      },
    },
    {
      name: 'media_ffmpeg_run',
      desc: '跑 ffmpeg（转码/截帧/剪切），参数自己给，confirm 必传',
      write: true,
      params: {
        args: { type: 'array', required: true, desc: 'ffmpeg 参数数组，例如 ["-i","in.mp4","-ss","1","-frames:v","1","out.png"]', items: { type: 'string', desc: '一个参数' } },
        timeoutMs: { type: 'integer', desc: '超时，默认 120000' },
        confirm: { type: 'boolean', desc: '会写文件，传 true' },
      },
      async run(a, ctx) {
        if (a.confirm !== true) return json({ ok: false, message: 'ffmpeg 会写文件，传 confirm=true 确认（参数里给 -y 覆盖）' })
        const args = (a.args || []).map(String)
        const r = await ctx.exec('ffmpeg', args, { timeoutMs: clamp(int(a.timeoutMs, 120000), 3000, 900000) })
        const err = String(r.stderr)
        return { command: `ffmpeg ${args.join(' ')}`, code: r.code, timedOut: r.timedOut, outputLines: err.split(/\r?\n/).filter(Boolean).slice(-12), errors: (err.match(/Error|Invalid|No such|not found|Conversion failed/gi) || []).slice(0, 6) }
      },
    },
    {
      name: 'media_checksums',
      desc: '算文件校验和（md5/sha1/sha256/sha512），大文件流式',
      params: {
        path: { type: 'string', required: true, desc: '文件路径' },
        algos: { type: 'array', desc: '算法，默认 md5+sha256', items: { type: 'string', desc: 'md5|sha1|sha256|sha512' } },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        if (!fs.existsSync(abs)) return json({ ok: false, message: `找不到文件: ${abs}` })
        const st = fs.statSync(abs)
        if (st.isDirectory()) return json({ ok: false, message: '是目录' })
        const algos = (Array.isArray(a.algos) && a.algos.length ? a.algos : ['md5', 'sha256']).filter((x) => ['md5', 'sha1', 'sha256', 'sha512'].includes(String(x)))
        const hashes = algos.map((al) => crypto.createHash(al))
        const stream = fs.createReadStream(abs, { highWaterMark: 4 * 1024 * 1024 })
        for await (const chunk of stream) for (const h of hashes) h.update(chunk)
        return { file: a.path, size: fmtBytes(st.size), sizeBytes: st.size, hashes: Object.fromEntries(algos.map((al, i) => [al, hashes[i].digest('hex')])), base64sha256: algos.includes('sha256') ? crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('base64') : null }
      },
    },
    {
      name: 'media_bulk_scan',
      desc: '批量扫目录：按真实类型分类媒体文件，给大小排行与重复哈希',
      params: {
        path: { type: 'string', desc: '扫描根，默认工作区' },
        kinds: { type: 'array', desc: '只看这些类型关键词，例如 ["PNG","JPEG","PDF"]', items: { type: 'string', desc: '一个类型' } },
        maxFiles: { type: 'integer', desc: '最多扫几个，默认 5000' },
        maxDepth: { type: 'integer', desc: '最大层数，默认 6' },
        findDuplicates: { type: 'boolean', desc: '算哈希找重复，默认 true（慢）' },
        limit: { type: 'integer', desc: '每类最多列几个，默认 20' },
      },
      async run(a, ctx) {
        const root = ctx.resolve(a.path || '.')
        const files = walkFiles(root, { maxDepth: clamp(int(a.maxDepth, 6), 1, 12), maxFiles: clamp(int(a.maxFiles, 5000), 50, 100000), skip: /(^|[\\/])(\.git|node_modules)([\\/]|$)/ })
        const wanted = Array.isArray(a.kinds) && a.kinds.length ? a.kinds.map((k) => String(k).toUpperCase()) : null
        const byKind = {}
        const hashMap = new Map()
        const cap = clamp(int(a.limit, 20), 1, 2000)
        let scanned = 0
        for (const f of files) {
          try {
            const st = fs.statSync(f)
            if (st.size === 0) continue
            const fd = await fs.promises.open(f, 'r')
            const head = Buffer.alloc(Math.min(32, st.size))
            await fd.read(head, 0, head.length, 0)
            await fd.close()
            const kind = detectKind(head)
            if (wanted && !wanted.some((k) => kind.toUpperCase().includes(k))) continue
            const item = { file: path.relative(root, f).replace(/\\/g, '/'), size: st.size, kind }
            if (a.findDuplicates !== false && st.size > 1024) {
              const buf = fs.readFileSync(f)
              item.md5 = md5(buf)
              if (!hashMap.has(item.md5)) hashMap.set(item.md5, [])
              hashMap.get(item.md5).push(item.file)
            }
            const b = (byKind[kind] = byKind[kind] || { count: 0, bytes: 0, files: [] })
            b.count++
            b.bytes += st.size
            if (b.files.length < cap) b.files.push(item)
            scanned++
          } catch (e) {}
        }
        const dups = [...hashMap.entries()].filter(([, v]) => v.length > 1).sort((x, y) => y[1].length - x[1].length)
        return {
          root,
          scanned,
          kinds: Object.entries(byKind).sort((x, y) => y[1].bytes - x[1].bytes).slice(0, 25).map(([k, v]) => `${fmtBytes(v.bytes).padStart(10)} ${String(v.count).padStart(5)}  ${k}`),
          detail: Object.fromEntries(Object.entries(byKind).slice(0, 8).map(([k, v]) => [k, v.files.map((f) => `${fmtBytes(f.size).padStart(10)}  ${f.file}`)])),
          duplicates: dups.slice(0, 20).map(([h, v]) => `${h.slice(0, 12)} × ${v.length}  ${v.slice(0, 4).join(' | ')}`),
        }
      },
    },
    {
      name: 'media_svg_info',
      desc: 'SVG 结构：viewBox、path/text 数量、内嵌 base64、用到的字体',
      params: { path: { type: 'string', required: true, desc: 'SVG 路径' } },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        const text = await readStr(abs, 4000000)
        if (text === null) return json({ ok: false, message: `读不到文件: ${abs}` })
        return { file: a.path, size: fmtBytes(Buffer.byteLength(text)), ...decodeSvg(text) }
      },
    },
    {
      name: 'media_data_uri',
      desc: '文件转 data: URI（小图直接内嵌 HTML/Markdown）',
      params: {
        path: { type: 'string', required: true, desc: '文件路径' },
        maxBytes: { type: 'integer', desc: '超过多少字节拒绝，默认 524288', },
        markdown: { type: 'boolean', desc: '输出 Markdown 图片语法，默认 false', },
      },
      async run(a, ctx) {
        const abs = ctx.resolve(a.path)
        if (!fs.existsSync(abs)) return json({ ok: false, message: `找不到文件: ${abs}` })
        const st = fs.statSync(abs)
        const max = clamp(int(a.maxBytes, 524288), 1024, 8 * 1024 * 1024)
        if (st.size > max) return json({ ok: false, message: `文件 ${fmtBytes(st.size)} 超过上限 ${fmtBytes(max)}，传大点的 maxBytes` })
        const buf = fs.readFileSync(abs)
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', woff: 'font/woff', woff2: 'font/woff2', json: 'application/json' }[(path.extname(abs) || '').slice(1).toLowerCase()] || detectKind(buf.subarray(0, 16)).toLowerCase().replace(/\s.*/, '') || 'application/octet-stream'
        const uri = `data:${mime};base64,${buf.toString('base64')}`
        return { file: a.path, mime, size: fmtBytes(st.size), base64Chars: uri.length, dataUri: uri.slice(0, 4000), markdown: a.markdown ? `![${path.basename(abs)}](${uri.slice(0, 4000)})` : undefined, truncated: uri.length > 4000 }
      },
    },
    {
      name: 'media_ffmpeg_available',
      desc: '查 ffmpeg/ffprobe/ImageMagick 装没装、什么版本、有哪些编码器',
      params: { encoders: { type: 'array', desc: '要确认的编码器，例如 ["h264","libx265","nvenc"]', items: { type: 'string', desc: '一个编码器名' } } },
      async run(a, ctx) {
        const out = {}
        for (const [label, cmd, args] of [['ffmpeg', 'ffmpeg', ['-version']], ['ffprobe', 'ffprobe', ['-version']], ['magick', 'magick', ['-version']], ['convert', 'convert', ['-version']]]) {
          const r = await ctx.exec(cmd, args, { timeoutMs: 20000 })
          out[label] = r.code === 0 || String(r.stdout).trim() ? String(r.stdout).split(/\r?\n/)[0].slice(0, 160) : { missing: true }
        }
        if (Array.isArray(a.encoders) && a.encoders.length) {
          const r = await ctx.exec('ffmpeg', ['-hide_banner', '-encoders'], { timeoutMs: 30000 })
          const all = String(r.stdout)
          out.encoders = a.encoders.map((e) => ({ name: String(e), available: all.toLowerCase().includes(String(e).toLowerCase()) }))
        }
        const nvenc = await ctx.exec('ffmpeg', ['-hide_banner', '-encoders'], { timeoutMs: 30000 })
        out.nvenc = (String(nvenc.stdout).match(/nvenc|cuda|hevc_nvenc|h264_nvenc/gi) || []).length
        return out
      },
    },
  ],
}
