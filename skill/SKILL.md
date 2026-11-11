---
name: zen-browser-control
description: 当用户要求你打开、查看、填写、点击、登录、抓取或批量操作他们本机浏览器里的网页时使用。用户用的是 Zen（Firefox 内核），必须走 zbr / WebDriver BiDi，不要用 CDP、Playwright 或系统键鼠注入。
---

# 操作本机 Zen 浏览器（WebDriver BiDi）

用户的主力浏览器是 **Zen**（Firefox 内核）。现成设施：

- 常驻桥接 `~/.local/share/dsh-browser/zserver.mjs`：HTTP `127.0.0.1:9334` → BiDi `ws://127.0.0.1:9222/session`
- 命令行 `zbr`（`~/.local/bin`，已在 PATH；源码在同一目录）
- 工作目录：`~/.local/share/dsh-browser/`

## 先做这一步

```bash
zbr doctor        # 比 status 多给 pid/uptime/inflight/lastError；任何一项异常先看它
zbr status        # running=true 且 tabs 有内容 = 可以干活
```

失败时按「排障」处理，**不要**改用 Playwright/CDP，也不要用 xdotool/ydotool/wtype。

## 命令

```bash
zbr new <url> [--wait-complete] [--background]  # 新标签；--background 不抢焦点
zbr open <url> [--new]              # 当前标签跳转，默认只等 DOMContentLoaded
zbr stop [--tab-id=id]              # 中断卡住的加载（导航到 about:blank）
zbr text [--max=6000] [--wait-stable] [--no-dedupe]
zbr eval "<js>" [--timeout=ms]      # 取任意页面数据，比读文本更准
zbr click "<选择器或可见文字>"
zbr fill "<选择器>" "<值>"          # 聚焦 + 全选 + 输入（React/Vue 表单可用）
zbr type "<文本>" [--sel=<选择器>]
zbr press Enter                     # 也可 Tab / Escape / Control+A
zbr scroll <dy> | zbr wait <ms|--sel=...>
zbr fetch <url>                     # 在页面里带 cookie fetch，返回 JSON/text
zbr shot [file] [--full]            # 永远输出 PNG；只用于视觉验收/二维码
zbr tabs | zbr links | zbr title | zbr html
zbr doctor | zbr quit
```

## 标签定位（今天最容易翻车的地方）

优先级：`--tab-id=<id>` > `--tab=<序号>` > `--url=<URL 或标题片段>` > 最近一次操作的标签。

```bash
zbr new "https://example.com"        # 记下返回的 tabId
zbr click "登录" --tab-id=5da78121   # 之后一直用它，序号漂移也不怕
zbr shot /tmp/page.png --tab-id=5da78121
```

- **调研不要抢焦点**：查资料用 `zbr new --background`，再用 `--tab-id` 操作；不要激活或切换用户正在看的标签。
- **不要依赖"当前活动标签"**：截图、取文、点击可能落到别的页。
- `new` 一定返回 `tabId`；多标签工作流里把它存进变量。
- `shot` 不指定目标时只截"最近操作的标签"，不是"你以为的那个"。

## 铁律

1. **看页面用 `text` / `eval`**。截图仅用于自制页面验收、二维码、图形验证码、样式问题；默认 PNG（服务端会自动纠正错误扩展名）。
2. **不碰系统键鼠**。禁止 xdotool/ydotool/wtype；只用浏览器协议。
3. **不要 `kill -9` zserver**。Firefox 会残留僵尸 BiDi 会话（"Maximum number of active sessions"），只能重启浏览器清掉。要停就 `zbr quit`（会先 `session.end`）。
4. **不可逆动作先确认**：支付、下单、发送消息、删除、改账号设置，先复述将要发生什么。支付宝/微信可能开了**免密支付**，点「去支付」会直接扣款。
5. **不点提交类按钮**，除非用户明确要求；不要用"按钮 disabled"当安全保障——实际经常是 `disabled=false`。
6. **第三方 SSO / OAuth 授权登录前先说一声**；不代填密码的规则同样适用于授权页。
7. **未加载标签不可见**：Zen 恢复会话时只加载当前用到的标签。要操作某页就 `zbr new <url>` 重开，cookie/登录态共用同一 profile。

## 典型流程

```bash
zbr new "https://platform.deepseek.com/usage"
sleep 3
zbr text --url=deepseek --max=800
zbr eval "location.href" --tab-id=<id>
```

判断登录：文本出现「登录 / Log in / Sign in」或 URL 跳到 `/sign_in` 即未登录，请用户手动登录。

## 多标签工作流

```bash
ID=$(zbr new "https://example.com" | python3 -c 'import sys,json;print(json.load(sys.stdin)["tabId"])')
zbr text --tab-id=$ID --wait-stable
zbr click "More information..." --tab-id=$ID
```

- 新页面优先 `new`，不要复用当前标签（会覆盖用户正在看的页面）。
- 操作完不需要的标签用 `zbr close <n>`，别留一堆。
- 页面是 file:// 时 `--url=` 只传裸词可能匹配不到，改用 `--tab-id`。

## 批量表单 / 答题

一次 `eval` 点完，再回读校验，比逐题 `click` 快且稳：

```bash
# 1) 先枚举，确认题型和 name 分组
zbr eval "(() => [...document.querySelectorAll('input')].map(e => ({name:e.name, value:e.value, type:e.type})))"

# 2) 批量点选（Vue/React 对 input.click() 有响应）
zbr eval "(async () => { /* 按 name/value 找到 input 并 .click() */ })()"

# 3) 回读校验：checked 数量 + 答题卡计数
zbr eval "(() => ({checked: document.querySelectorAll('input:checked').length}))"
```

要点：

- 只操作当前页，不要在 eval 里发大请求；
- 点完必须回读 `checked` 和页面状态，别假设成功；
- 提交按钮一律不碰。

## 抓数据（比翻页快一个数量级）

- 优先站点的公开 JSON 接口；在**正常站点标签**里 `fetch`（`zbr fetch` 或 `eval`），不要在 JSON viewer 标签里 fetch——Firefox 的 JSON 查看器有 CSP，同源也会 `NetworkError`。
- 大批量循环：结果存 `window.__pool`，分次返回摘要；单次 eval 控制在 10 秒内，否则 BiDi 会超时。
- `zbr fetch <url>` 走当前标签的 cookie，适合已登录接口；返回体过大时自己截断。

```bash
zbr fetch "https://api.example.com/list?page=1" --tab-id=$ID --timeout=20000
```

## 排障

| 现象 | 处理 |
|---|---|
| `zbr status` 超时 / 整个 CLI 卡住 | 很可能有标签在导航。先 `zbr doctor`；再 `zbr stop --tab-id=<id>` 中断加载；仍不行 `zbr quit` 后重开 |
| `zbr open` 长时间不返回 | 页面长连接，等不到 complete。默认已改为 `interactive`；仍慢就用 `zbr eval "location.href='...'"` 再 `wait` |
| `action timed out after Nms` | 单次操作超预算。加大 `--timeout`，或拆小 eval；别无限重试 |
| `element not found` | 先 `zbr text` 看真实文案；或 `zbr eval` 查 DOM |
| 点击没反应 | 确认元素可见；必要时 `zbr eval "document.querySelector(...).click()"` |
| 页面空白 / text 为空 | SPA 未渲染：`zbr text --wait-stable` 或 `sleep 2~3` |
| `Maximum number of active sessions` | 会话泄漏，重启 Zen 才能清 |
| `cannot connect ... 9222` | Zen 没带 `--remote-debugging-port 9222` 启动 |

## 排障原则

- 任何命令超过 ~10 秒没反应，先怀疑"某个标签在忙"，而不是服务坏了。
- `curl -s http://127.0.0.1:9334/status` 可以绕过 CLI 直接看桥接状态（GET 也支持 `/doctor`）。
- 不要并行发多个 zbr 命令；桥接是单队列，会互相排队。
- 改完 `zserver.mjs` 要重启桥接：`kill -TERM $(cat ~/.local/share/dsh-browser/zserver.pid)`，下一条 `zbr` 会自动拉起新进程（会先 `session.end`，浏览器不受影响）。

## 延伸

- 需要网络拦截、多标签并发等 CDP 风格能力时，BiDi 也支持 `browsingContext` / `script` / `input` / `network`，在 `zserver.mjs` 加 action 即可。
- 仓库：`https://github.com/lc-3124/zen-browser-control`
