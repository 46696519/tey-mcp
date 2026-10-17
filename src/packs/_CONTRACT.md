# tey-mcp 工具包写作契约（子代理必读）

一个工具包 = `src/packs/<id>.js` 一个 ESM 文件，默认导出一个包对象。零第三方依赖：
只允许 Node 内置模块（`node:fs`、`node:path`、`node:crypto`、`node:child_process`、
`node:http`、`node:https`、`node:net`、`node:tls`、`node:dns`、`node:zlib`、`node:os`、
`node:vm`、`node:sqlite`（必须 try/catch 懒加载）等）。禁止 import 任何 `@deepseek-ai/*`。

```js
import { json, list1 } from '../util.js'   // 可用工具函数见 src/util.js

export default {
  id: 'net',                       // 包 id：小写短词，必须等于文件名
  title: '网络请求',                // 中文名，出现在 tey_packs
  tags: ['net', 'http'],           // 检索标签
  summary: 'HTTP 请求、端口探测、DNS、证书与批量压测',  // 一句话，出现在 tey_packs
  tools: [
    {
      name: 'net_http_get',        // 工具名：^[a-z][a-z0-9_]{2,63}$，必须以包前缀开头，全局唯一
      desc: 'GET 一个 URL，返回状态码与正文（可截断）',  // ≤80 字，会进模型上下文，务必短
      params: {                    // 参数表（编译成 DSH 注册用的 JSON Schema）
        url: { type: 'string', required: true, desc: '完整 http(s) 地址' },
        timeoutMs: { type: 'integer', desc: '超时毫秒，默认 15000' },
        headers: { type: 'object', desc: '请求头', props: { accept: { type: 'string', desc: 'Accept' } } },
        tags: { type: 'array', desc: '附加标签', items: { type: 'string', desc: '标签' } },
      },
      write: false,                // 会写盘/改状态就填 true（纯读填 false）
      timeoutMs: 30000,            // 可选，单次执行上限，默认 30000
      run: async (args, ctx) => '任意字符串',   // 或返回对象（自动 JSON.stringify）
    },
  ],
}
```

## 硬性规则（校验脚本 `node scripts/validate.mjs` 会逐条查）

1. 工具名前缀 = 包 id + `_`，全局唯一，全小写下划线；一个包 20-40 个工具。
2. `params` 只允许这些类型：`string` `integer` `number` `boolean` `array` `object`。
   `array` 必须给 `items`；`object` 必须给 `props`（可空对象）。可选键：`required`(bool)、
   `desc`、`enum`、`default`、`examples`。别的键一律不写。
   参数名用小驼峰（`maxResults`、`dryRun`）或下划线都行，首字符必须是字母。
3. `run` 必须自己处理失败：`throw new Error('短原因')` 会被 runner 收成 `{ok:false,...}`，
   但**不许**让常见业务失败抛出（缺文件之类应返回可读字符串）。
4. 返回值：字符串，或可 JSON 序列化的对象。别返回 Buffer、函数、循环引用。
5. 路径参数一律用 `ctx.resolve(p)`（相对路径按会话工作区解析，越界会报错），
   临时文件用 `ctx.tmp()`。不许写死 `C:\Users\...`。
6. 命令执行一律走 `ctx.exec(cmd, args, opts)`（带超时、不继承敏感环境变量），
   不要自己 `spawn` + 无限等待。
7. 不许在模块顶层做重活（读大文件、联网、起进程）；顶层只放常量与定义。
8. Windows 与 Linux 都要跑得通：路径用 `node:path`，别假设 `/bin/sh`。
9. `desc` 与 `params.*.desc` 用简体中文；工具名与参数名用英文。
10. 每个工具都要能在没网/没外部程序时安全失败（返回可读原因，不抛未捕获异常）。

## ctx 可用能力

| 字段 | 说明 |
|---|---|
| `ctx.cwd` | 当前会话工作区绝对路径 |
| `ctx.resolve(p)` | 相对路径解析（越出工作区外会抛错，可用 `allowOutside:true` 第二参放行） |
| `ctx.tmp(ext?)` | 申请一个临时文件路径（在插件数据目录下） |
| `ctx.exec(cmd, args, {cwd,timeoutMs,env,input})` | 起进程，返回 `{code,stdout,stderr,timedOut}`，不抛异常 |
| `ctx.fetch(url, opts)` | 全局 fetch 的透传（带默认超时） |
| `ctx.call(name, args)` | 调用总线里另一个工具（同一指纹内），返回 `{ok,value}` |
| `ctx.config` | 插件配置（resultMaxChars 等） |
| `ctx.dataDir` | 插件数据目录（`~/.dsh/tey-mcp`） |
| `ctx.sessionId` | 会话 id |
| `ctx.truncate(text)` | 按配置截断长文本 |

## 参考实现

`src/packs/fs.js`（文件系统包）是标准答案样板，照它的风格写。
