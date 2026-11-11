#!/usr/bin/env node
/**
 * zbr — control the already-running Zen Browser (Firefox) via WebDriver BiDi.
 * Same browser, same tabs, same logins.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const BASE = path.join(HOME, '.local/share/dsh-browser');
const PORT = Number(process.env.ZBR_PORT || 9334);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const DEFAULT_TIMEOUT = Number(process.env.ZBR_TIMEOUT || 45000);

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (const a of argv) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v === undefined ? true : v;
  } else pos.push(a);
}
const cmd = pos.shift();

const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

async function health() {
  try {
    const r = await fetch(`${URL_BASE}/health`, { signal: AbortSignal.timeout(600) });
    return r.ok;
  } catch { return false; }
}

async function start() {
  if (await health()) return true;
  fs.mkdirSync(BASE, { recursive: true });
  const log = fs.openSync(path.join(BASE, 'zserver.log'), 'a');
  const child = spawn(process.execPath, [path.join(BASE, 'zserver.mjs')], {
    detached: true, stdio: ['ignore', log, log], env: process.env,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await health()) return true;
  }
  return false;
}

async function call(action, args = {}) {
  if (!(await start())) throw new Error(`service did not start; see ${BASE}/zserver.log`);
  const budget = Number(flags.timeout || DEFAULT_TIMEOUT);
  const r = await fetch(URL_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, timeout: budget, ...args }),
    signal: AbortSignal.timeout(budget + 3000),
  });
  return r.json();
}

const tabIdx = () => (flags.tab !== undefined ? Number(flags.tab) : undefined);
const tabId = () => (flags['tab-id'] !== undefined ? String(flags['tab-id']) : flags.tabId);
const urlSel = () => (flags.url !== undefined ? String(flags.url) : undefined);
const bool = (v) => v === true || v === 'true' || v === '1';

const USAGE = `zbr — control the live Zen Browser (Firefox / WebDriver BiDi)

  zbr status | doctor | tabs | tab <n> | close <n>
  zbr new <url> [--wait-complete]     open in a NEW tab (prints tabId)
  zbr open <url> [--new] [--wait-complete]
  zbr stop [--tab=n|--tab-id=id]      abort a stuck page load
  zbr back | forward | reload
  zbr click <selector|text>           --tab / --tab-id / --url
  zbr dblclick <target>
  zbr fill <selector> <value>
  zbr type <text> [--sel=selector]
  zbr press <key>                     Enter, Tab, Escape, Control+A ...
  zbr hover <target> | scroll [dy] | wait [ms|--sel=sel]
  zbr text [--max=n] [--wait-stable] [--no-dedupe]
  zbr html | links | title
  zbr eval "<js>" [--timeout=ms]
  zbr fetch <url>                     fetch() with the tab's cookies
  zbr shot [file] [--full]            always writes PNG; targets the active tab
  zbr quit                            stop the bridge (browser keeps running)

Targeting: --tab-id=<id> (best) > --tab=<n> > --url=<url substring>.
Flags: --timeout=<ms> for long operations.`;

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') return out({ ok: true, usage: USAGE });

  if (cmd === 'start') return out({ ok: await start(), port: PORT });
  if (cmd === 'quit') {
    let pid = null;
    try { pid = Number(fs.readFileSync(path.join(BASE, 'zserver.pid'), 'utf8').trim()); } catch {}
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await new Promise((r) => setTimeout(r, 500));
    return out({ ok: !(await health()), stopped: pid });
  }

  const common = { index: tabIdx(), tabId: tabId(), urlMatch: urlSel() };

  switch (cmd) {
    case 'status': return out(await call('status'));
    case 'doctor': return out(await call('doctor'));
    case 'tabs': return out(await call('tabs'));
    case 'tab': return out(await call('tab', { index: Number(pos[0]) }));
    case 'close': return out(await call('closeref', { index: Number(pos[0]) }));
    case 'new': return out(await call('newtab', { url: pos[0], waitComplete: bool(flags['wait-complete']), ...common }));
    case 'open': return out(await call('open', { url: pos[0], newTab: !!flags.new, waitComplete: bool(flags['wait-complete']), ...common }));
    case 'stop': return out(await call('stop', common));
    case 'back': return out(await call('back', common));
    case 'forward': return out(await call('forward', common));
    case 'reload': return out(await call('reload', { waitComplete: bool(flags['wait-complete']), ...common }));
    case 'click': return out(await call('click', { target: pos.join(' '), ...common }));
    case 'dblclick': return out(await call('dblclick', { target: pos.join(' '), ...common }));
    case 'fill': return out(await call('fill', { target: pos[0], value: pos.slice(1).join(' '), ...common }));
    case 'type': return out(await call('type', { text: pos.join(' '), target: flags.sel, ...common }));
    case 'press': return out(await call('press', { key: pos.join(' '), ...common }));
    case 'hover': return out(await call('hover', { target: pos.join(' '), ...common }));
    case 'scroll': return out(await call('scroll', { dy: Number(pos[0] || 600), ...common }));
    case 'wait': return out(await call('wait', { ms: pos[0], target: flags.sel, ...common }));
    case 'text': return out(await call('text', {
      max: flags.max, waitStable: bool(flags['wait-stable']),
      dedupe: flags['no-dedupe'] ? false : undefined, ...common,
    }));
    case 'html': return out(await call('html', common));
    case 'links': return out(await call('links', common));
    case 'title': return out(await call('title', common));
    case 'eval': return out(await call('eval', { js: pos.join(' '), ...common }));
    case 'fetch': return out(await call('fetch', { url: pos[0], ...common }));
    case 'shot': return out(await call('shot', { path: pos[0], full: !!flags.full, ...common }));
    default: return out({ ok: false, error: `unknown command: ${cmd}`, usage: USAGE });
  }
}

main().catch((e) => { out({ ok: false, error: String(e && e.message ? e.message : e) }); process.exit(1); });
