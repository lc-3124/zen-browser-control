# zen-browser-control

Control a **live Zen Browser** (Firefox engine) over **WebDriver BiDi** — no CDP, no
Playwright, no synthetic OS-level mouse/keyboard. Your real tabs, cookies and logins
are used as-is.

This repo contains two things that work together:

| Piece | What it is |
|---|---|
| `src/zserver.mjs` | A resident bridge: HTTP `127.0.0.1:9334` → BiDi `ws://127.0.0.1:9222/session`. Keeps one BiDi session and multiplexes commands over it. |
| `src/zbr.mjs` | `zbr`, a small CLI for status/tabs/navigation/click/type/eval/screenshot/fetch. |
| `skill/SKILL.md` | The agent-facing skill: rules, recipes, failure modes. Drop it into your agent's skill directory. |

## Requirements

- Zen (or Firefox) started with `--remote-debugging-port 9222`
- Node.js ≥ 20 (uses global `WebSocket` / `fetch`)

## Install

```bash
git clone git@github.com:lc-3124/zen-browser-control.git
cd zen-browser-control
./install.sh --restart
```

This copies the two scripts to `~/.local/share/dsh-browser/`, symlinks
`~/.local/bin/zbr`, and installs the skill to `~/.dsh/skills/zen-browser-control/`.
It does **not** touch the browser profile.

## Quick start

```bash
zbr doctor
zbr new "https://example.com"
zbr text --tab-id=<id> --wait-stable
zbr shot /tmp/example.png --tab-id=<id>
```

## What changed in this version

The first version worked but could dead-lock and mis-target tabs. This release:

- **Never hangs on page load** — `open`/`new` wait for `interactive`
  (DOMContentLoaded), not `complete`; `complete` is opt-in via `--wait-complete`.
- **Per-action hard timeout** — every request has a budget (default 45 s, override
  with `--timeout`), so a stuck tab cannot block the queue forever.
- **`status` no longer evaluates page JS** — it uses `browsingContext.getTree`
  only. A busy tab used to hang `status` too; now it can't.
- **Stable tab targeting** — `new` returns a `tabId`; every command accepts
  `--tab-id`. `--url` now matches both URL and title.
- **`zbr stop`** — aborts a stuck navigation by going to `about:blank`, without
  killing the bridge or the browser.
- **Screenshots are always PNG** — `.jpg`/`.webp` paths are rewritten to `.png`,
  so image tooling stops guessing the wrong decoder.
- **Text quality** — duplicate blocks are collapsed (SSR + SPA double render),
  `--wait-stable` polls until the text stops changing.
- **`zbr fetch <url>`** — runs `fetch` inside a normal page so cookies apply.
- **`zbr doctor`** — pid, uptime, RSS, in-flight action, last error, tab list.
- Skill doc rewritten with multi-tab, batch-form and data-scraping recipes plus a
  real troubleshooting tree.

## Architecture

```
zbr CLI ──HTTP POST──▶ zserver ──WebSocket BiDi──▶ Zen
   │                      │
   └── auto-starts ───────┘  (single session, serialized queue)
```

The bridge owns one `session.new`. BiDi is single-session per browser, so the
server serializes actions; do not run zbr commands in parallel.

## Safety notes

- Never `kill -9` the bridge: Firefox keeps a leaked BiDi session and later
  connections fail with *Maximum number of active sessions*. Use `zbr quit`.
- Irreversible actions (pay, order, send, delete, account settings) need explicit
  confirmation. A disabled-looking submit button is not a safety net.
- Third-party SSO/OAuth logins are account actions — announce them first.

## License

MIT
