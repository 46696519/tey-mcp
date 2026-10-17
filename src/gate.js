// 指纹门：tey_fetch 发一张「取用凭证」（指纹），tey_call / tey_batch 必须带着它。
// 指纹绑会话 + 机器，带过期时间与闲置时限；过期、闲置、跨会话、伪造一律拒。
import { machineId, randomHex, sha256, clamp, int } from './util.js'

const FP_RE = /^tey-[0-9a-f]{16}$/

export class Gate {
  constructor(config = {}) {
    this.secret = randomHex(24)
    this.grants = new Map()
    this.statsLog = []
    this.machine = machineId()
    this.setConfig(config)
  }

  setConfig(config = {}) {
    this.ttlMs = Math.max(30_000, int(config.ttlSeconds, 1800) * 1000)
    this.idleMs = Math.max(30_000, int(config.idleSeconds, 900) * 1000)
    this.fetchMin = clamp(int(config.fetchMin, 30), 1, 200)
    this.fetchMax = clamp(int(config.fetchMax, 50), this.fetchMin, 200)
    this.maxGrants = clamp(int(config.maxGrantsPerSession, 6), 1, 32)
  }

  /** 发指纹：绑定会话、工具集合与过期时间。 */
  issue({ sessionKey, cwd, tools, packs, reason }) {
    const now = Date.now()
    const fp = `tey-${sha256(`${this.secret}|${sessionKey}|${now}|${randomHex(8)}`).slice(0, 16)}`
    const grant = {
      fp,
      sessionKey,
      cwd: cwd || '',
      machine: this.machine,
      tools: new Set(tools || []),
      packs: new Set(packs || []),
      issuedAt: now,
      expiresAt: now + this.ttlMs,
      lastUsed: now,
      calls: 0,
      issuedReason: reason || 'fetch',
    }
    this._evict(sessionKey)
    this.grants.set(fp, grant)
    return grant
  }

  _evict(sessionKey) {
    const mine = [...this.grants.values()].filter((g) => g.sessionKey === sessionKey)
    if (mine.length < this.maxGrants) return
    mine.sort((a, b) => a.lastUsed - b.lastUsed)
    const drop = mine.slice(0, mine.length - this.maxGrants + 1)
    for (const g of drop) this.grants.delete(g.fp)
  }

  /** 验指纹：存在 + 会话匹配 + 机器匹配 + 未过期 + 未闲置 + 工具在授权集内。 */
  verify(fp, { sessionKey, tool }) {
    if (typeof fp !== 'string' || !FP_RE.test(fp)) {
      return { ok: false, code: 'fingerprint_missing', message: 'fingerprint 形状不对，先调 tey_fetch 取一张' }
    }
    const g = this.grants.get(fp)
    if (!g) return { ok: false, code: 'fingerprint_unknown', message: '这张指纹不存在（可能已回收），重新 tey_fetch' }
    if (g.sessionKey !== sessionKey) {
      return { ok: false, code: 'fingerprint_foreign', message: '指纹属于别的会话，本会话请重新 tey_fetch' }
    }
    if (g.machine !== this.machine) {
      return { ok: false, code: 'fingerprint_machine', message: '指纹来自另一台机器，重新 tey_fetch' }
    }
    const now = Date.now()
    if (now >= g.expiresAt) {
      this.grants.delete(fp)
      return { ok: false, code: 'fingerprint_expired', message: `指纹已过期（${new Date(g.expiresAt).toISOString()}），重新 tey_fetch` }
    }
    if (now - g.lastUsed > this.idleMs) {
      this.grants.delete(fp)
      return { ok: false, code: 'fingerprint_idle', message: '闲置太久指纹作废，重新 tey_fetch' }
    }
    if (tool && !g.tools.has(tool) && !g.packs.has(packOf(tool))) {
      return { ok: false, code: 'tool_not_granted', message: `${tool} 不在这张指纹的取用范围，tey_fetch 把它取进来` }
    }
    g.lastUsed = now
    g.calls += 1
    return { ok: true, grant: g }
  }

  list(sessionKey) {
    return [...this.grants.values()]
      .filter((g) => !sessionKey || g.sessionKey === sessionKey)
      .map((g) => ({
        fingerprint: g.fp,
        tools: g.tools.size,
        packs: [...g.packs],
        issuedAt: new Date(g.issuedAt).toISOString(),
        expiresAt: new Date(g.expiresAt).toISOString(),
        lastUsed: new Date(g.lastUsed).toISOString(),
        calls: g.calls,
      }))
  }

  revoke(fp) {
    return this.grants.delete(fp)
  }

  clear() {
    const n = this.grants.size
    this.grants.clear()
    return n
  }
}

function packOf(toolName) {
  const i = String(toolName || '').indexOf('_')
  return i > 0 ? String(toolName).slice(0, i) : ''
}
