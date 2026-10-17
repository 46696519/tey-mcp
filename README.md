# tey-mcp — an integrated tool bus for DeepSeek Harness

**274 tools in 12 packs, only 7 resident meta tools.** Tools are *fetched in batches*
(30–50 at a time) with `tey_fetch`, which issues a **fingerprint**; `tey_call` / `tey_batch`
must present that fingerprint, tools you did not fetch cannot be called, and the fingerprint
dies on **TTL / idle expiry**. Ships its own skills. Zero runtime dependencies (node builtins only).

中文说明见 [README.zh.md](README.zh.md)。

**Why a bus:** registering hundreds of tools eats the context window, and on non-tool-search
routes `deferLoading` fails outright with `Deferred tool loading is not supported yet`.
Making the model *fetch* a batch on demand works on **every model route** and keeps only
7 tool shapes resident.

## The 7 meta tools

| Tool | Purpose |
| --- | --- |
| `tey_status` | packs/tools loaded, gate settings, live fingerprints, load errors |
| `tey_packs` | list packs, or list a pack's tool names (thin, no schemas) |
| `tey_fetch` | **claim a batch** → full parameter schemas + `fingerprint` |
| `tey_call` | run one claimed tool (fingerprint required) |
| `tey_batch` | run up to 12 calls sharing one fingerprint |
| `tey_mcp` | external MCP servers: status / refresh / list / call |
| `tey_configure` | read or change gate settings (TTL, idle, batch size, caps, disable packs) |

Flow: `tey_packs` → `tey_fetch` → call with the fingerprint → re-fetch when it expires.

## Packs

`fs` 36 · `text` 38 · `shell` 14 · `sys` 21 · `net` 22 · `web` 21 · `nvidia` 23 ·
`db` 19 · `git` 18 · `code` 25 · `media` 15 · `dsh` 22 — tool names are `<pack>_<name>`.

Highlights: GPU/VRAM/temperature/PCIe/NUMA/CPU-instruction-set probes and `nvidia_llama_bench`
for llama.cpp work; `db_memory_stack_report` for the four-layer DSH memory stack;
`code_*` for dead files, long functions, dependency and license audits;
`media_*` for magic-number file typing, PNG dominant colours, JPEG EXIF, PDF page counts.
External MCP servers fold into the same table as pack `mcp-<server>`, tools `mcp_<server>_<tool>`.

## Fingerprint gate

`fingerprint_missing` · `fingerprint_unknown` · `fingerprint_foreign` (other session) ·
`fingerprint_machine` (other machine) · `fingerprint_expired` · `fingerprint_idle` ·
`tool_not_granted`. Every rejection tells you to `tey_fetch` again. Max 6 live fingerprints
per session (LRU). Mutating tools are marked `W`; git/db/code/media writers also require
`args.confirm = true`.

## Install (fresh DSH)

```bash
plugin_manager install_bundle target=F:\GitHub\tey-mcp
```

or drop the folder into `…\.dsh\profiles\desktop\node_modules\tey-mcp\`, add `"tey-mcp"`
to `dsh.profile.bundles` in that profile's `package.json`, restart.
Skills install with the plugin (`package.json` → `dsh.skills`), nothing else to configure.
Say `tey_status` afterwards: `包 12 个 / 工具 274 个`.

## Configuration

Precedence: built-in defaults < plugin row config (`cordis.patch.yml`) < `~/.dsh/tey-mcp/config.json`.

| key | default | meaning |
| --- | --- | --- |
| `ttlSeconds` | 1800 | fingerprint lifetime |
| `idleSeconds` | 900 | idle expiry |
| `fetchMin` / `fetchMax` | 30 / 50 | batch size bounds |
| `maxBatch` | 12 | max calls per `tey_batch` |
| `resultMaxChars` | 20000 | per-tool output cap |
| `packsDisabled` | `[]` | turn packs off |
| `mcpServers` | `[]` | external MCP servers (stdio `command`+`args`, or http `url`) |

Change at runtime: `tey_configure {"action":"set","key":"fetchMax","value":"50"}` (applies and persists).

## Develop & verify

```bash
node scripts/validate.mjs            # contract lint: names, params, descriptions, zero deps
node scripts/validate.mjs --smoke    # run all 274 tools with empty args, catch real crashes
node scripts/selftest.mjs            # end-to-end bus: fetch → call → gate → batch → configure
```

Adding a tool = append one entry to `tools` in `src/packs/<pack>.js`
(`{name,desc,params,run}`, see `src/packs/_CONTRACT.md`) — `index.js` never changes.

## Known limits

Parsing is regex/heuristic level (code outline, complexity, PDF text, EXIF) — results carry a
`note` when they are approximate. Paths stay inside the session workspace unless absolute.
Every external command has both Windows and Linux forms and returns a Chinese explanation
instead of throwing when the tool is missing.
