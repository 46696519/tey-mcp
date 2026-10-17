---
name: tey-mcp
description: tey-mcp 工具总线协议。几百个工具不在模型上下文里常驻，而是按组（pack）用 tey_fetch 取一批、拿到 fingerprint，再靠 tey_call / tey_batch 执行；没取用或指纹过期就调不动。Use when a task needs many small tools (files, text, shell, GPU, network, git, sqlite, web, media, code analysis) and you must discover and invoke them through tey_fetch/tey_call; also matches Chinese requests 取工具、调工具、指纹过期、批量调用、tey 总线.
---

# tey-mcp 工具总线

tey-mcp 把 **274 个工具**收进 12 个组（pack），但**只往模型注册 7 个常驻元工具**。
其余工具要靠 `tey_fetch` 取进来，取的时候发一张 **fingerprint**；`tey_call` / `tey_batch`
必须带这张指纹，而且**只能调这次取用清单里的工具**。指纹有存活时限和闲置时限，过期就作废，
必须重新 `tey_fetch`。这样上下文里永远只有 7 个工具的形状，却能随时换一批干活。

## 7 个常驻元工具

| 工具 | 干什么 | 典型参数 |
| --- | --- | --- |
| `tey_status` | 看总线状态：几个组几个工具、门参数（TTL/闲置/一次取几个）、已发指纹 | `{}` |
| `tey_packs` | 不给参数=列 12 个组；给 `pack`/`query`=列工具名（薄清单，不含参数） | `{"pack":"fs"}` `{"query":"显存"}` |
| `tey_fetch` | **取一批工具**：返回完整参数 schema + `fingerprint` | `{"pack":"text"}` `{"query":"端口"}` `{"names":["fs_read"]}` `{"limit":40}` |
| `tey_call` | 执行一个已取用的工具 | `{"fingerprint":"tey-…","tool":"fs_read","args":{"path":"README.md"}}` |
| `tey_batch` | 一次跑多条（默认上限 12 条），共用同一张指纹 | `{"fingerprint":"tey-…","calls":[{"tool":"…","args":{}}]}` |
| `tey_mcp` | 外部 MCP 服务器：状态 / 重连 / 列工具 / 调用 | `{"action":"status"}` `{"action":"refresh"}` |
| `tey_configure` | 读或改总线配置（TTL、闲置、一次取几个、结果上限、开关某个组） | `{"action":"get"}` `{"action":"set","key":"fetchMax","value":"50"}` |

## 标准流程（照这个顺序做）

1. **不知道有什么** → `tey_status` 或 `tey_packs`（不给参数）。
2. **锁定范围** → `tey_packs {"query":"关键词"}` 或 `{"pack":"组id"}` 看工具名与一句话说明。
3. **取用** → `tey_fetch {"pack":"组id"}`（或 `{"query":…}` / `{"names":[…]}`）。
   - 一次给 **30–50 个**（默认上限 50，可传 `limit`）。
   - **什么都不传**也行：总线跨组轮转发一批，闲置模型拿这一批就能开始干活。
   - 返回里 `tools[]` 带完整 `parameters`（JSON Schema），照着填就行。
   - 记住返回的 `fingerprint` 和 `expiresAt`。
4. **执行** → `tey_call {"fingerprint":"…","tool":"…","args":{…}}`。
   - 多条一起干用 `tey_batch`，一条失败不影响其余，返回里逐条给 `ok`。
5. **要换一批工具** → 再 `tey_fetch`（一个会话最多同时留 6 张指纹，最久未用的先淘汰）。

## 指纹门规则（被拒时看 code）

| `code` | 含义 | 怎么办 |
| --- | --- | --- |
| `fingerprint_missing` | 没带 fingerprint | 先 `tey_fetch` |
| `fingerprint_unknown` | 指纹不存在（已作废/被 clear/会话重启） | 重新 `tey_fetch` |
| `fingerprint_foreign` | 这张指纹是别的会话取的 | 本会话自己 `tey_fetch` |
| `fingerprint_machine` | 指纹是别的机器发的 | 本机重新 `tey_fetch` |
| `fingerprint_expired` | 超过存活时限（默认 30 分钟） | 重新 `tey_fetch` |
| `fingerprint_idle` | 闲置超时（默认 15 分钟没动） | 重新 `tey_fetch` |
| `tool_not_granted` | 这个工具不在本次取用清单里 | 把它的组/名字加进 `tey_fetch` 再取一次 |

**别硬猜工具名**：调不通就先 `tey_packs` 查名字，不要连撞三次。

## 写操作与确认

- 工具名带 `W`（`tey_packs` 清单里标 `W`）= 会改东西。
- `git_*` 的改动类、`db_exec_write`、`code_run_tests` / `code_typecheck` / `code_lint`、
  `media_ffmpeg_run`、`web_form_post` 等要求 `args.confirm = true`，不传就只回一句确认提示，不会动手。
- 路径参数默认锁在会话工作区内；要读工作区外（比如 `C:\Users\…\.dsh`）就传绝对路径，工具会自己判断。

## 调参（`tey_configure`）

可改的 key：`ttlSeconds` `idleSeconds` `fetchMin` `fetchMax` `maxBatch` `resultMaxChars`
`packsDisabled` `mcpServers`。`{"action":"set","key":"…","value":"…"}` 立刻生效并写进
`~/.dsh/tey-mcp/config.json`（优先级高于插件行配置）。`{"action":"clear"}` 作废本插件所有指纹。

## 外部 MCP 服务器

配置里加 `mcpServers`（stdio 用 `command`+`args`，http 用 `url`），
它们的工具会被折进同一张表：组 id 是 `mcp-<server>`，工具名 `mcp_<server>_<tool>`，
取用与调用方式和内置工具完全一样（`tey_fetch {"pack":"mcp-<server>"}`）。
`tey_mcp {"action":"status"}` 看连没连上，`{"action":"refresh","server":"<server>"}` 重连。

## 一句话纪律

**先查（tey_packs）→ 再取（tey_fetch）→ 带着指纹调（tey_call/tey_batch）→ 过期就重取。**
不要一次 fetch 全部 274 个工具塞进上下文，按任务取 30–50 个就够干活。
