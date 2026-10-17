// GPU 与推理包：nvidia-smi 解析、GGUF 头解析、CUDA/llama.cpp 体检、显存与功耗采样。
// 没有 nvidia-smi / llama.cpp 的机器一律返回中文原因，不抛异常。
import fs from 'node:fs'
import path from 'node:path'
import { json, int, clamp, fmtBytes, fmtMs, walkFiles, readJsonSafe } from '../util.js'

async function smi(ctx, args, timeoutMs = 15000) {
  const r = await ctx.exec('nvidia-smi', args, { timeoutMs })
  if (r.code !== 0 && !String(r.stdout).trim()) {
    return { ok: false, message: `nvidia-smi 跑不起来（没驱动或不在 PATH）: ${String(r.stderr).split(/\r?\n/)[0] || '未知原因'}` }
  }
  return { ok: true, code: r.code, stdout: String(r.stdout), stderr: String(r.stderr) }
}

function csvRows(text, cols) {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split(',').map((s) => s.trim())
    if (parts.length < cols.length) continue
    const o = {}
    cols.forEach((c, i) => {
      o[c] = parts[i]
    })
    out.push(o)
  }
  return out
}

function num(v) {
  const m = String(v === undefined ? '' : v).match(/-?[\d.]+/)
  return m ? Number(m[0]) : null
}

export default {
  id: 'nvidia',
  title: 'GPU 与推理',
  tags: ['nvidia', 'gpu', 'cuda', 'llama', 'gguf', 'inference'],
  summary: 'nvidia-smi 全量查询、显存/温度/功耗/进程、GGUF 头解析、CUDA 与 llama.cpp 体检、GPU 体检报告',
  tools: [
    {
      name: 'nvidia_gpu_list',
      desc: 'GPU 清单：型号/驱动/显存总量/计算能力/序列号',
      params: {},
      async run(_a, ctx) {
        const cols = ['index', 'name', 'driver_version', 'memory.total', 'memory.used', 'compute_cap', 'serial']
        const r = await smi(ctx, ['--query-gpu=' + cols.join(','), '--format=csv,noheader,nounits'])
        if (!r.ok) return r
        const rows = csvRows(r.stdout, cols)
        if (!rows.length) return json({ ok: false, message: 'nvidia-smi 没返回 GPU 信息', raw: r.stdout.slice(0, 300) })
        return rows.map((g) => ({
          index: g.index,
          name: g.name,
          driver: g.driver_version,
          memoryTotal: g['memory.total'] ? `${g['memory.total']} MiB` : null,
          memoryUsed: g['memory.used'] ? `${g['memory.used']} MiB` : null,
          computeCapability: g.compute_cap,
          serial: g.serial && g.serial !== 'N/A' ? g.serial : null,
        }))
      },
    },
    {
      name: 'nvidia_memory',
      desc: '各卡显存占用/剩余/利用率（含占比）',
      params: {},
      async run(_a, ctx) {
        const cols = ['index', 'name', 'memory.total', 'memory.used', 'memory.free', 'utilization.gpu', 'utilization.memory']
        const r = await smi(ctx, ['--query-gpu=' + cols.join(','), '--format=csv,noheader,nounits'])
        if (!r.ok) return r
        return csvRows(r.stdout, cols).map((g) => {
          const total = num(g['memory.total'])
          const used = num(g['memory.used'])
          return {
            index: g.index,
            name: g.name,
            totalMiB: total,
            usedMiB: used,
            freeMiB: num(g['memory.free']),
            usedPercent: total ? Number((100 * used / total).toFixed(1)) : null,
            gpuUtilPercent: num(g['utilization.gpu']),
            memUtilPercent: num(g['utilization.memory']),
          }
        })
      },
    },
    {
      name: 'nvidia_thermal_power',
      desc: '温度、功耗、功耗上限、风扇、性能状态',
      params: {},
      async run(_a, ctx) {
        const cols = ['index', 'name', 'temperature.gpu', 'temperature.memory', 'power.draw', 'power.limit', 'power.default_limit', 'fan.speed', 'pstate', 'clocks_throttle_reasons.active']
        const r = await smi(ctx, ['--query-gpu=' + cols.join(','), '--format=csv,noheader,nounits'])
        if (!r.ok) return r
        return csvRows(r.stdout, cols).map((g) => ({
          index: g.index,
          name: g.name,
          tempGpuC: num(g['temperature.gpu']),
          tempMemC: g['temperature.memory'] && g['temperature.memory'] !== 'N/A' ? num(g['temperature.memory']) : null,
          powerDrawW: num(g['power.draw']),
          powerLimitW: num(g['power.limit']),
          defaultLimitW: num(g['power.default_limit']),
          fanPercent: g['fan.speed'] && g['fan.speed'] !== 'N/A' ? num(g['fan.speed']) : null,
          pstate: g.pstate,
          throttling: g['clocks_throttle_reasons.active'],
        }))
      },
    },
    {
      name: 'nvidia_processes',
      desc: 'GPU 上正在跑的进程（pid/名字/显存占用）',
      params: { minMiB: { type: 'integer', desc: '只显示占用超过这个值的，默认 0' } },
      async run(a, ctx) {
        const r = await smi(ctx, ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'])
        if (!r.ok) return r
        const min = int(a.minMiB, 0)
        const rows = csvRows(r.stdout, ['pid', 'process_name', 'used_memory'])
          .filter((p) => (num(p.used_memory) || 0) >= min)
          .map((p) => ({ pid: p.pid, name: p.process_name, usedMiB: num(p.used_memory) }))
        return rows.length ? rows : { note: 'GPU 上没有计算进程' }
      },
    },
    {
      name: 'nvidia_clocks',
      desc: '核心/显存频率与最大频率、时钟上限',
      params: {},
      async run(_a, ctx) {
        const cols = ['index', 'name', 'clocks.current.graphics', 'clocks.max.graphics', 'clocks.current.memory', 'clocks.max.memory', 'clocks.current.sm', 'applications_clocks.graphics', 'applications_clocks.memory']
        const r = await smi(ctx, ['--query-gpu=' + cols.join(','), '--format=csv,noheader,nounits'])
        if (!r.ok) return r
        return csvRows(r.stdout, cols).map((g) => ({
          index: g.index,
          name: g.name,
          graphicsMHz: num(g['clocks.current.graphics']),
          graphicsMaxMHz: num(g['clocks.max.graphics']),
          memoryMHz: num(g['clocks.current.memory']),
          memoryMaxMHz: num(g['clocks.max.memory']),
          smMHz: g['clocks.current.sm'] && g['clocks.current.sm'] !== 'N/A' ? num(g['clocks.current.sm']) : null,
          appGraphicsMHz: g['applications_clocks.graphics'] && g['applications_clocks.graphics'] !== 'N/A' ? num(g['applications_clocks.graphics']) : null,
        }))
      },
    },
    {
      name: 'nvidia_topology',
      desc: '卡间互联拓扑（NVLink/PCIe 类型矩阵）与 P2P 状态',
      params: {},
      async run(_a, ctx) {
        const r = await smi(ctx, ['topo', '-m'], { timeoutMs: 25000 })
        if (!r.ok) return r
        const lines = String(r.stdout).split(/\r?\n/).filter((l) => l.trim())
        const link = lines.find((l) => /GPU NUMA|Legend/i.test(l))
        const p2p = await smi(ctx, ['--query-gpu=index,name,topology.gpu_id', '--format=csv,noheader'], { timeoutMs: 15000 })
        return {
          matrix: lines.slice(0, 20).map((l) => l.replace(/\s+/g, ' ').slice(0, 160)),
          legend: link || null,
          note: 'PIX=同 PCIe 桥，PXB=同 PCIe 开关，PHB=同宿主桥，SYS=跨 CPU 走内存，NV#=NVLink',
        }
      },
    },
    {
      name: 'nvidia_modes',
      desc: '计算模式、持久化模式、ECC、虚拟模式查询',
      params: {},
      async run(_a, ctx) {
        const cols = ['index', 'name', 'driver_model.current', 'driver_model.persistent', 'compute_mode', 'ecc_mode.default', 'virtualization_mode.host']
        const r = await smi(ctx, ['--query-gpu=' + cols.join(','), '--format=csv,noheader'])
        if (!r.ok) return r
        return csvRows(r.stdout, cols).map((g) => ({
          index: g.index,
          name: g.name,
          persistenceMode: g['driver_model.persistent'] || g['driver_model.current'],
          computeMode: g.compute_mode,
          eccDefault: g['ecc_mode.default'],
          virtualMode: g['virtualization_mode.host'],
        }))
      },
    },
    {
      name: 'nvidia_driver_info',
      desc: '驱动版本、CUDA 版本、NVML 版本、VBIOS',
      params: {},
      async run(_a, ctx) {
        const cols = ['index', 'name', 'driver_version', 'driver_model.current', 'vbios_version', 'gpu_bus_id', 'gpu_uuid']
        const r = await smi(ctx, ['--query-gpu=' + cols.join(','), '--format=csv,noheader'])
        if (!r.ok) return r
        const gpus = csvRows(r.stdout, cols)
        const nvsmi = await smi(ctx, ['--version'])
        const cuda = String(nvsmi.stdout).match(/CUDA Version:\s*([\d.]+)/)
        return {
          cudaVersion: cuda ? cuda[1] : null,
          nvsmiVersion: String(nvsmi.stdout).split(/\r?\n/)[0] || null,
          gpus: gpus.map((g) => ({ index: g.index, name: g.name, driver: g.driver_version, vbios: g.vbios_version, busId: g.gpu_bus_id, uuid: g.gpu_uuid })),
        }
      },
    },
    {
      name: 'nvidia_raw',
      desc: '直接跑 nvidia-smi 任意参数（默认 -q -d 常用子集），返回原文',
      params: {
        args: { type: 'array', desc: '参数数组，例如 ["-q","-d","POWER"]；不传给 -lgc 之外的常用概览', items: { type: 'string', desc: '一个参数' } },
        timeoutMs: { type: 'integer', desc: '超时，默认 20000' },
      },
      async run(a, ctx) {
        const args = Array.isArray(a.args) && a.args.length ? a.args : ['-q', '-d', 'POWER,TEMPERATURE,CLOCK,ECC']
        const r = await smi(ctx, args, clamp(int(a.timeoutMs, 20000), 3000, 120000))
        if (!r.ok) return r
        return r.stdout.slice(0, 20000)
      },
    },
    {
      name: 'nvidia_dmon',
      desc: '连续采样几轮（利用率/功耗/温度/显存），返回时间序列表格',
      params: {
        rounds: { type: 'integer', desc: '采几轮，默认 5，最多 30' },
        seconds: { type: 'integer', desc: '每轮间隔秒，默认 1' },
        fields: { type: 'string', desc: 'dmon -s 字段，默认 upctm（利用率/功耗/温度/风扇/功耗上限/显存）' },
      },
      async run(a, ctx) {
        const rounds = clamp(int(a.rounds, 5), 1, 30)
        const seconds = clamp(int(a.seconds, 1), 1, 10)
        const r = await smi(ctx, ['dmon', '-c', String(rounds), '-d', String(seconds), '-s', String(a.fields || 'upctm')], { timeoutMs: rounds * seconds * 1000 + 15000 })
        if (!r.ok) return r
        const lines = String(r.stdout).split(/\r?\n/).filter((l) => l.trim())
        const header = lines.find((l) => /^#?\s*[gG]pu/.test(l)) || lines[0]
        const rows = lines.filter((l) => /^\s*\d/.test(l)).map((l) => l.replace(/\s+/g, ' ').trim())
        return { header: header ? header.replace(/^#\s*/, '') : null, samples: rows.length, rows: rows.slice(0, 200) }
      },
    },
    {
      name: 'nvidia_env_check',
      desc: 'CUDA/cuDNN 环境变量与库路径检查（LD_LIBRARY_PATH、PATH 里的 cuda/cudnn 目录）',
      params: {},
      async run(_a, ctx) {
        const fs2 = await import('node:fs')
        const path2 = await import('node:path')
        const envKeys = ['CUDA_VISIBLE_DEVICES', 'CUDA_HOME', 'CUDA_PATH', 'CUDA_MODULE_LOADING', 'CUDA_DEVICE_MAX_CONNECTIONS', 'CUPTI_LIBRARY_DIRECTORY', 'CUDNN_PATH', 'LD_LIBRARY_PATH', 'OVERCOMMIT', 'PYTORCH_CUDA_ALLOC_CONF', 'LLAMA_ARG_MAIN_GPU', 'NO_CUDA', 'GGML_CUDA']
        const env = {}
        for (const k of envKeys) if (process.env[k] !== undefined) env[k] = String(process.env[k]).slice(0, 300)
        const dirs = String(process.env.PATH || process.env.Path || '').split(path2.delimiter).filter(Boolean)
        const cudaDirs = []
        for (const d of dirs) {
          if (!/cuda|cudnn|nvidia/i.test(d)) continue
          try {
            const st = fs2.statSync(d)
            if (st.isDirectory()) cudaDirs.push(d)
          } catch (e) {}
        }
        const libs = []
        for (const base of ['/usr/local/cuda/lib64', '/usr/lib/x86_64-linux-gnu', '/usr/local/cuda/extras/CUPTI/lib64']) {
          try {
            for (const f of fs2.readdirSync(base)) if (/^libcudnn|^libcudart|^libcuda\./.test(f)) libs.push(`${base}/${f}`)
          } catch (e) {}
        }
        return { env, cudaPathDirs: cudaDirs, foundLibraries: libs.slice(0, 40), cudaVisibleDevices: process.env.CUDA_VISIBLE_DEVICES || null }
      },
    },
    {
      name: 'nvidia_cpu_caps',
      desc: 'CPU 指令集（AVX2/AVX512 有无）、核心线程、总内存、NUMA 节点',
      params: {},
      async run(_a, ctx) {
        const os = await import('node:os')
        const fs2 = await import('node:fs')
        const out = { cpuModel: '', flags: {}, cores: os.cpus().length, sockets: null, totalMemory: fmtBytes(os.totalmem()), numaNodes: [], avx2: null, avx512: null }
        if (process.platform === 'linux') {
          try {
            const info = fs2.readFileSync('/proc/cpuinfo', 'utf8')
            const m = info.match(/model name\s*:\s*(.+)/)
            out.cpuModel = m ? m[1].trim() : ''
            const fm = info.match(/flags\s*:\s*(.+)/)
            const flags = fm ? fm[1].trim().split(/\s+/) : []
            for (const f of ['avx', 'avx2', 'avx512f', 'avx512_vnni', 'fma', 'f16c', 'bmi2', 'amx_tile']) out.flags[f] = flags.includes(f)
            out.avx2 = out.flags.avx2
            out.avx512 = out.flags.avx512f
            const phys = new Set()
            for (const blk of info.split('\n\n')) {
              const id = blk.match(/core id\s*:\s*(\d+)/)
              const sk = blk.match(/physical id\s*:\s*(\d+)/)
              if (id) phys.add(`${sk ? sk[1] : '0'}:${id[1]}`)
            }
            out.physicalCores = phys.size
            try {
              out.numaNodes = fs2.readdirSync('/sys/devices/system/node').filter((n) => /^node\d+$/.test(n))
            } catch (e) {}
          } catch (e) {
            out.note = '读不到 /proc/cpuinfo'
          }
        } else {
          const r = await ctx.exec('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,Manufacturer | Format-List | Out-String'], { timeoutMs: 25000 })
          const txt = String(r.stdout)
          const m = txt.match(/Name\s*:\s*(.+)/)
          out.cpuModel = m ? m[1].trim() : ''
          const c = txt.match(/NumberOfCores\s*:\s*(\d+)/)
          out.physicalCores = c ? Number(c[1]) : null
          const avx = await ctx.exec('powershell', ['-NoProfile', '-Command', '(Add-Type -MemberDefinition "[DllImport(\"kernel32.dll\")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name K -Namespace N -PassThr; [N.K]::IsProcessorFeaturePresent(40); [N.K]::IsProcessorFeaturePresent(41)'], { timeoutMs: 25000 })
          const t2 = String(avx.stdout)
          out.avx2 = /\bTrue\b/.test(t2.split(/\r?\n/).filter((l) => /True|False/.test(l))[0] || '')
          out.avx512 = false
          out.note = 'Windows 下指令集检测为尽力而为（40=AVX2, 93=AVX512 不在范围）'
        }
        out.recommendation = out.avx512 ? '有 AVX-512：llama.cpp 可开 -march=native 与 AVX512 内核' : out.avx2 ? '仅 AVX2：llama.cpp 用 -march=x86-64-v3 / AVX2 内核，别指望 AVX512' : '无 AVX2：只能用 SSE4，量化内核受限'
        return out
      },
    },
    {
      name: 'nvidia_pcie_link',
      desc: 'GPU 的 PCIe 总线、协商速率与宽度（Linux lspci / Windows 尽力）',
      params: {},
      async run(_a, ctx) {
        const bus = await smi(ctx, ['--query-gpu=index,name,gpu_bus_id', '--format=csv,noheader'])
        if (!bus.ok) return bus
        const gpus = csvRows(bus.stdout, ['index', 'name', 'gpu_bus_id'])
        if (process.platform === 'linux') {
          const out = []
          for (const g of gpus) {
            const id = String(g.gpu_bus_id).toLowerCase()
            const r = await ctx.exec('lspci', ['-vvv', '-s', id])
            const txt = String(r.stdout)
            const speed = txt.match(/LnkSta:\s*Speed\s+([\d.]+GT\/s),\s*Width\s+x(\d+)/)
            const cap = txt.match(/LnkCap:\s*Speed\s+([\d.]+GT\/s),\s*Width\s+x(\d+)/)
            out.push({
              index: g.index,
              name: g.name,
              busId: id,
              negotiated: speed ? `${speed[1]} x${speed[2]}` : null,
              capability: cap ? `${cap[1]} x${cap[2]}` : null,
              degraded: speed && cap && (speed[1] !== cap[1] || speed[2] !== cap[2]),
            })
          }
          return out
        }
        const r = await ctx.exec('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM,PNPDeviceID | Format-List | Out-String'], { timeoutMs: 25000 })
        return { note: 'Windows 下 PCIe 协商速率需管理员权限，这里给设备标识', gpus, videoControllers: String(r.stdout).split(/\r?\n/).filter((l) => l.trim()).slice(0, 40) }
      },
    },
    {
      name: 'nvidia_numa_advice',
      desc: '读 NUMA 拓扑，给出双卡绑核与亲和建议',
      params: {},
      async run(_a, ctx) {
        const r = await smi(ctx, ['topo', '--numa'], { timeoutMs: 25000 })
        if (!r.ok) return r
        const lines = String(r.stdout).split(/\r?\n/).filter((l) => l.trim()).slice(0, 25)
        const cpu = await ctx.exec('lscpu', ['--extended'])
        const sockets = String(cpu.stdout).split(/\r?\n/).filter((l) => /^\s*\d+\s+\d/.test(l))
        return {
          numaMatrix: lines.map((l) => l.replace(/\s+/g, ' ').slice(0, 160)),
          cpuNumaMap: sockets.slice(0, 20),
          advice: [
            '两张卡若在同一 NUMA 节点：推理进程 taskset -c 绑该节点核，跨节点访问内存会掉带宽',
            'E5-2696 v4（双路 36C/72T，仅 AVX2）：llama.cpp 用 -march=x86-64-v3，GPU 侧 --n-gpu-layers 尽量拉满 16G 显存',
            '双卡 P100（Pascal，无 NVLink 于 PCIe 版）：张量并行按卡切分，避免跨卡 P2P 走 SYS',
          ],
        }
      },
    },
    {
      name: 'nvidia_gguf_info',
      desc: '解析 GGUF 文件头：版本、张量数、量化类型、词表、上下文、元数据',
      params: {
        path: { type: 'string', required: true, desc: '.gguf 文件路径' },
        maxKeys: { type: 'integer', desc: '最多返回多少个元数据键，默认 60' },
      },
      async run(a, ctx) {
        const fs2 = await import('node:fs')
        const abs = ctx.resolve(a.path)
        const fd = fs2.openSync(abs, 'r')
        try {
          const head = Buffer.alloc(24)
          fs2.readSync(fd, head, 0, 24, 0)
          if (head.toString('latin1', 0, 4) !== 'GGUF') return json({ ok: false, message: '不是 GGUF 文件（魔数不匹配）', path: abs })
          const version = head.readUInt32LE(4)
          const tensors = Number(head.readBigUInt64LE(8))
          const kvCount = Number(head.readBigUInt64LE(16))
          let pos = 24
          const types = { 0: 'string', 1: 'u32', 2: 'i32', 3: 'f32', 4: 'bool', 5: 'string[]', 6: 'u8', 7: 'i8', 8: 'u16', 9: 'i16', 10: 'u64', 11: 'i64', 12: 'f64', 13: 'array' }
          const readStr = () => {
            const len = Number(fs2.readSync(fd, Buffer.alloc(8), 0, 8, pos) === 8 ? (() => {
              const b = Buffer.alloc(8)
              fs2.readSync(fd, b, 0, 8, pos)
              return b.readBigUInt64LE(0)
            })() : 0)
            pos += 8
            const buf = Buffer.alloc(Math.min(len, 1 << 20))
            fs2.readSync(fd, buf, 0, buf.length, pos)
            pos += buf.length
            return buf.toString('utf8')
          }
          const skip = (t) => {
            if (t === 0) {
              const len = Number((() => {
                const b = Buffer.alloc(8)
                fs2.readSync(fd, b, 0, 8, pos)
                return b.readBigUInt64LE(0)
              })())
              pos += 8 + len
            } else if (t === 5) {
              const et = fs2.readSync(fd, Buffer.alloc(4), 0, 4, pos)
              const b = Buffer.alloc(4)
              fs2.readSync(fd, b, 0, 4, pos)
              const elemType = b.readUInt32LE(0)
              pos += 4
              const cnt = Number((() => {
                const bb = Buffer.alloc(8)
                fs2.readSync(fd, bb, 0, 8, pos)
                return bb.readBigUInt64LE(0)
              })())
              pos += 8
              const sizeOf = { 0: 'str', 1: 4, 2: 4, 3: 4, 4: 1, 6: 1, 7: 1, 8: 2, 9: 2, 10: 8, 11: 8, 12: 8 }
              if (elemType === 0) {
                for (let i = 0; i < cnt; i++) {
                  const bb = Buffer.alloc(8)
                  fs2.readSync(fd, bb, 0, 8, pos)
                  pos += 8 + Number(bb.readBigUInt64LE(0))
                }
              } else pos += cnt * (sizeOf[elemType] || 4)
            } else {
              const sizeOf = { 1: 4, 2: 4, 3: 4, 4: 1, 6: 1, 7: 1, 8: 2, 9: 2, 10: 8, 11: 8, 12: 8 }
              pos += sizeOf[t] || 4
            }
          }
          const meta = {}
          const want = clamp(int(a.maxKeys, 60), 1, 500)
          for (let i = 0; i < kvCount && Object.keys(meta).length < want; i++) {
            if (pos > 40 * 1024 * 1024) break
            const key = readStr()
            const tb = Buffer.alloc(4)
            fs2.readSync(fd, tb, 0, 4, pos)
            pos += 4
            const t = tb.readUInt32LE(0)
            if (t === 0) meta[key] = readStr()
            else if (t === 4) {
              const b = Buffer.alloc(1)
              fs2.readSync(fd, b, 0, 1, pos)
              pos += 1
              meta[key] = b.readUInt8(0) === 1
            } else if (t === 1 || t === 2 || t === 3) {
              const b = Buffer.alloc(4)
              fs2.readSync(fd, b, 0, 4, pos)
              pos += 4
              meta[key] = t === 3 ? Number(b.readFloatLE(0).toFixed(4)) : b.readUInt32LE(0)
            } else if (t === 10 || t === 11) {
              const b = Buffer.alloc(8)
              fs2.readSync(fd, b, 0, 8, pos)
              pos += 8
              meta[key] = Number(b.readBigUInt64LE(0))
            } else if (t === 12) {
              const b = Buffer.alloc(8)
              fs2.readSync(fd, b, 0, 8, pos)
              pos += 8
              meta[key] = Number(b.readDoubleLE(0))
            } else if (t === 8 || t === 9) {
              const b = Buffer.alloc(2)
              fs2.readSync(fd, b, 0, 2, pos)
              pos += 2
              meta[key] = b.readUInt16LE(0)
            } else if (t === 6 || t === 7) {
              const b = Buffer.alloc(1)
              fs2.readSync(fd, b, 0, 1, pos)
              pos += 1
              meta[key] = b.readUInt8(0)
            } else if (t === 5) {
              const b = Buffer.alloc(4)
              fs2.readSync(fd, b, 0, 4, pos)
              const elemType = b.readUInt32LE(0)
              pos += 4
              const cnt = Number((() => {
                const bb = Buffer.alloc(8)
                fs2.readSync(fd, bb, 0, 8, pos)
                return bb.readBigUInt64LE(0)
              })())
              pos += 8
              if (elemType === 0 && cnt <= 20) {
                const arr = []
                for (let k = 0; k < cnt; k++) arr.push(readStr())
                meta[key] = arr
              } else {
                meta[key] = `[${types[elemType] || '?'} x${cnt}]`
                const sizeOf = { 1: 4, 2: 4, 3: 4, 4: 1, 6: 1, 7: 1, 8: 2, 9: 2, 10: 8, 11: 8, 12: 8 }
                pos += cnt * (sizeOf[elemType] || 4)
              }
            } else skip(t)
          }
          const st = fs2.fstatSync(fd)
          return {
            path: abs,
            fileSize: fmtBytes(st.size),
            ggufVersion: version,
            tensorCount: tensors,
            kvCount,
            architecture: meta['general.architecture'],
            name: meta['general.name'],
            quantizationType: meta['general.file_type'],
            vocabSize: meta[`${meta['general.architecture'] || 'llama'}.vocab_size`],
            contextLength: meta[`${meta['general.architecture'] || 'llama'}.context_length`],
            blockCount: meta[`${meta['general.architecture'] || 'llama'}.block_count`],
            embeddingLength: meta[`${meta['general.architecture'] || 'llama'}.embedding_length`],
            attentionHeadCount: meta[`${meta['general.architecture'] || 'llama'}.attention.head_count`],
            fileSizeField: meta['general.file_size'],
            metadata: meta,
          }
        } finally {
          fs2.closeSync(fd)
        }
      },
    },
    {
      name: 'nvidia_model_inventory',
      desc: '扫工作区（或指定目录）的 gguf/safetensors/bin/onnx，按大小与量化类型排布',
      params: {
        path: { type: 'string', desc: '扫描根，默认会话工作区' },
        depth: { type: 'integer', desc: '最大层数，默认 4' },
        limit: { type: 'integer', desc: '最多几个文件，默认 60' },
        parseGguf: { type: 'boolean', desc: '顺手解析 GGUF 量化类型，默认 true' },
      },
      async run(a, ctx) {
        const root = ctx.resolve(a.path || '.')
        const files = walkFiles(root, { maxDepth: clamp(int(a.depth, 4), 1, 10), maxFiles: 20000 }).filter((f) => /\.(gguf|safetensors|onnx|bin|pt|ggml|ckpt)$/i.test(f))
        const cap = clamp(int(a.limit, 60), 1, 2000)
        const rows = []
        let total = 0
        for (const f of files) {
          const st = await fs.promises.stat(f)
          total += st.size
          const row = { path: path.relative(root, f), size: fmtBytes(st.size), bytes: st.size, mtime: st.mtimeMs }
          if (a.parseGguf !== false && /\.gguf$/i.test(f) && st.size > 32) {
            try {
              const fd = fs.openSync(f, 'r')
              const b = Buffer.alloc(32)
              fs.readSync(fd, b, 0, 32, 0)
              fs.closeSync(fd)
              row.ggufVersion = b.readUInt32LE(4)
              row.tensors = Number(b.readBigUInt64LE(8))
            } catch (e) {}
          }
          rows.push(row)
        }
        rows.sort((x, y) => y.bytes - x.bytes)
        const byExt = {}
        for (const r of rows) {
          const ext = path.extname(r.path).toLowerCase()
          byExt[ext] = (byExt[ext] || 0) + 1
        }
        return { root, totalFiles: rows.length, totalSize: fmtBytes(total), byExtension: byExt, top: rows.slice(0, cap).map((r) => `${r.size.padStart(9)}  tensors=${r.tensors || '-'}  ${r.path}`) }
      },
    },
    {
      name: 'nvidia_llama_scan',
      desc: '找 llama.cpp 构建产物与可执行文件（llama-cli/llama-server/build 目录）',
      params: {
        path: { type: 'string', desc: '扫描根，默认会话工作区' },
        depth: { type: 'integer', desc: '最大层数，默认 5' },
      },
      async run(a, ctx) {
        const root = ctx.resolve(a.path || '.')
        const wanted = /^llama[-_][\w.-]+$/i
        const found = []
        const dirs = []
        const stack = [[root, 0]]
        const maxDepth = clamp(int(a.depth, 5), 1, 10)
        while (stack.length) {
          const [dir, depth] = stack.pop()
          if (depth > maxDepth || found.length > 200) continue
          let ents
          try {
            ents = await fs.promises.readdir(dir, { withFileTypes: true })
          } catch (e) {
            continue
          }
          for (const e of ents) {
            const full = path.join(dir, e.name)
            if (e.isDirectory()) {
              if (/^(\.git|node_modules)$/.test(e.name)) continue
              if (/^(build|build-cuda|build-cu12|build-release|examples|tools)$/i.test(e.name)) dirs.push(path.relative(root, full) || '.')
              stack.push([full, depth + 1])
            } else if (wanted.test(e.name.replace(/\.(exe|dll|so|dylib)$/i, ''))) {
              try {
                const st = await fs.promises.stat(full)
                found.push({ path: path.relative(root, full), size: fmtBytes(st.size) })
              } catch (err) {}
            }
          }
        }
        const which = []
        for (const cmd of ['llama-cli', 'llama-server', 'llama-bench', 'llama-quantize', 'llama-perplexity']) {
          const r = process.platform === 'win32' ? await ctx.exec('where', [cmd]) : await ctx.exec('sh', ['-c', `command -v ${cmd}`])
          if (r.code === 0) which.push({ cmd, path: String(r.stdout).split(/\r?\n/)[0].trim() })
        }
        return { root, executables: found.slice(0, 60), buildDirs: dirs.slice(0, 30), onPath: which, note: which.length ? 'PATH 上已有 llama.cpp 工具，可直接 nvidia_llama_bench' : 'PATH 上没有，用 build 目录里的绝对路径' }
      },
    },
    {
      name: 'nvidia_llama_bench',
      desc: '跑 llama-bench（或任意 llama 可执行）解析 tok/s',
      write: true,
      params: {
        binary: { type: 'string', desc: '可执行文件路径或名字，默认 llama-bench' },
        model: { type: 'string', desc: '-m 模型路径' },
        extraArgs: { type: 'array', desc: '额外参数，例如 ["-ngl","99","-pg","512,1024"]', items: { type: 'string', desc: '一个参数' } },
        timeoutMs: { type: 'integer', desc: '超时，默认 180000' },
      },
      async run(a, ctx) {
        const args = []
        if (a.model) args.push('-m', ctx.resolve(a.model))
        if (Array.isArray(a.extraArgs)) args.push(...a.extraArgs.map(String))
        const r = await ctx.exec(a.binary || 'llama-bench', args, { timeoutMs: clamp(int(a.timeoutMs, 180000), 5000, 900000) })
        if (r.timedOut) return json({ ok: false, code: 'timeout', message: `跑满 ${a.timeoutMs || 180000}ms 被掐掉`, partial: String(r.stdout).slice(-2000) })
        const txt = String(r.stdout)
        const rows = txt.split(/\r?\n/).filter((l) => /\|\s*llama/.test(l) || /^\|\s*\d+\s*\|/.test(l))
        const tps = [...txt.matchAll(/([\d.]+)\s*\+\/-/g).map((m) => Number(m[1]))]
        return {
          command: [a.binary || 'llama-bench', ...args].join(' '),
          code: r.code,
          table: rows.slice(0, 30),
          parsedTokPerSec: tps.length ? tps : null,
          stderr: String(r.stderr).split(/\r?\n/).filter((l) => /error|Error|CUDA|GGML/.test(l)).slice(0, 15),
        }
      },
    },
    {
      name: 'nvidia_service_health',
      desc: '探本地推理服务健康（/health /v1/models /status，端口列表可给）',
      params: {
        ports: { type: 'array', desc: '要探的端口，默认 [8080,8000,1234,8081,3000]', items: { type: 'string', desc: '端口' } },
        host: { type: 'string', desc: '主机，默认 127.0.0.1' },
        timeoutMs: { type: 'integer', desc: '单端口超时，默认 3000' },
      },
      async run(a, ctx) {
        const host = a.host || '127.0.0.1'
        const ports = (Array.isArray(a.ports) && a.ports.length ? a.ports : ['8080', '8000', '1234', '8081', '3000']).map(String)
        const paths = ['/health', '/v1/models', '/healthz', '/status']
        const out = []
        for (const port of ports) {
          for (const p of paths) {
            try {
              const res = await ctx.fetch(`http://${host}:${port}${p}`, { timeoutMs: clamp(int(a.timeoutMs, 3000), 500, 20000), method: 'GET' })
              const text = await res.text()
              out.push({ host, port, path: p, status: res.status, ok: res.ok, body: text.slice(0, 300) })
              break
            } catch (e) {
              if (p === '/health') out.push({ host, port, path: p, status: null, ok: false, reason: String(e && e.cause && e.cause.code || e && e.message).slice(0, 80) })
            }
          }
        }
        return { probed: out.length, alive: out.filter((r) => r.ok), all: out }
      },
    },
    {
      name: 'nvidia_gpu_report',
      desc: '一页 GPU 体检报告：卡/驱动/显存/温度功耗/进程/CPU 指令集/PCIe',
      params: { includeProcesses: { type: 'boolean', desc: '带上 GPU 进程列表，默认 true' } },
      async run(a, ctx) {
        const cols = ['index', 'name', 'driver_version', 'cuda_version', 'memory.total', 'memory.used', 'temperature.gpu', 'power.draw', 'power.limit', 'utilization.gpu', 'compute_cap', 'pstate', 'fan.speed']
        const r = await smi(ctx, ['--query-gpu=' + cols.join(','), '--format=csv,noheader,nounits'])
        if (!r.ok) return r
        const gpus = csvRows(r.stdout, cols).map((g) => ({
          index: g.index,
          name: g.name,
          driver: g.driver_version,
          cuda: g.cuda_version,
          memory: `${g['memory.used']} / ${g['memory.total']} MiB`,
          tempC: g['temperature.gpu'],
          power: `${g['power.draw']} / ${g['power.limit']} W`,
          util: `${g['utilization.gpu']}%`,
          computeCap: g.compute_cap,
          pstate: g.pstate,
        }))
        const cpu = await ctx.exec('lscpu', [], { timeoutMs: 15000 })
        const cpuLines = String(cpu.stdout).split(/\r?\n/).filter((l) => /Model name|Socket|Core|Thread|Flags|NUMA|MHz/i.test(l)).map((l) => l.replace(/\s+/g, ' ').slice(0, 200))
        const procs = a.includeProcesses === false ? null : await smi(ctx, ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'])
        const flags = (cpuLines.find((l) => /Flags/i.test(l)) || '').split(' ')
        return {
          gpus,
          cpu: cpuLines.filter((l) => !/Flags/i.test(l)).slice(0, 10),
          cpuFlagsOfInterest: { avx2: flags.includes('avx2'), avx512f: flags.includes('avx512f'), fma: flags.includes('fma'), f16c: flags.includes('f16c') },
          gpuProcesses: procs && procs.ok ? String(procs.stdout).split(/\r?\n/).filter(Boolean).slice(0, 20) : procs && procs.message ? procs.message : [],
          notes: [
            'P100（Pascal，compute 6.0）：无 FP8/无 TMA，llama.cpp 用 Q4_K_M/Q5_K_M 最稳，Flash Attention 支持有限',
            '仅 AVX2：CPU 侧量化内核走 x86-64-v3，别开 AVX512 相关 flag',
            '双卡：--tensor-parallel 或 --split-mode layer 按卡切分，注意 PCIe 版无 NVLink',
          ],
        }
      },
    },
    {
      name: 'nvidia_smi_watch',
      desc: '按阈值盯几轮显存/温度/功耗，超阈值就报警（用于跑模型时看有没有爆）',
      params: {
        rounds: { type: 'integer', desc: '盯几轮，默认 5' },
        seconds: { type: 'integer', desc: '每轮间隔秒，默认 2' },
        maxTempC: { type: 'integer', desc: '温度报警阈值，默认 90' },
        maxMiB: { type: 'integer', desc: '剩余显存低于这个值报警（MiB），默认 512' },
        maxPowerW: { type: 'integer', desc: '功耗报警阈值，默认 300' },
      },
      async run(a, ctx) {
        const rounds = clamp(int(a.rounds, 5), 1, 30)
        const seconds = clamp(int(a.seconds, 2), 1, 30)
        const cols = ['index', 'memory.total', 'memory.free', 'temperature.gpu', 'power.draw', 'utilization.gpu']
        const samples = []
        const alerts = []
        for (let i = 0; i < rounds; i++) {
          const r = await smi(ctx, ['--query-gpu=' + cols.join(','), '--format=csv,noheader,nounits'], { timeoutMs: 15000 })
          if (!r.ok) return r
          for (const g of csvRows(r.stdout, cols)) {
            const free = num(g['memory.free'])
            const temp = num(g['temperature.gpu'])
            const power = num(g['power.draw'])
            samples.push({ t: new Date().toISOString().slice(11, 19), gpu: g.index, freeMiB: free, tempC: temp, powerW: power, util: num(g['utilization.gpu']) })
            if (temp && temp >= int(a.maxTempC, 90)) alerts.push(`GPU${g.index} 温度 ${temp}C ≥ ${a.maxTempC}`)
            if (free !== null && free <= int(a.maxMiB, 512)) alerts.push(`GPU${g.index} 剩余显存 ${free}MiB ≤ ${a.maxMiB}`)
            if (power && power >= int(a.maxPowerW, 300)) alerts.push(`GPU${g.index} 功耗 ${power}W ≥ ${a.maxPowerW}`)
          }
          if (i < rounds - 1) await new Promise((res) => setTimeout(res, seconds * 1000))
        }
        return { rounds, seconds, samples, alerts: alerts.length ? alerts : null, verdict: alerts.length ? '有告警' : '全部在阈值内' }
      },
    },
    {
      name: 'nvidia_cuda_probe',
      desc: '探测 CUDA 运行时：nvcc 版本、deviceQuery 结果、驱动/运行时版本是否匹配',
      params: { deviceQueryPath: { type: 'string', desc: 'deviceQuery 可执行路径（可选）' } },
      async run(a, ctx) {
        const nvcc = await ctx.exec('nvcc', ['--version'], { timeoutMs: 15000 })
        const driver = await smi(ctx, ['--query-gpu=index,name,driver_version,compute_cap', '--format=csv,noheader'])
        const libs = []
        const fs2 = await import('node:fs')
        for (const base of ['/usr/local', '/usr/lib/x86_64-linux-gnu', 'C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA']) {
          try {
            for (const f of fs2.readdirSync(base)) if (/^cuda|^libcudnn/i.test(f)) libs.push(`${base}/${f}`)
          } catch (e) {}
        }
        let dq = null
        if (a.deviceQueryPath) {
          const r = await ctx.exec(ctx.resolve(a.deviceQueryPath), [], { timeoutMs: 30000 })
          dq = { code: r.code, cudaTook: /CUDA_OK|Device Query PASSED/.test(String(r.stdout)), devices: [...String(r.stdout).matchAll(/Device\s+(\d+)/g)].map((m) => m[1]), sample: String(r.stdout).split(/\r?\n/).filter((l) => /CUDA Capability|Total Memory|Name/.test(l)).slice(0, 12) }
        }
        return {
          nvcc: nvcc.code === 0 ? String(nvcc.stdout).split(/\r?\n/).filter((l) => /release|V\d/.test(l)).slice(0, 3) : null,
          nvccMissing: nvcc.code !== 0,
          driver: driver.ok ? csvRows(driver.stdout, ['index', 'name', 'driver_version', 'compute_cap']) : driver.message,
          cudaDirsFound: libs.slice(0, 20),
          deviceQuery: dq,
          advice: nvcc.code !== 0 ? '没装 nvcc（CUDA Toolkit）：只能跑预编译的 llama.cpp CUDA 版，不能自己编' : '有 nvcc：可 cmake -DGGML_CUDA=ON 编 llama.cpp',
        }
      },
    },
    {
      name: 'nvidia_shared_memory_check',
      desc: '查统一内存/显存压缩相关设置与可用性（overcommit、BAR1、Resizable BAR、mlock）',
      params: {},
      async run(_a, ctx) {
        const cols = ['index', 'name', 'memory.total', 'memory.total.visible', 'memory.bar1.total', 'memory.bar1.used', 'address_detail.details']
        const r = await smi(ctx, ['--query-gpu=' + cols.join(','), '--format=csv,noheader,nounits'], { timeoutMs: 20000 })
        const gpus = r.ok ? csvRows(r.stdout, cols) : []
        const env = {}
        for (const k of ['CUDA_MODULE_LOADING', 'CUDA_ENABLE_COREDUMP_ON_EXCEPTION', 'OVERCOMMIT', 'MALLOC_MMAP_THRESHOLD_', 'LLAMA_ARG_NO_MMAP', 'PYTORCH_CUDA_ALLOC_CONF']) if (process.env[k]) env[k] = process.env[k]
        const fs2 = await import('node:fs')
        let overcommit = null
        try {
          overcommit = fs2.readFileSync('/proc/sys/vm/overcommit_memory', 'utf8').trim()
        } catch (e) {}
        return {
          gpus: gpus.map((g) => ({ index: g.index, name: g.name, totalMiB: g['memory.total'], visibleMiB: g['memory.total.visible'], bar1TotalMiB: g['memory.bar1.total'], bar1UsedMiB: g['memory.bar1.used'] })),
          resizableBarNote: gpus.length && gpus[0]['memory.bar1.total'] && Number(gpus[0]['memory.bar1.total']) >= 16384 ? 'BAR1 ≥ 16GiB，Resizable BAR 生效，可整卡映射' : 'BAR1 偏小：大模型分层加载会频繁换入换出，BIOS 开 Resizable BAR',
          overcommitMemory: overcommit,
          relevantEnv: env,
          advice: ['P100 无统一内存（Hopper 才有），CPU↔GPU 走 PCIe，--n-gpu-layers 别超过显存能装下的层数', '想省显存优先 Q4_K_M / Q5_K_M + --cache-type-k q8；P100 上 FP16 缓存比 FP8 更实际'],
        }
      },
    },
  ],
}
