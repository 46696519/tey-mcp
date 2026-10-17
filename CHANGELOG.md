# Changelog

所有值得记录的改动都在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] - 2026-10-17

第一个可用版本：一个插件装完就有工具总线 + skills，不用再单独配任何东西。

### Added

- **总线核心**：只注册 7 个常驻元工具 `tey_status` `tey_packs` `tey_fetch` `tey_call` `tey_batch` `tey_mcp` `tey_configure`，
  其余工具按组取用，绕开「几百个工具撑爆上下文」和非 tool-search 路由上 `deferLoading` 不可用的问题。
- **指纹门**（`src/gate.js`）：`tey-<16hex>`，绑会话 + 绑机器，TTL 与闲置双时限，
  工具必须在本次取用清单里，单会话最多 6 张指纹（LRU）。七种拒绝码各自给下一步。
- **注册表 / 执行器**（`src/registry.js` `src/runner.js`）：动态加载 `src/packs/*.js`，
  参数表编成 JSON Schema，参数宽松校验（string→number/boolean 宽容），超时掐断，
  工具异常一律收成 `{ok:false,code,message}`；`ctx` 提供 `cwd/resolve/tmp/exec/fetch/call/config/dataDir/truncate/registry`。
- **外部 MCP 桥**（`src/mcp-bridge.js`）：手写 MCP JSON-RPC，stdio（`Content-Length` 分帧）与
  streamable HTTP（`mcp-session-id` 复用 + SSE 解帧）两种链路；外部工具折进同一张表
  （组 `mcp-<server>`，工具 `mcp_<server>_<tool>`），取用调用方式与内置完全一致。
- **12 个工具组，274 个工具**：
  - `fs` 36 文件系统（读写、批量替换、diff、JSON/JSONL/CSV、frontmatter、快照对比）
  - `text` 38 文本与编码（清洗、正则、JSON/YAML/CSV 互转、编码、哈希、时间/cron、单位换算）
  - `shell` 14 系统与进程（单条/并发/后台命令、进程、端口、PATH、日志尾部）
  - `sys` 21 操作系统状态（概览、服务、启动项、计划任务、防火墙、剪贴板、磁盘/进程 IO、硬件、电源）
  - `net` 22 网络诊断（ping、TCP/端口扫描、HTTP 探测、DNS、证书到期、TLS 能力、局域网、RDAP、测速）
  - `web` 21 网页抓取与解析（正文转 Markdown、抽链接/表格/JSON-LD、sitemap/RSS、扒接口、批量与差异）
  - `nvidia` 23 GPU 与推理（显存/温度/功耗/进程、拓扑、驱动、CPU 指令集、PCIe、NUMA、GGUF、模型盘点、llama-bench、服务健康）
  - `db` 19 SQLite（扫库、schema、只读查询、跨表搜索、FTS、完整性、导出、WAL、备份、四层记忆栈体检）
  - `git` 18 Git 与仓库（状态/日志/差异/贡献者/文件史；暂存提交推送需 `confirm`）
  - `code` 25 代码体检（代码量、大纲、依赖图、死文件、TODO、超长函数、复杂度、重复行、依赖审计、许可证、跑测试/类型检查/lint）
  - `media` 15 媒体与文件类型（魔数辨类、图片尺寸/主色/EXIF/相似比对、PDF 页数与抽文、音视频头、ffprobe/ffmpeg、校验和）
  - `dsh` 22 DSH 插件与配置（插件/bundle/skill 清单、cordis 行查询、会话统计、四层记忆栈自检、runtime 版本、配置读写）
- **skills 随插件走**：`skills/tey-mcp/SKILL.md`（总线协议 + 指纹门对照表）、
  `skills/tey-toolbox/SKILL.md`（12 组 274 工具速查 + 任务→组对照表）。
- **配置分层**：内置默认 < 插件行配置（`cordis.patch.yml`）< `~/.dsh/tey-mcp/config.json`；
  `tey_configure` 可运行时改并落盘。
- **校验与自检**：`scripts/validate.mjs`（契约 lint + `--smoke` 空参数全量跑，抓 `is not a function` 这类真崩）、
  `scripts/selftest.mjs`（端到端 32 项：取用 → 调用 → 越权/过期/跨会话 → 批量 → 配置 → 渲染）。
- 文档：`README.md` / `README.zh.md`、`locale/en.json` / `locale/zh.json`、`icon.svg`、`src/packs/_CONTRACT.md`。

### Fixed

- `runner.js` 缺 `ctx.exec` / `ctx.fetch` —— 所有调外部命令的工具（shell/sys/net/git/nvidia/media/code）
  运行时会 `ctx.exec is not a function`；补上带超时与 cwd 默认值的实现。
- `readTextSafe` 返回的是 `{ok,text}` 而不是字符串，`code`/`media` 组按字符串用导致
  `text.match is not a function`；统一收成 `readStr()`。
- `nvidia_llama_bench` 里 `/([\d.]+)\s*\+/-g` 被解析成正则减变量 `g`，改成 `/([\d.]+)\s*\+\/-/g`。
- `sys_disk_io` / `sys_process_io` 把 `{timeoutMs}` 当第三个参数传给 `ps()`（它要的是数字），
  导致 `setTimeout` 收到对象立刻超时；改成数字。
- `web_form_post` 组了 `body` 却没传给 `grab()`，POST 实际没带数据；`grab()` 支持 `body` 并回传 `sentBytes`。
- `web_batch` 用 `RegExp.$1` 取标题（易被后续匹配污染），改成显式捕获组。
- `tey_status` 把 `maxGrants`（单会话指纹数）当 `maxBatch` 报出去；现在分别报 `maxBatch` 与 `maxGrantsPerSession`。
- `tey_fetch` 不给任何参数时返回 `nothing_to_fetch`；改成跨组轮转发一批，闲置模型一次拿 30–50 个就能干活。
- `validate.mjs --smoke` 的可疑判定漏了 `is not a function` / `TypeError` / `Maximum call stack`，
  导致真崩的工具被算成「通过」。

### Notes

- 解析层是正则/启发式，结论会带 `note` 标注不确定性；不追求 AST 级严谨。
- 零运行依赖是刻意的：从重复的一份 `@deepseek-ai/dsh-tools` 里 import 会踩
  `Cannot read properties of undefined (reading 'prepare')`。
