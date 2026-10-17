# tey-mcp — DeepSeek Harness 集成工具总线

一个插件塞进 **274 个工具**，分 **12 组**；但只往模型注册 **7 个常驻元工具**。
工具靠 `tey_fetch` **按批取用**（一次 30–50 个），取的时候发一张 **指纹（fingerprint）**；
`tey_call` / `tey_batch` 必须带这张指纹，**没取用的工具调不动，指纹过期/闲置就作废**。
自带 2 个 skill，零运行依赖（只用 node 内置模块）。

> 为什么这么设计：几百个工具直接注册会把上下文吃光，而且非 tool-search 路由上
> `deferLoading` 直接报 `Deferred tool loading is not supported yet`。
> 总线把「工具清单」变成模型主动取用的动作，**任何模型路由都能用**，上下文里永远只有 7 个工具的形状。

## 7 个常驻元工具

| 工具 | 作用 |
| --- | --- |
| `tey_status` | 总线状态：几组几工具、门参数、已发指纹、加载报错 |
| `tey_packs` | 列组 / 列某组工具名（薄清单，不含参数） |
| `tey_fetch` | **取一批工具** → 完整参数 schema + `fingerprint` |
| `tey_call` | 执行一个已取用的工具（必须带指纹） |
| `tey_batch` | 一次跑多条（默认上限 12），共用一张指纹 |
| `tey_mcp` | 外部 MCP 服务器：状态 / 重连 / 列工具 / 调用 |
| `tey_configure` | 读改配置（TTL、闲置、一次取几个、结果上限、关某组） |

标准流程：**`tey_packs` 查 → `tey_fetch` 取 → 带指纹 `tey_call`/`tey_batch` → 过期重取。**

## 12 个工具组

| 组 | 数量 | 覆盖 |
| --- | --- | --- |
| `fs` | 36 | 读写、批量替换、diff、JSON/JSONL/CSV、frontmatter、快照对比 |
| `text` | 38 | 大小写/去重/词频、正则、JSON/YAML/CSV 互转、编码、哈希、时间与 cron、单位换算 |
| `shell` | 14 | 跑命令（单条/并发/后台）、进程、端口、PATH、日志尾部 |
| `sys` | 21 | 系统概览、服务、启动项、计划任务、防火墙、剪贴板、磁盘/进程 IO、硬件、电源 |
| `net` | 22 | ping、TCP/端口扫描、HTTP 探测、DNS、证书到期、TLS 能力、局域网、RDAP、测速 |
| `web` | 21 | 抓正文转 Markdown、抽链接/表格/JSON-LD、sitemap/RSS、扒接口路径、批量抓取与差异 |
| `nvidia` | 23 | 显存/温度/功耗/进程、拓扑、驱动、CPU 指令集（AVX2/AVX-512）、PCIe、NUMA、GGUF 头、模型盘点、llama-bench、服务健康 |
| `db` | 19 | sqlite 扫库、schema、只读查询、跨表搜索、FTS、完整性、导出、WAL、备份、**四层记忆栈体检** |
| `git` | 18 | status/log/diff/分支/贡献者/文件史、暂存提交推送（要 `confirm`）、remote 检查 |
| `code` | 25 | 代码量统计、大纲、依赖图、死文件、TODO、超长函数、复杂度、重复行、依赖审计、许可证、跑测试/类型检查/lint |
| `media` | 15 | 魔数辨类、图片尺寸/主色/EXIF/相似比对、PDF 页数与抽文、音频视频头、ffprobe/ffmpeg、校验和 |
| `dsh` | 22 | 插件/bundle/skill 清单、cordis 行查询、会话统计、engram/knowledge/kb 统计、**四层记忆栈自检**、runtime 版本、配置读写 |

工具名一律 `<组>_<名字>`，例如 `fs_read`、`nvidia_gpu_list`、`db_memory_stack_report`。
外部 MCP 服务器折进同一张表：组 `mcp-<server>`，工具 `mcp_<server>_<tool>`。

## 指纹门

| 返回 `code` | 意思 | 解法 |
| --- | --- | --- |
| `fingerprint_missing` | 没带指纹 | 先 `tey_fetch` |
| `fingerprint_unknown` | 指纹不存在（作废/重启） | 重新 `tey_fetch` |
| `fingerprint_foreign` | 别的会话取的 | 本会话自己取 |
| `fingerprint_machine` | 别的机器取的 | 本机重新取 |
| `fingerprint_expired` | 超过存活时限（默认 30 分钟） | 重新 `tey_fetch` |
| `fingerprint_idle` | 闲置超时（默认 15 分钟） | 重新 `tey_fetch` |
| `tool_not_granted` | 工具不在本次取用清单 | 把该组/该名字 fetch 进来 |

一个会话最多同时留 6 张指纹（LRU 淘汰）。写操作在 `tey_packs` 里标 `W`；
`git_commit` / `git_push` / `db_exec_write` / `code_run_tests` / `media_ffmpeg_run` 等还要 `args.confirm = true`。

## 装（新装 DSH 之后）

仓库已经和 `cordis.patch.yml` 绑好，装法二选一：

**A. 命令行（推荐）**

```bash
# 在 DSH 会话里
plugin_manager install_bundle  target=F:\GitHub\tey-mcp
```

**B. 手动**：把整个目录放进 profile 的包目录
`C:\Users\<你>\.dsh\profiles\desktop\node_modules\tey-mcp\`，
再在该 profile 的 `package.json` → `dsh.profile.bundles` 里加 `"tey-mcp"`，重启 DSH。

装完在会话里说「tey_status」就能看到 `包 12 个 / 工具 274 个`。
**skills 随插件一起装**（`package.json` 的 `dsh.skills` 已指向 `skills/tey-mcp/SKILL.md`
与 `skills/tey-toolbox/SKILL.md`），不用再单独配。

## 配置

优先级：内置默认 < 插件行配置（`cordis.patch.yml` 的 `config:`）< `~/.dsh/tey-mcp/config.json`。

| key | 默认 | 作用 |
| --- | --- | --- |
| `ttlSeconds` | 1800 | 指纹存活时限 |
| `idleSeconds` | 900 | 闲置时限 |
| `fetchMin` / `fetchMax` | 30 / 50 | 一次取用上下限 |
| `maxBatch` | 12 | `tey_batch` 一次最多几条 |
| `resultMaxChars` | 20000 | 单个工具结果上限 |
| `packsDisabled` | `[]` | 关掉某几个组 |
| `mcpServers` | `[]` | 外部 MCP（stdio 用 `command`+`args`，http 用 `url`） |

改法：`tey_configure {"action":"set","key":"fetchMax","value":"50"}`（立刻生效并落盘），
或直接编辑 `~/.dsh/tey-mcp/config.json`。

外部 MCP 示例（写进 `config.json`）：

```json
{
  "mcpServers": [
    { "name": "rag", "url": "http://127.0.0.1:8000/mcp" },
    { "name": "local", "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "KEY": "value" } }
  ]
}
```

## 开发与自检

```bash
cd F:\GitHub\tey-mcp
node scripts/validate.mjs            # 契约校验（包/工具名/参数/描述、零依赖、无绝对路径）
node scripts/validate.mjs --smoke    # 274 个工具空参数各跑一遍，抓真崩的
node scripts/selftest.mjs            # 总线端到端：取用 → 调用 → 越权/过期 → 批量 → 配置
node scripts/validate.mjs --count    # 只出数量表
```

加一个工具 = 在 `src/packs/<组>.js` 的 `tools` 数组里加一项（`{name,desc,params,run}`），
照 `src/packs/_CONTRACT.md` 写，跑 `--smoke` 就行，不用碰 `index.js`。

## 更新与备份

```bash
cd F:\GitHub\tey-mcp
node scripts/validate.mjs --smoke && node scripts/selftest.mjs
git add -A && git commit -m "packs: ..."
git push            # 备份到 https://github.com/46696519/tey-mcp
```

换机器只要 `git clone` + 上面「装」那一步，插件 + skills + 配置模板全带上。

## 已知边界

- 解析是**正则/启发式**级（代码大纲、复杂度、PDF 抽文、EXIF），够用但不保证严谨；结论会标 `note`。
- 路径默认锁在会话工作区内，跨区要传绝对路径。
- Windows / Linux 双命令都写了：`where/taskkill/powershell` 对 `ps/ss/systemctl/ip`；缺命令时工具返回中文说明而不是报错。
- `node:sqlite` 走运行时 node（本机 24.18.1 有），拿不到时 `db_sqlite_available` 会告诉你。
