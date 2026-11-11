#!/usr/bin/env node
/**
 * zserver — resident WebDriver BiDi bridge to a running Zen/Firefox.
 *
 * Firefox/Zen expose a local WebSocket at ws://127.0.0.1:<port>/session when
 * started with --remote-debugging-port. We keep one session open and multiplex
 * requests over it so separate shell calls share the same live browser.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const BASE = path.join(HOME, '.local/share/dsh-browser');
const SHOTS = path.join(BASE, 'shots');
const PORT = Number(process.env.ZBR_PORT || 9334);
const REMOTE_PORT = Number(process.env.ZEN_REMOTE_PORT || 9222);
const HOST = '127.0.0.1';
const WS_URL = `ws://127.0.0.1:${REMOTE_PORT}/session`;

fs.mkdirSync(SHOTS, { recursive: true });

let ws = null;
let urlMatch = null;
let tabIdMatch = null;
let connecting = null;
let nextId = 1;
const pending = new Map();
let lastError = null;
const STARTED_AT = Date.now();
let inflight = 0;
let lastAction = null;
let lastActionMs = 0;
let activeTabId = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Race a promise against a deadline; never rejects, resolves undefined. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    sleep(ms).then(() => undefined),
  ]);
}

function rejectAll(err) {
  for (const [, p] of pending) p.reject(err);
  pending.clear();
}

async function connect() {
  if (ws && ws.readyState === 1) return;
  if (connecting) return connecting;
  connecting = (async () => {
    const sock = new WebSocket(WS_URL);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout connecting to ${WS_URL}`)), 8000);
      sock.onopen = () => { clearTimeout(t); resolve(); };
      sock.onerror = () => { clearTimeout(t); reject(new Error(`cannot connect to ${WS_URL} — is Zen running with --remote-debugging-port ${REMOTE_PORT}?`)); };
    });
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.type === 'error') {
          const e = new Error(`${msg.error}: ${msg.message}`);
          e.bidiError = msg.error;
          reject(e);
        } else resolve(msg.result);
      }
    };
    sock.onclose = () => { ws = null; rejectAll(new Error('bidi session closed')); };
    ws = sock;
    // Start a session (top-level browsing contexts become visible here).
    for (let attempt = 0; ; attempt++) {
      try {
        await send('session.new', { capabilities: {} });
        break;
      } catch (e) {
        lastError = e.message;
        const busy = /already started|Maximum number of active sessions/i.test(e.message);
        if (!busy) throw e;
        if (attempt < 8) {
          // A previous socket may not have been reaped yet; nudge it, then retry.
          try { await send('session.end', {}); } catch {}
          await sleep(750);
          continue;
        }
        throw new Error(
          'a stale WebDriver session is stuck in the browser; restart Zen to clear it ' +
          `(${e.message})`
        );
      }
    }
    connecting = null;
  })();
  return connecting;
}

function send(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('not connected'));
    const id = nextId++;
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`bidi timeout: ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function rpc(method, params, timeout) {
  await connect();
  return send(method, params, timeout);
}

/** Evaluate an expression in the page and unwrap the BiDi remote value. */
async function evalIn(context, expression) {
  const res = await rpc('script.evaluate', {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: 'none',
  });
  if (res.type === 'exception') {
    const d = res.exceptionDetails || {};
    throw new Error(d.exception?.description || d.text || 'evaluation failed');
  }
  return unwrap(res.result);
}

/**
 * BiDi serializes JS objects as arrays of [key, remoteValue] pairs and arrays
 * as arrays of remoteValues. Convert back to plain JS.
 */
function unwrap(rv) {
  if (!rv || typeof rv !== 'object') return rv;
  switch (rv.type) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'array':
      return (rv.value || []).map(unwrap);
    case 'object': {
      if (rv.handle && rv.value === undefined) return rv;
      const v = rv.value;
      if (Array.isArray(v)) {
        const o = {};
        for (const pair of v) {
          if (Array.isArray(pair) && pair.length === 2) o[pair[0]] = unwrap(pair[1]);
        }
        return o;
      }
      if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = unwrap(v[k]);
        return o;
      }
      return v;
    }
    default:
      return rv.value;
  }
}

/**
 * List tabs. By default this is getTree-only: no page JS is evaluated, so a
 * busy/hung tab can never block `status` or `tabs`. Titles are opt-in and each
 * lookup is raced against a short deadline.
 */
async function tabs({ withTitles = false } = {}) {
  const { contexts = [] } = await rpc('browsingContext.getTree', { maxDepth: 1 }, 5000);
  const list = contexts.map((c) => ({
    id: c.context,
    url: c.url,
    title: '',
    userContext: c.userContext,
  }));
  if (withTitles) {
    await Promise.all(list.map(async (t) => {
      const title = await withTimeout(evalIn(t.id, 'document.title').catch(() => ''), 900);
      t.title = title || '';
    }));
  }
  return list;
}

/** Resolve a tab by id, URL substring, index, or the currently visible tab. */
async function ctx(index, tabId) {
  const list = await tabs();
  if (!list.length) throw new Error('no tabs');
  const wantedId = tabId || tabIdMatch;
  if (wantedId) {
    const t = list.find((x) => x.id === wantedId) ||
      list.find((x) => String(x.id).startsWith(String(wantedId)));
    if (!t) throw new Error(`no tab id: ${wantedId}`);
    activeTabId = t.id;
    return t.id;
  }
  if (urlMatch) {
    let t = list.find((x) => (x.url || '').includes(urlMatch));
    if (!t) {
      // Fall back to titles, but never let a busy tab hang the lookup.
      const titled = await tabs({ withTitles: true });
      t = titled.find((x) => (x.title || '').includes(urlMatch));
    }
    if (!t) throw new Error(`no tab matching: ${urlMatch}`);
    activeTabId = t.id;
    return t.id;
  }
  if (index === undefined || index === null) {
    if (activeTabId && list.some((x) => x.id === activeTabId)) return activeTabId;
    for (const t of list) {
      const vis = await withTimeout(evalIn(t.id, 'document.visibilityState').catch(() => 'hidden'), 500);
      if (vis === 'visible') { activeTabId = t.id; return t.id; }
    }
    activeTabId = list[0].id;
    return list[0].id;
  }
  const t = list[Number(index)];
  if (!t) throw new Error(`no tab #${index} (have ${list.length})`);
  activeTabId = t.id;
  return t.id;
}

/** Collapse repeated text blocks (SSR + SPA render can yield the same body twice). */
function dedupeText(text) {
  const blocks = String(text || '')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const b of blocks) {
    const key = b.replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out.join('\n\n');
}

async function summary(id, max = 6000, { dedupe = true, waitStable = false } = {}) {
  let text = '';
  let url = '';
  let title = '';
  for (let attempt = 0; attempt < (waitStable ? 4 : 1); attempt++) {
    const prev = text;
    [url, title] = await Promise.all([
      evalIn(id, 'location.href').catch(() => ''),
      evalIn(id, 'document.title').catch(() => ''),
    ]);
    const raw = await evalIn(id, `(() => { const el = document.querySelector('main, article, [role=main]') || document.body; return el ? el.innerText : ''; })()`).catch(() => '');
    text = String(raw || '');
    if (!waitStable) break;
    if (text.length > 0 && text.length === prev.length) break;
    await sleep(350);
  }
  let clean = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
  if (dedupe) clean = dedupeText(clean);
  const list = await tabs();
  return {
    tab: list.findIndex((t) => t.id === id),
    tabId: id,
    url,
    title,
    text: clean.length > max ? clean.slice(0, max) : clean,
    truncated: clean.length > max,
    chars: clean.length,
  };
}

/**
 * Navigate and wait for DOMContentLoaded by default. Heavy SPAs may never fire
 * `complete`, so that mode is opt-in and a timeout is treated as success.
 */
async function navigate(id, url, { waitComplete = false } = {}) {
  const wait = waitComplete ? 'complete' : 'interactive';
  try {
    await rpc('browsingContext.navigate', { context: id, url, wait }, waitComplete ? 45000 : 20000);
  } catch (e) {
    if (!/timeout/i.test(e.message)) throw e;
    lastError = `${e.message} (page still loading; returning current state)`;
  }
  await sleep(250);
}

/** JS snippet that locates an element by CSS selector or visible text. */
function finder(target) {
  const t = JSON.stringify(target);
  return `(() => {
    const target = ${t};
    const looksCss = /^[.#\\[]|^[a-z][a-z0-9-]*\\s*[.#\\[:]|\\[.*=.*\\]|:has\\(|>>/i.test(target);
    if (looksCss) { try { const e = document.querySelector(target); if (e) return e; } catch {} }
    const all = [...document.querySelectorAll('a,button,input,textarea,select,label,summary,[role=button],[role=link],[role=tab],[contenteditable=true],h1,h2,h3,h4,td,li,span,div,p')];
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    let hit = all.find((e) => vis(e) && norm(e.innerText || e.value || e.getAttribute('aria-label')) === target);
    if (hit) return hit;
    hit = all.filter((e) => vis(e) && norm(e.innerText || e.value || e.getAttribute('aria-label')).includes(target))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    return hit || null;
  })()`;
}

async function probe(id, target) {
  const expr = `(async () => {
    const el = ${finder(target)};
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x, y, w: r.width, h: r.height, tag: el.tagName, href: el.href || '',
      hit: !!(hit && (hit === el || el.contains(hit))),
      visible: r.width > 0 && r.height > 0,
    };
  })()`;
  const r = await evalIn(id, expr);
  if (!r) throw new Error(`element not found: ${target}`);
  if (!r.visible) throw new Error(`element not visible: ${target}`);
  return r;
}

/** DOM-level click, used for links and as a fallback when hit-testing fails. */
async function domClick(id, target) {
  return evalIn(id, `(() => { const el = ${finder(target)}; if (!el) return false; el.click(); return true; })()`);
}

const KEYMAP = {
  enter: '\uE007', tab: '\uE004', escape: '\uE00C', backspace: '\uE003',
  arrowleft: '\uE012', arrowup: '\uE013', arrowright: '\uE014', arrowdown: '\uE015',
  home: '\uE011', end: '\uE010', pageup: '\uE00E', pagedown: '\uE00F',
  delete: '\uE017', ' ': '\uE00D', control: '\uE009', shift: '\uE008', alt: '\uE00A',
};

function keyValue(k) {
  const low = String(k).toLowerCase();
  if (KEYMAP[low]) return KEYMAP[low];
  if (k.length === 1) return k;
  throw new Error(`unknown key: ${k}`);
}

async function keyActions(id, actions) {
  await rpc('input.performActions', {
    context: id,
    actions: [{ type: 'key', id: 'keyboard', actions }],
  });
  await rpc('input.releaseActions', { context: id }).catch(() => {});
}

async function clickAt(id, x, y) {
  await rpc('input.performActions', {
    context: id,
    actions: [{
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport', duration: 0 },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  });
  await rpc('input.releaseActions', { context: id }).catch(() => {});
}

async function typeText(id, text, delay = 15) {
  const actions = [];
  for (const ch of String(text)) {
    if (ch === '\n') {
      actions.push({ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' });
    } else {
      actions.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch });
    }
  }
  if (!actions.length) return;
  await rpc('input.performActions', {
    context: id,
    actions: [{ type: 'key', id: 'keyboard', actions }],
  }, 60000);
  await rpc('input.releaseActions', { context: id }).catch(() => {});
  if (delay) await sleep(Math.min(delay, 50));
}

const actions = {
  async status() {
    let list = [];
    let err = null;
    try { list = await tabs(); } catch (e) { err = e.message; }
    return {
      running: !!ws && ws.readyState === 1,
      remotePort: REMOTE_PORT,
      error: err || lastError,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      inflight: Math.max(0, inflight - 1),
      lastAction,
      lastActionMs,
      activeTabId,
      tabs: list.map((t, i) => ({
        index: i, url: t.url, id: t.id, active: t.id === activeTabId,
      })),
    };
  },

  async doctor() {
    let list = [];
    let err = null;
    try { list = await tabs(); } catch (e) { err = e.message; }
    return {
      running: !!ws && ws.readyState === 1,
      pid: process.pid,
      remotePort: REMOTE_PORT,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      inflight: Math.max(0, inflight - 1),
      lastAction,
      lastActionMs,
      lastError,
      activeTabId,
      pendingRpcs: pending.size,
      tabCount: list.length,
      tabs: list.map((t, i) => ({ index: i, id: t.id, url: t.url, active: t.id === activeTabId })),
    };
  },

  async tabs() {
    const list = await tabs({ withTitles: true });
    return { count: list.length, tabs: list.map((t, i) => ({ index: i, url: t.url, title: t.title, id: t.id, active: t.id === activeTabId })) };
  },

  async tab({ index }) {
    const id = await ctx(index);
    await rpc('browsingContext.activate', { context: id }).catch(() => {});
    activeTabId = id;
    return summary(id);
  },

  async open({ url, newTab, waitComplete, background }) {
    if (!url) throw new Error('missing url');
    if (newTab) {
      const { context: id } = await rpc('browsingContext.create', { type: 'tab', background: !!background }).catch(async () => {
        const cur = await ctx();
        await evalIn(cur, `window.open(${JSON.stringify(url)}, '_blank')`);
        await sleep(1200);
        const list = await tabs();
        return { context: list[list.length - 1].id };
      });
      await navigate(id, url, { waitComplete });
      if (!background) await rpc('browsingContext.activate', { context: id }).catch(() => {});
      activeTabId = background ? activeTabId : id;
      return summary(id);
    }
    const id = await ctx();
    await navigate(id, url, { waitComplete });
    return summary(id);
  },

  async newtab({ url, waitComplete, background }) {
    const { context: id } = await rpc('browsingContext.create', { type: 'tab', background: !!background });
    if (url) await navigate(id, url, { waitComplete });
    if (!background) await rpc('browsingContext.activate', { context: id }).catch(() => {});
    activeTabId = background ? activeTabId : id;
    return summary(id);
  },

  /** Abort whatever a tab is loading. Much safer than killing the bridge. */
  async stop({ index }) {
    const id = await ctx(index);
    try {
      await rpc('browsingContext.navigate', { context: id, url: 'about:blank', wait: 'none' }, 4000);
    } catch {}
    return { ok: true, tabId: id, url: 'about:blank' };
  },

  /**
   * Run fetch() inside a normal page so the browser's cookies apply.
   * NOTE: a JSON-viewer tab has a restrictive CSP; target a normal site tab.
   */
  async fetch({ url, index, max = 200000 }) {
    if (!url) throw new Error('missing url');
    const id = await ctx(index);
    const expr = `fetch(${JSON.stringify(url)}, { credentials: 'include' })
      .then(async (r) => ({ status: r.status, ok: r.ok, ct: r.headers.get('content-type') || '', body: await r.text() }))
      .catch((e) => ({ error: String(e) }))`;
    const r = await evalIn(id, expr);
    if (!r || r.error) throw new Error(`fetch failed: ${r && r.error}`);
    const body = String(r.body || '');
    let json;
    if (/json/i.test(r.ct) || /^\s*[\[{]/.test(body)) {
      try { json = JSON.parse(body); } catch {}
    }
    return {
      status: r.status,
      ok: r.ok,
      contentType: r.ct,
      bytes: body.length,
      truncated: body.length > max,
      body: json === undefined ? body.slice(0, max) : undefined,
      json,
    };
  },

  async closeref({ index }) {
    const id = await ctx(index);
    await rpc('browsingContext.close', { context: id });
    if (activeTabId === id) activeTabId = null;
    return actions.tabs();
  },

  async back({ index }) {
    const id = await ctx(index);
    await rpc('browsingContext.traverseHistory', { context: id, delta: -1 });
    await sleep(700);
    return summary(id);
  },

  async forward({ index }) {
    const id = await ctx(index);
    await rpc('browsingContext.traverseHistory', { context: id, delta: 1 });
    await sleep(700);
    return summary(id);
  },

  async reload({ index, waitComplete }) {
    const id = await ctx(index);
    try {
      await rpc('browsingContext.reload', { context: id, wait: waitComplete ? 'complete' : 'interactive' }, waitComplete ? 45000 : 20000);
    } catch (e) {
      if (!/timeout/i.test(e.message)) throw e;
      lastError = e.message;
    }
    return summary(id);
  },

  async click({ target, index }) {
    const id = await ctx(index);
    const r = await probe(id, target);
    if (r.tag === 'A' && r.href) {
      await domClick(id, target);
    } else if (r.hit) {
      await clickAt(id, r.x, r.y);
    } else {
      await domClick(id, target);
    }
    await sleep(600);
    return summary(id);
  },

  async dblclick({ target, index }) {
    const id = await ctx(index);
    const r = await probe(id, target);
    await rpc('input.performActions', {
      context: id,
      actions: [{
        type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: Math.round(r.x), y: Math.round(r.y), origin: 'viewport' },
          { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
          { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    return summary(id);
  },

  async fill({ target, value, index }) {
    const id = await ctx(index);
    const r = await probe(id, target);
    if (r.hit) await clickAt(id, r.x, r.y);
    else await evalIn(id, `(() => { const el = ${finder(target)}; el.focus(); return true; })()`);
    // Select-all then overwrite: works for inputs and contenteditable.
    await keyActions(id, [
      { type: 'keyDown', value: '\uE009' }, { type: 'keyDown', value: 'a' },
      { type: 'keyUp', value: 'a' }, { type: 'keyUp', value: '\uE009' },
    ]);
    await typeText(id, value ?? '');
    return { ok: true, filled: target };
  },

  async type({ text, target, index }) {
    const id = await ctx(index);
    if (target) {
      const r = await probe(id, target);
      if (r.hit) await clickAt(id, r.x, r.y);
      else await evalIn(id, `(() => { const el = ${finder(target)}; el.focus(); return true; })()`);
    }
    await typeText(id, text ?? '');
    return { ok: true };
  },

  async press({ key, index }) {
    const id = await ctx(index);
    const v = keyValue(key);
    await keyActions(id, [{ type: 'keyDown', value: v }, { type: 'keyUp', value: v }]);
    await sleep(500);
    return summary(id);
  },

  async hover({ target, index }) {
    const id = await ctx(index);
    const r = await probe(id, target);
    await rpc('input.performActions', {
      context: id,
      actions: [{
        type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
        actions: [{ type: 'pointerMove', x: Math.round(r.x), y: Math.round(r.y), origin: 'viewport' }],
      }],
    });
    return { ok: true };
  },

  async scroll({ dy = 600, index }) {
    const id = await ctx(index);
    await evalIn(id, `window.scrollBy(0, ${Number(dy)}); true`);
    await sleep(300);
    return summary(id);
  },

  async wait({ ms, target, index }) {
    const id = await ctx(index);
    if (target) {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const found = await evalIn(id, `!!(${finder(target)})`);
        if (found) return { ok: true, appeared: target };
        await sleep(400);
      }
      throw new Error(`timeout waiting for: ${target}`);
    }
    await sleep(Number(ms || 1000));
    return summary(id);
  },

  async text({ index, max, waitStable, dedupe }) {
    return summary(await ctx(index), Number(max) || 6000, {
      waitStable: !!waitStable,
      dedupe: dedupe === undefined ? true : !!dedupe,
    });
  },

  async html({ index, max = 20000 }) {
    const id = await ctx(index);
    const h = await evalIn(id, 'document.documentElement.outerHTML');
    return { url: await evalIn(id, 'location.href'), chars: h.length, html: h.slice(0, max) };
  },

  async eval({ js, index }) {
    const id = await ctx(index);
    if (!js) throw new Error('missing js');
    const result = await evalIn(id, js);
    return { result };
  },

  async shot({ index, full, path: out }) {
    const id = await ctx(index);
    const { data } = await rpc('browsingContext.captureScreenshot', {
      context: id,
      origin: full ? 'document' : 'viewport',
    });
    // BiDi always returns PNG; keep the filename honest so image viewers and
    // tooling don't guess the wrong decoder from a .jpg extension.
    let file = out ? path.resolve(out) : path.join(SHOTS, `zen-${Date.now()}.png`);
    if (!/\.png$/i.test(file)) file = file.replace(/\.(jpe?g|webp|gif|bmp)$/i, '') + '.png';
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return { path: file, format: 'png', tab: id };
  },

  async links({ index }) {
    const id = await ctx(index);
    const links = await evalIn(id, `[...document.querySelectorAll('a[href]')].slice(0, 200).map(a => ({ text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim().slice(0, 80), href: a.href }))`);
    return { count: links.length, links };
  },

  async title({ index }) {
    const id = await ctx(index);
    return { url: await evalIn(id, 'location.href'), title: await evalIn(id, 'document.title') };
  },
};

let queue = Promise.resolve();
const server = http.createServer(async (req, res) => {
  const sendRes = (code, obj) => {
    if (res.writableEnded) return;
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/health') return sendRes(200, { ok: true, pid: process.pid });
  // Convenience: status/doctor over GET, handy when the CLI itself is suspect.
  if (req.method === 'GET' && /^\/(status|doctor)(\?|$)/.test(req.url)) {
    const action = req.url.slice(1).split('?')[0];
    try { return sendRes(200, { ok: true, ...(await actions[action]()) }); }
    catch (e) { return sendRes(200, { ok: false, error: String(e.message || e) }); }
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { return sendRes(400, { ok: false, error: 'bad json' }); }

  const { action, ...args } = payload;
  const fn = actions[action];
  if (!fn) return sendRes(404, { ok: false, error: `unknown action: ${action}`, hint: 'POST {"action":"status"}' });
  const budget = Number(args.timeout || 25000);
  const run = async () => {
    urlMatch = args.urlMatch || null;
    tabIdMatch = args.tabId || null;
    inflight++;
    const t0 = Date.now();
    let timer;
    try {
      // Hard budget: a page that never settles must not hang the whole queue.
      const data = await Promise.race([
        fn(args),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            `action timed out after ${budget}ms: ${action}` +
            ' (tab may still be loading; try `zbr stop` or target another tab)'
          )), budget);
        }),
      ]);
      sendRes(200, { ok: true, ...(data && typeof data === 'object' ? data : { data }) });
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      sendRes(200, { ok: false, error: lastError });
    } finally {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      lastAction = action;
      lastActionMs = ms;
      if (ms > 3000) console.log(`[slow] ${action} ${ms}ms`);
      inflight--;
      urlMatch = null;
      tabIdMatch = null;
    }
  };
  queue = queue.then(run, run);
});

server.listen(PORT, HOST, () => {
  fs.writeFileSync(path.join(BASE, 'zserver.pid'), String(process.pid));
  console.log(`[zserver] http://${HOST}:${PORT} -> ${WS_URL} pid=${process.pid}`);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  // End the WebDriver session explicitly: Firefox keeps a leaked session alive
  // if the socket just disappears, which blocks all future connections.
  try { await send('session.end', {}, 2000); } catch {}
  try { ws && ws.close(); } catch {}
  await sleep(300);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
