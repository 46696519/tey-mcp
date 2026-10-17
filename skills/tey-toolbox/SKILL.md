---
name: tey-toolbox
description: tey-mcp 12 个工具组（274 个工具）的速查目录：fs 文件、text 文本编码、shell 进程、sys 系统、net 网络、web 抓取、nvidia GPU/推理、db SQLite、git 仓库、code 代码体检、media 媒体、dsh 插件配置。Use when choosing which tey-mcp pack/tool fits the task — read this before tey_fetch so you fetch the right group; matches Chinese requests 有哪些工具、哪个组、找工具、工具清单、工具目录.
---

# tey-mcp 工具箱速查

选组 → `tey_fetch {"pack":"组id"}` → `tey_call`。工具名一律是 `<组>_<名字>`（下表省略组前缀）。
`W` = 会写东西。`C` = 需要 `args.confirm=true` 才真动手。
拿不准就 `tey_packs {"query":"关键词"}`，别凭记忆猜名字。

## fs (36) 文件系统 — 读写、批量改、结构化文件

- 读写：`read` `write` `append` `head` `tail` `lines_slice` `count` `stat` `exists` `list` `tree` `du`
- 找：`find`（glob）`grep`（正则，带上下文）
- 改：`replace` `replace_all` `patch_lines`（按行号）`diff` `copy` `move` `remove` `mkdir` `touch`
- 批量：`batch_rename` `find_replace_files`（多文件一次改，先 `dryRun`）
- 结构化：`json_read` `json_write` `jsonl_append` `jsonl_read` `csv_read` `csv_write`
  `frontmatter_read` `frontmatter_set`（Markdown frontmatter）
- 其他：`hash` `snapshot` + `snapshot_diff`（改前拍一张，改后比）

例：`tey_fetch {"pack":"fs"}` → `tey_call {"tool":"fs_grep","args":{"pattern":"NVIDIA_API_KEY","path":"src"}}`

## text (38) 文本与编码 — 转换、比对、结构化互转

- 清洗：`case` `whitespace` `split` `sort_uniq` `freq` `stats` `sample` `indent` `lines_between`
- 匹配：`regex`（提取/替换）`diff` `similar`（相似度）
- 互转：`json` `json_diff` `json_merge` `yaml` `csv` `md_table` `pretty_table` `html` `url` `jwt`
- 编码：`encode`（base64/hex/url/…）`hash` `compress`（gzip）
- 值：`number`（千分位/科学计数）`unit`（字节、速率换算）`color`（色值互转）`id`（uuid/雪花）
  `random_string` `slugify` `semver`
- 时间：`date` `date_math` `duration` `cron`（下次几点跑）`tz`
- 其他：`template`（占位符填充）

## shell (14) 系统与进程 — 跑命令、看进程端口

- `exec`（单条，带 cwd/超时/输入）`exec_parallel`（多条并发）`spawn_bg`（后台起，返回 pid）
- `which`（命令在不在 PATH）`env`（读环境变量）`cmd_health`（一批命令哪个能跑）
- `ps` `kill` `proc_group`（按名字找一整套进程树）`ports`（谁占了哪个端口）
- `os_info` `disk` `tail_log`（跟日志尾部）`path_report`（PATH 上都有啥、有没有重复）

## sys (21) 操作系统状态 — Windows / Linux 双命令

- 概览：`summary`（CPU/内存/盘/系统一把抓）`memory_detail` `uptime_boot` `hardware`（型号/BIOS/内存条）
- 服务：`services` `service_detail`（systemd unit 属性 / Windows 服务）`startup_items` `scheduled_tasks`
- 盘与 IO：`tmp_usage` `disk_io`（/proc/diskstats 差值 或 Get-Counter）`process_io`（每进程读写）`open_files`
- 桌面：`clipboard`（读/写/追加）`clip_history`（读 dsh-clipper 历史库，装了才有）
- 其他：`users` `packages`（winget/choco/apt/pip/npm 清单）`firewall` `locale_tz` `env_snapshot`
  `gpu_raw`（nvidia-smi 原样输出）`power_plan`（电源方案/睡眠状态）

## net (22) 网络诊断 — 连通、端口、证书、DNS

- 连通：`ping` `tcp_probe`（单端口）`port_scan`（端口段）`latency_batch`（一批地址延迟）`speed_test`
- HTTP：`http_probe`（状态/耗时/头）`http_headers_build`（拼一套请求头）`banner_grab`
- 证书：`cert_info`（链/到期天数/SNI）`cert_expiry_scan`（一批域名看哪天过期）`tls_capability`（支持哪些协议套件）
- DNS：`dns_lookup`（A/AAAA/MX/TXT/CNAME…）`dns_ptr` `dns_servers`（本机用的谁）`rdap_domain`（注册信息/到期）
- 本机：`interfaces` `route_table` `lan_neighbors`（局域网谁在）`upnp_map` `ip_info`（出口 IP/ASN）`ip_range`（算网段）

## web (21) 网页抓取与解析 — 抓正文、抽结构、批量

- 抓：`fetch_text` `fetch_markdown` `article`（抽正文）`save_article`（存成 md）`batch`（并发多 URL）`diff`（两次抓比变化）
- 抽：`meta`（title/desc/OG）`links` `images` `tables` `table_csv`（表格转 CSV）`jsonld`（结构化数据）
- 站点级：`sitemap` `rss` `api_paths`（从 JS 里扒接口路径）`assets`（静态资源清单）`status_matrix`（一批 URL 状态码）
- 其他：`headers`（看响应头）`form_post`（POST 表单，`C`）`search_saved`（搜本地存过的文章）`cookie_parse`

## nvidia (23) GPU 与推理 — 显存、温度、llama.cpp、GGUF

- 看卡：`gpu_list` `memory`（显存占用）`thermal_power`（温度/功耗/降频）`processes`（哪个进程吃显存）
  `clocks` `topology`（NVLink/P2P）`modes`（ECC/功耗上限）`driver_info` `dmon`（滚动采样）`raw`（原样 nvidia-smi）
- 环境：`env_check`（驱动/CUDA/容器一把查）`cpu_caps`（**AVX2/AVX-512 有没有**，编 llama.cpp 前必看）
  `pcie_link`（带宽掉没掉）`numa_advice`（绑核建议）`cuda_probe` `shared_memory_check`（共享显存/大 BAR）
- 模型：`gguf_info`（GGUF 头：层数/上下文/量化/张量表）`model_inventory`（扫盘上有哪些模型，多大，什么量化）
  `llama_scan`（PATH/build 目录里的 llama 可执行）`llama_bench`（跑分 tok/s，`C`）
- 服务：`service_health`（探 /health /v1/models）`gpu_report`（一页汇总报告）`smi_watch`（连续采样）

## db (19) SQLite 查询 — DSH 记忆栈与任意 sqlite

- 探：`sqlite_available`（node:sqlite 能不能用）`scan_files`（扫盘上 .db/.sqlite）`tables` `schema` `table_info`
- 读：`query`（只读 SQL：select/with/pragma/explain）`search_rows`（跨表找关键词）`fts_search`（全文检索）
  `row_stats` `recent_rows` `count_by`
- 体检：`size_report`（每表多大）`integrity_check` `wal_checkpoint` `vector_check`（有没有向量列）
- 写：`exec_write`（写 SQL，`W` `C`）`export_table`（导 CSV/JSON）`backup_copy`（备份一份）
- DSH 专用：`memory_stack_report`（**engram / knowledge / knowledge-base / sessions 四层记忆栈一次查清**）
  - `findDbFile` 认别名：`engram` `knowledge` `kb` `storages` `sessions`，直接 `{"file":"engram"}` 就行

## git (18) Git 与仓库 — 只读为主，改动要 confirm

- 读：`status` `log` `diff_stat` `branches` `show` `contributors` `file_history` `ls_files` `untracked` `tags` `config_show` `remote_check`
- 写（`W` `C`）：`stage` `commit` `push` `pull` `stash`
- 其他：`remap`（改 remote 地址）

## code (25) 代码体检 — 结构、依赖、复杂度、跑检查

- 画像：`project_shape`（语言构成/测试比/缺哪些配置）`stats`（按扩展名分行数与注释占比）`file_metrics`（单文件指标）
- 结构：`outline`（函数/类大纲）`imports` `import_graph`（fan-in/fan-out）`dead_files`（疑似没人引用）
  `find_symbol` `unused_exports`（启发式，删前确认）
- 质量：`large_files` `long_functions` `complexity` `duplicate_lines` `todo_scan` `search`（跨文件正则）
- 依赖：`package_audit`（声明了没 import / import 了没声明）`scripts_list`（脚本能不能跑，缺哪个 CLI）
  `npm_outdated`（`C`）`lock_audit`（锁文件重复版本/可疑源）`licenses`（GPL/AGPL 扫一遍）`bundle_size`（产物体积）
- 跑（`C`）：`run_tests` `typecheck`（tsc 按文件/错误码汇总）`lint`（按规则汇总）
- 溯源：`git_touchers`（这块代码谁改过、最近谁动）

## media (15) 媒体与文件类型 — 不装 ffmpeg 也能读头

- 辨类：`file_kind`（**魔数识别真实类型**，看扩展名对不对得上）`bulk_scan`（整目录按真类型分类 + 找重复）
  `checksums`（md5/sha1/sha256/sha512）
- 图：`image_info`（尺寸/位深/**主色**/平均哈希）`image_exif`（机型/拍摄时间/GPS）`image_compare`（两张图像不像，汉明距离）`svg_info`
- 文档：`pdf_info`（页数/加密/作者/字体）`pdf_text_sample`（抽正文，判断是不是扫描版）
- 音视频：`audio_info`（WAV 头/MP3 帧/ID3）`video_info`（MP4 box/MKV）`ffprobe`（完整 JSON）`ffmpeg_available`（有没有 nvenc）
- 动（`W` `C`）：`ffmpeg_run`（转码/截帧/剪切）
- 小工具：`data_uri`（小图转 base64 内嵌）

## dsh (22) DSH 插件与配置 — 看自己、看插件、看记忆栈

- 总线：`tey_selftest`（tey-mcp 自检）`plugin_info`（本插件状态）
- 插件：`home_overview` `profiles` `bundles`（装了哪些包）`plugins_table` `plugin_enabled` `plugin_patch`
  `rows_list` `row_lookup`（cordis.yml 里的插件行）`skills_list` `skill_read`
- 记忆：`engram_stats` `knowledge_stats` `kb_stats` `memory_stack_check`（**四层记忆栈体检**）`sessions_stats`
- 环境：`runtime_versions`（node/pnpm 版本）`env_facts`（DSH_HOME、profile、平台）`data_dirs` `backup_status`
- 配置：`config_store`（读写 `~/.dsh/tey-mcp/config.json`）

## 常见任务 → 该取哪一组

| 想干什么 | 取这个组 |
| --- | --- |
| 改配置、批量替换文件、看 CSV/JSONL | `fs` |
| 换算单位、算时间、转 JSON/YAML/CSV、比文本 | `text` |
| 查显存、看温度、编 llama.cpp 前查 AVX2、跑 llama-bench | `nvidia` |
| 四层记忆栈（engram/knowledge/kb/sessions）体检、查 FTS | `db`（`memory_stack_report`）+ `dsh` |
| 看装了哪些插件/skill、插件行为什么没生效 | `dsh` |
| 端口谁占的、证书哪天过期、局域网谁在 | `shell`（`ports`）+ `net` |
| 抓正文存成 md、扒接口路径、一批 URL 状态 | `web` |
| 代码有没有死文件/超长函数/没声明的依赖 | `code` |
| 这图多大什么主色、PDF 几页、是不是扫描版 | `media` |
| 提交推送、看谁改过这块、查 remote | `git` |
| 服务状态、开机启动项、电源方案、剪贴板 | `sys` |
