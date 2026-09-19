'use strict';

/*
 * Dola task runner (local only) — probe / submit / poll / download.
 *
 * Runs inside Electron so the account's own persistent partition is used as-is:
 * no cookie export, no token handling, no fingerprint spoofing. Default mode is
 * read-only probe. Submitting requires an explicit --submit flag plus the
 * duration the account is allowed to request.
 *
 * Usage:
 *   node_modules/.bin/electron tools/dola-task.js probe  --account "Dola 3"
 *   node_modules/.bin/electron tools/dola-task.js submit --account "Dola 3" \
 *       --duration 30 --prompt-file ../../../user-data/prompts/p.txt --submit
 *
 * Local artifacts (gitignored): captures/raw/dola-task-<day>.jsonl, outputs/.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DOLA_CHAT_URL = 'https://www.dola.com/chat/';
const SENSITIVE_PARAM_RE = /(cookie|token|sign|mstoken|verifyfp|s_v_web_id|ttwid|sessionid|license)/i;
const SENSITIVE_JSON_KEY_RE = /("(?:[^"]*(?:cookie|token|authorization|password|sessionid)[^"]*)"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|null|true|false|\d+)/gi;
const STATIC_ASSET_RE = /\.(?:js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm)(?:$|[?#])/i;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

function appUserDataRoot() {
  if (args['profile-root']) return path.resolve(String(args['profile-root']));
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'seedance-desktop-studio');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'seedance-desktop-studio');
  }
  return path.join(os.homedir(), '.config', 'seedance-desktop-studio');
}

function loadAccounts(root) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'accounts.json'), 'utf8'));
  return Array.isArray(raw.accounts) ? raw.accounts : [];
}

function pickAccount(accounts) {
  const wanted = args.account ? String(args.account) : '';
  if (!wanted) return accounts[0] || null;
  return accounts.find(item => item.name === wanted)
    || accounts.find(item => item.id === wanted)
    || null;
}

function scratchRoot() {
  return path.resolve(String(args['scratch-root'] || path.join(REPO_ROOT, 'user-data', 'dola-scratch')));
}

// Copy the account partition plus the profile-level Local State (os_crypt key)
// into a scratch userData dir so the running desktop app keeps its locks.
// --live skips the copy and uses the app userData dir directly; only valid while
// the desktop app is closed, because Chromium takes an exclusive profile lock.
function stageScratchProfile(root, account) {
  const partitionName = `dola_${account.id}`;
  if (args.live === true) {
    return { dest: root, partitionName, partition: `persist:${partitionName}` };
  }
  const dest = scratchRoot();
  ensureDir(dest);
  const localState = path.join(root, 'Local State');
  if (fs.existsSync(localState)) fs.copyFileSync(localState, path.join(dest, 'Local State'));
  const src = path.join(root, 'Partitions', partitionName);
  if (!fs.existsSync(src)) throw new Error(`missing partition: ${src}`);
  const skip = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary']);
  const destPartition = path.join(dest, 'Partitions', partitionName);
  fs.rmSync(destPartition, { recursive: true, force: true });
  fs.cpSync(src, destPartition, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(src, source);
      if (!rel) return true;
      return !skip.has(rel.split(path.sep)[0]);
    }
  });
  return { dest, partitionName, partition: `persist:${partitionName}` };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_PARAM_RE.test(key)) parsed.searchParams.set(key, '<redacted>');
    }
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return String(rawUrl || '').split('?')[0];
  }
}

function sanitizeBody(raw, limit = 8192) {
  if (raw === undefined || raw === null) return null;
  return String(raw).replace(SENSITIVE_JSON_KEY_RE, '$1"<redacted>"').slice(0, limit);
}

let captureFile = null;
function appendCapture(record) {
  try {
    if (!captureFile) {
      const dir = path.join(REPO_ROOT, 'captures', 'raw');
      ensureDir(dir);
      captureFile = path.join(dir, `dola-task-${new Date().toISOString().slice(0, 10)}.jsonl`);
    }
    fs.appendFileSync(captureFile, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (_) {
    // observation must never break the run
  }
}

const recentBodies = [];
let requestPatcher = null;

// Rewrite `duration` inside the outgoing Create Videos envelope. The envelope
// nests the skill payload as a JSON string in chat_ability.ability_param.
function patchCompletionEnvelope(postData, duration) {
  let outer;
  try {
    outer = JSON.parse(postData);
  } catch (_) {
    return null;
  }
  let changed = false;
  const ability = outer && outer.chat_ability;
  if (ability && typeof ability.ability_param === 'string') {
    try {
      const param = JSON.parse(ability.ability_param);
      if (Number(param.duration) !== Number(duration)) {
        param.duration = Number(duration);
        ability.ability_param = JSON.stringify(param);
        changed = true;
      }
    } catch (_) { /* leave untouched */ }
  }
  return changed ? JSON.stringify(outer) : null;
}

function installRequestPatcher(wc) {
  const dbg = wc.debugger;
  try {
    dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*chat/completion*', requestStage: 'Request' }] });
  } catch (error) {
    appendCapture({ ts: new Date().toISOString(), event: 'patcher_enable_failed', error: String((error && error.message) || error) });
    return;
  }
  dbg.on('message', async (_event, method, params) => {
    if (method !== 'Fetch.requestPaused' || !params) return;
    let patched = null;
    try {
      patched = patchCompletionEnvelope(params.request.postData || '', requestPatcher.duration);
    } catch (_) { /* fall through and forward the original */ }
    try {
      if (patched) {
        await dbg.sendCommand('Fetch.continueRequest', {
          requestId: params.requestId,
          postData: Buffer.from(patched, 'utf8').toString('base64')
        });
        appendCapture({
          ts: new Date().toISOString(),
          event: 'request_patched',
          url: sanitizeUrl(params.request.url),
          duration: requestPatcher.duration,
          patchedAbility: (() => {
            try { return JSON.parse(JSON.parse(patched).chat_ability.ability_param); } catch (_) { return null; }
          })()
        });
      } else {
        await dbg.sendCommand('Fetch.continueRequest', { requestId: params.requestId });
      }
    } catch (error) {
      appendCapture({ ts: new Date().toISOString(), event: 'patcher_continue_failed', error: String((error && error.message) || error) });
    }
  });
}

// Page-level patcher: wraps window.fetch *outside* the app's own interceptor, so
// the rewrite happens before the client serialises/signs the request.
function installPagePatcherScript(spec) {
  return `(() => {
    if (window.__dolaPatcher) return { installed: false, reason: 'already installed' };
    const spec = ${JSON.stringify(spec)};
    const orig = window.fetch;
    window.__dolaPatcher = { installed: true, patched: 0, last: null, error: null };
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/chat/completion') !== -1 && init && typeof init.body === 'string') {
          const outer = JSON.parse(init.body);
          let changed = false;
          if (spec.duration && outer.chat_ability && typeof outer.chat_ability.ability_param === 'string') {
            const param = JSON.parse(outer.chat_ability.ability_param);
            if (Number(param.duration) !== Number(spec.duration)) {
              param.duration = Number(spec.duration);
              outer.chat_ability.ability_param = JSON.stringify(param);
              changed = true;
            }
          }
          if (spec.text && Array.isArray(outer.messages)) {
            for (const message of outer.messages) {
              for (const block of (message.content_block || [])) {
                const textBlock = block.content && block.content.text_block;
                if (textBlock && typeof textBlock.text === 'string' && textBlock.text.indexOf(spec.text.from) !== -1) {
                  textBlock.text = textBlock.text.split(spec.text.from).join(spec.text.to);
                  changed = true;
                }
              }
            }
          }
          if (changed) {
            init = Object.assign({}, init, { body: JSON.stringify(outer) });
            window.__dolaPatcher.patched += 1;
            window.__dolaPatcher.last = { url: url.slice(0, 120), duration: spec.duration || null };
          }
        }
      } catch (error) {
        window.__dolaPatcher.error = String((error && error.message) || error);
      }
      return orig.call(this, input, init);
    };
    return { installed: true };
  })()`;
}

function decodeMaybeBase64(value) {
  if (!/^[A-Za-z0-9+/=]{32,}$/.test(value)) return value;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return /^https?:\/\//.test(decoded) ? decoded : value;
  } catch (_) {
    return value;
  }
}

function normalizeMediaUrl(url) {
  return decodeMaybeBase64(String(url)).replace(/\\u0026/g, '&').replace(/\\\//g, '/');
}

function findMediaUrl(sinceTs) {
  const since = sinceTs ? Date.parse(sinceTs) : 0;
  const patterns = [
    /"download_url"\s*:\s*"(https?:[^"]+)"/,
    /"main_url"\s*:\s*"([A-Za-z0-9+/=]{32,})"/,
    /"original_media_info"\s*:\s*\{[^}]*?"main_url"\s*:\s*"([^"]+)"/,
    /"(?:main_url|video_url|play_url)"\s*:\s*"(https?:[^"]+)"/,
    /"(?:main_url|video_url|play_url|url)"\s*:\s*"([^"]*?\.mp4[^"]*)"/
  ];
  for (let i = recentBodies.length - 1; i >= 0; i -= 1) {
    const entry = recentBodies[i];
    // bodies captured before this submit belong to earlier conversations
    if (since && Date.parse(entry.ts) < since) continue;
    const body = entry.body || '';
    if (!/(\.mp4|media_info|video_url|video_duration|download_url)/i.test(body)) continue;
    for (const re of patterns) {
      const match = body.match(re);
      if (match && match[1]) return normalizeMediaUrl(match[1]);
    }
    const loose = body.match(/https:[^"'\s\\]+?\.mp4[^"'\s\\]*/);
    if (loose) return normalizeMediaUrl(loose[0]);
  }
  return null;
}

function observeWebContents(wc) {
  const dbg = wc.debugger;
  if (!dbg || dbg.isAttached()) return;
  try {
    dbg.attach('1.3');
  } catch (_) {
    return;
  }
  const urlByRequest = new Map();
  const mimeByRequest = new Map();
  try {
    dbg.sendCommand('Network.enable', { maxPostDataSize: 1048576 });
  } catch (_) { /* ignore */ }
  dbg.on('message', async (_event, method, params) => {
    if (!params) return;
    const ts = new Date().toISOString();
    if (method === 'Network.requestWillBeSent') {
      const req = params.request || {};
      urlByRequest.set(params.requestId, req.url);
      recentRequestUrls.push(req.url);
      if (recentRequestUrls.length > 400) recentRequestUrls.shift();
      if (!/dola\.com/i.test(req.url) || STATIC_ASSET_RE.test(req.url)) return;
      let body = req.postData !== undefined ? sanitizeBody(req.postData) : null;
      if (body === null && req.hasPostData === true) {
        try {
          const post = await dbg.sendCommand('Network.getRequestPostData', { requestId: params.requestId });
          body = sanitizeBody(post.postData);
        } catch (_) { /* buffer gone */ }
      }
      appendCapture({ ts, event: 'request', requestId: params.requestId, method: req.method, url: sanitizeUrl(req.url), resourceType: params.type || null, body });
    } else if (method === 'Network.responseReceived') {
      const res = params.response || {};
      mimeByRequest.set(params.requestId, res.mimeType || null);
      if (!/dola\.com/i.test(res.url || '')) return;
      appendCapture({ ts, event: 'response', requestId: params.requestId, status: res.status, mimeType: res.mimeType || null, url: sanitizeUrl(res.url) });
    } else if (method === 'Network.loadingFinished') {
      const rawUrl = urlByRequest.get(params.requestId) || '';
      const mimeType = mimeByRequest.get(params.requestId) || '';
      if (!rawUrl || !/dola\.com/i.test(rawUrl) || STATIC_ASSET_RE.test(rawUrl)) return;
      if (!/json|event-stream|text\/plain/i.test(mimeType)) return;
      try {
        const result = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
        recentBodies.push({ ts, url: rawUrl, mimeType, body });
        if (recentBodies.length > 300) recentBodies.shift();
        appendCapture({ ts, event: 'response_body', requestId: params.requestId, url: sanitizeUrl(rawUrl), mimeType, body: sanitizeBody(body, 2097152) });
      } catch (error) {
        appendCapture({ ts, event: 'dbg_get_body_failed', requestId: params.requestId, url: sanitizeUrl(rawUrl), error: String((error && error.message) || error) });
      }
    }
  });
}

// --- page-side helpers (executed in the Dola page context) ---

const PAGE_HELPERS = `
window.__dola = {
  q: (sel) => Array.from(document.querySelectorAll(sel)),
  visible: (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  },
  label: (el) => ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 90),
  api: async (url, body, extraHeaders) => {
    const headers = Object.assign({ 'content-type': 'application/json' }, extraHeaders || {});
    const res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  },
  apiGet: async (url) => {
    const res = await fetch(url, { method: 'GET', credentials: 'include' });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  }
};
window.__dola.base = (() => {
  const p = new URLSearchParams(location.search);
  const keep = ['aid','real_aid','version_code','pc_version','doubao_pc_version','device_platform','doubao_device_platform','language','region','sys_region','tz_name','samantha_web','use-olympus-account','pkg_type','device_id','web_id','tea_uuid','fp','web_platform','web_tab_id'];
  const out = new URLSearchParams();
  for (const k of keep) { const v = p.get(k); if (v) out.set(k, v); }
  if (!out.get('device_id')) {
    const m = document.cookie.match(/ttwid=([^;]+)/);
    if (m) out.set('ttwid', m[1]);
  }
  return out;
})();
window.__dola.qs = (extra) => {
  const p = new URLSearchParams(window.__dola.base);
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
  return '?' + p.toString();
};
window.__dola.uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
window.__dola.im = async (endpoint, cmd, uplinkBody) => {
  return await window.__dola.api('https://www.dola.com/im/' + endpoint + window.__dola.qs(),
    { cmd, uplink_body: uplinkBody, sequence_id: window.__dola.uuid(), channel: 2, version: '1' });
};
true;
`;

async function evaluate(wc, code) {
  return await wc.executeJavaScript(code, true);
}

async function pageApi(wc, url, body) {
  const payload = JSON.stringify(body);
  const script = `window.__dola.api(${JSON.stringify(url)}, ${payload})`;
  return await evaluate(wc, script);
}

function loginStateScript() {
  return `(() => {
    const hits = [];
    const needles = /(log ?in|sign ?in|đăng nhập|登录)/i;
    for (const el of window.__dola.q('button,[role=button],a')) {
      if (!window.__dola.visible(el)) continue;
      const t = window.__dola.label(el);
      if (t && needles.test(t)) hits.push(t);
    }
    return {
      href: location.href,
      title: document.title,
      loginHits: hits.slice(0, 6),
      hasComposer: window.__dola.q('[contenteditable=true],textarea').some(el => window.__dola.visible(el)),
      bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 600)
    };
  })()`;
}

function skillInventoryScript() {
  return `(() => {
    const out = { buttons: [], editables: [], durationMentions: [] };
    for (const el of window.__dola.q('button,[role=button],[role=menuitem],[class*=skill],[class*=Skill],[class*=tool]')) {
      if (!window.__dola.visible(el)) continue;
      const t = window.__dola.label(el);
      if (!t) continue;
      out.buttons.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || null, text: t, cls: (el.className && String(el.className).slice(0, 80)) || null });
      if (out.buttons.length > 120) break;
    }
    for (const el of window.__dola.q('[contenteditable=true],textarea')) {
      if (!window.__dola.visible(el)) continue;
      out.editables.push({ tag: el.tagName.toLowerCase(), cls: (el.className && String(el.className).slice(0, 80)) || null, placeholder: el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || null });
    }
    const re = /(\\b\\d{1,2}\\s?(?:s|sec|seconds|giây|秒)\\b|\\d{1,2}s)/gi;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.nodeValue || '').trim();
      if (!text || text.length > 40) continue;
      if (!re.test(text)) continue;
      const parent = node.parentElement;
      if (!parent || !window.__dola.visible(parent)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.durationMentions.push(text);
      if (out.durationMentions.length > 40) break;
    }
    return out;
  })()`;
}

// Shared page-side description of the composer / open panel area.
function describePanelScript() {
  return `(() => {
    const shortTexts = [];
    for (const el of window.__dola.q('button,[role=button],[role=radio],[role=menuitem],[role=option],[role=tab],li,span,div,p')) {
      if (!window.__dola.visible(el)) continue;
      if (el.children.length > 0 && !el.getAttribute('role')) continue;
      const t = window.__dola.label(el);
      if (!t || t.length > 48) continue;
      shortTexts.push(t);
    }
    const uniq = [...new Set(shortTexts)];
    const composer = window.__dola.q('[contenteditable=true],textarea').find(el => window.__dola.visible(el));
    let composerBox = null;
    if (composer) {
      const r = composer.getBoundingClientRect();
      composerBox = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return {
      href: location.href,
      composerBox,
      fileInputs: window.__dola.q('input[type=file]').map(el => ({ accept: el.getAttribute('accept'), multiple: el.multiple === true, visible: window.__dola.visible(el) })),
      iconButtons: window.__dola.q('button,[role=button],label').filter(el => window.__dola.visible(el)).map(el => {
        const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        return aria ? { aria, cls: String(el.className || '').slice(0, 60) } : null;
      }).filter(Boolean).slice(0, 60),
      attachHints: [...new Set(window.__dola.q('button,[role=button],label,div,span').filter(el => window.__dola.visible(el)).map(el => el.getAttribute('aria-label') || window.__dola.label(el)).filter(t => t && /upload|attach|ảnh|image|frame|reference/i.test(t) && t.length < 40))].slice(0, 40),
      bodyText: (document.body.innerText || '').replace(/\\n{2,}/g, '\\n').slice(0, 3000),
      chips: uniq.slice(0, 200)
    };
  })()`;
}

function clickByTextScript(text, exact) {
  return `(async () => {
    const needle = ${JSON.stringify(text)};
    const match = window.__dola.q('button,[role=button],a,[role=tab],[role=menuitem],div,span')
      .filter(el => window.__dola.visible(el))
      .filter(el => {
        const t = window.__dola.label(el).trim();
        return ${exact ? 'true' : 'false'} ? t === needle : t.includes(needle);
      })
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
    if (!match.length) return { clicked: false, reason: 'not found', needle };
    const el = match[0];
    el.click();
    await new Promise(r => setTimeout(r, 3500));
    return { clicked: true, text: window.__dola.label(el) };
  })()`;
}

function elementBoxScript(text, exact) {
  return `(() => {
    const needle = ${JSON.stringify(text)};
    const match = window.__dola.q('button,[role=button],a,[role=tab],[role=menuitem],[role=radio],div,span,p')
      .filter(el => window.__dola.visible(el) && el.children.length <= 2)
      .filter(el => {
        const t = window.__dola.label(el).trim();
        return ${exact ? 'true' : 'false'} ? t === needle : t.includes(needle);
      })
      .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
    if (!match.length) return null;
    const el = match[0];
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: window.__dola.label(el), w: Math.round(r.width), h: Math.round(r.height) };
  })()`;
}

// Radix-style poppers listen to real pointer events, so drive the window with
// CDP input instead of element.click().
async function trustedClickAt(wc, text, exact) {
  const box = await evaluate(wc, elementBoxScript(text, exact));
  if (!box) return { clicked: false, reason: 'not found', needle: text };
  const dbg = wc.debugger;
  const common = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
  await sleep(60);
  await dbg.sendCommand('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, common));
  await sleep(40);
  await dbg.sendCommand('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, common));
  return { clicked: true, at: box };
}

function findStreamError() {
  for (let i = recentBodies.length - 1; i >= 0; i -= 1) {
    const body = recentBodies[i].body || '';
    if (!/STREAM_ERROR/.test(body)) continue;
    const match = body.match(/event:\s*STREAM_ERROR\s*\ndata:\s*(\{[^\n]*\})/);
    return match ? match[1] : 'STREAM_ERROR (payload truncated)';
  }
  return null;
}

function mediaInventoryScript() {
  return `(() => {
    const out = { videos: [], images: [], actions: [], messages: [] };
    for (const el of window.__dola.q('video')) {
      const sources = [];
      if (el.src) sources.push(el.src);
      for (const s of el.querySelectorAll('source')) if (s.src) sources.push(s.src);
      out.videos.push({ sources: sources.map(u => u.slice(0, 300)), poster: el.poster ? el.poster.slice(0, 300) : null, w: el.videoWidth, h: el.videoHeight, duration: Number.isFinite(el.duration) ? el.duration : null });
    }
    for (const el of window.__dola.q('img')) {
      const src = el.currentSrc || el.src || '';
      if (!/flow-image-sign|\.(mp4|jpg|jpeg|png|webp)/i.test(src)) continue;
      if (!window.__dola.visible(el)) continue;
      out.images.push({ src: src.slice(0, 240), w: el.naturalWidth, h: el.naturalHeight });
      if (out.images.length > 25) break;
    }
    for (const el of window.__dola.q('button,[role=button],a')) {
      if (!window.__dola.visible(el)) continue;
      const t = window.__dola.label(el);
      if (!/download|tải|save|lưu/i.test(t)) continue;
      const r = el.getBoundingClientRect();
      out.actions.push({ text: t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    }
    return out;
  })()`;
}

function recentConvScript() {
  return `window.__dola.im('chain/recent_conv', 3200, { pull_recent_conv_chain_uplink_body: { limit: 20, message_count_per_conv: 0, api_version: 1, conv_version: 0, direction: 3, option: { not_need_message: true, need_complete_conversation: true, need_coco_bot: true, need_pc_pin_chain: true, pc_pin_query_type: 0, exclude_archive: true, only_archive: false } } })`;
}

function skillPackScript() {
  return `window.__dola.api('https://www.dola.com/samantha/skill/pack' + window.__dola.qs(), { skill_type: 17 })`;
}

function summarizeRecentConv(text) {
  try {
    const parsed = JSON.parse(text);
    const body = parsed && (parsed.downlink_body || parsed.data || parsed);
    const chain = body && (body.pull_recent_conv_chain_downlink_body || body);
    const convs = (chain && (chain.conversations || chain.conv_list || chain.chains)) || [];
    return convs.slice(0, 5).map((conv) => ({
      conversation_id: conv.conversation_id || conv.conv_id || null,
      updated: conv.updated_time || conv.update_time || null,
      last_message_index: conv.last_message_index ?? null,
      last_section_id: conv.last_section_id || null,
      bot_id: conv.bot_id || null,
      title: String(conv.title || conv.conversation_title || '').slice(0, 60) || null
    }));
  } catch (_) {
    return [];
  }
}

function normalizeLocalPath(input) {
  let value = String(input || '').trim();
  // accept git-bash style /d/projects/... and quoted windows paths
  const msv = value.match(/^\/([a-zA-Z])\/(.*)$/);
  if (msv) value = `${msv[1].toUpperCase()}:/${msv[2]}`;
  return path.resolve(value);
}

// Raw request URLs seen this session (in memory only, never written to disk).
// Used as a template so page-context API calls carry the app's own query params.
const recentRequestUrls = [];

function newestRequestUrl(match) {
  for (let i = recentRequestUrls.length - 1; i >= 0; i -= 1) {
    if (match.test(recentRequestUrls[i])) return recentRequestUrls[i];
  }
  return null;
}

function chainQueryBody(conversationId) {
  return {
    cmd: 3100,
    uplink_body: {
      pull_singe_chain_uplink_body: {
        conversation_id: String(conversationId),
        anchor_index: 9007199254740991,
        conversation_type: 3,
        direction: 1,
        limit: 30,
        ext: {},
        filter: { index_list: [] },
        evaluate_ab_params: '',
        evaluate_common_params: ''
      }
    },
    sequence_id: crypto.randomUUID(),
    channel: 2,
    version: '1'
  };
}

function extractVideoFromMessages(body) {
  const clean = String(body || '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const duration = (clean.match(/"video_duration"\s*:\s*([0-9.]+)/) || [])[1] || null;
  const mainB64 = (clean.match(/"main_url"\s*:\s*"([A-Za-z0-9+/=]{32,})"/) || [])[1] || null;
  const download = (clean.match(/"download_url"\s*:\s*"(https?:[^"]+)"/) || [])[1] || null;
  const vid = (clean.match(/"vid"\s*:\s*"(v[0-9a-z]+)"/) || [])[1] || null;
  const ready = /video is ready/i.test(clean);
  const errorText = (clean.match(/"text":"([^"]{0,240}(?:went wrong|credits|failed|sorry|unable)[^"]{0,240})"/i) || [])[1] || null;
  return {
    ready,
    duration,
    vid,
    mainUrl: mainB64 ? normalizeMediaUrl(mainB64) : null,
    downloadUrl: download ? normalizeMediaUrl(download) : null,
    errorText
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function out(label, value) {
  process.stdout.write(`\n[${label}] ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const command = args._[0] || 'probe';
  const root = appUserDataRoot();
  const accounts = loadAccounts(root);
  const account = pickAccount(accounts);
  if (!account) throw new Error(`no matching account in ${path.join(root, 'accounts.json')}`);
  out('account', { id: account.id, name: account.name, partition: account.partition });

  if (args['list-accounts']) {
    out('accounts', accounts.map(item => ({ id: item.id, name: item.name })));
    return;
  }

  if (command === 'import-cookies') {
    // Runs before any webview exists: writes the supplied cookie list into a
    // partition (new one with --create, otherwise the selected account).
    const accountName = String(args.name || 'Dola import');
    const cookieFile = args['cookies-file'] ? normalizeLocalPath(args['cookies-file']) : null;
    if (!cookieFile || !fs.existsSync(cookieFile)) throw new Error('--cookies-file is required');
    const parsed = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.cookies) ? parsed.cookies : []);
    const userDataDir = args.live === true ? root : stageScratchProfile(root, account).dest;
    app.setPath('userData', userDataDir);
    const list = loadAccounts(root);
    let target = args.create === true ? null : list.find(item => item.name === accountName);
    if (!target) {
      const id = crypto.randomUUID().replace(/-/g, '');
      target = { id, name: accountName, partition: `persist:dola_${id}`, createdAt: Date.now() };
      list.push(target);
      fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify({ accounts: list }, null, 2), 'utf8');
      out('account_created', { id: target.id, name: target.name });
    }
    const ses = require('electron').session.fromPartition(target.partition);
    let imported = 0;
    let skipped = 0;
    for (const entry of entries) {
      const name = String(entry.name || '').trim();
      const value = String(entry.value || '');
      let domain = String(entry.domain || '').toLowerCase().trim();
      if (!name || !value || !domain.endsWith('.dola.com')) { skipped += 1; continue; }
      if (!domain.startsWith('.')) domain = `.${domain}`;
      const rawSameSite = entry.sameSite == null ? 'unspecified' : String(entry.sameSite).toLowerCase();
      const sameSite = ['unspecified', 'no_restriction', 'lax', 'strict'].includes(rawSameSite) ? rawSameSite : 'unspecified';
      const details = {
        url: 'https://www.dola.com',
        name,
        value,
        domain,
        path: String(entry.path || '/') || '/',
        secure: entry.secure !== false,
        httpOnly: entry.httpOnly === true,
        sameSite
      };
      if (entry.session !== true && Number.isFinite(Number(entry.expirationDate))) details.expirationDate = Number(entry.expirationDate);
      try {
        await ses.cookies.set(details);
        imported += 1;
      } catch (_) {
        skipped += 1;
      }
    }
    out('import', { account: target.name, partition: target.partition, imported, skipped });
    appendCapture({ ts: new Date().toISOString(), event: 'cookies_imported', account: target.name, imported, skipped, names: entries.map(e => e.name) });
    return;
  }

  const staged = stageScratchProfile(root, account);
  out('scratch', { userData: staged.dest, partition: staged.partition });
  app.setPath('userData', staged.dest);

  const win = new BrowserWindow({
    show: args.visible === true,
    width: 1400,
    height: 950,
    title: `dola-task ${command}`,
    webPreferences: {
      partition: staged.partition,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  observeWebContents(win.webContents);
  const patchMode = args['patch-mode'] ? String(args['patch-mode']) : 'page';
  if (args['patch-duration'] && patchMode === 'cdp') {
    requestPatcher = { duration: Number(args['patch-duration']) };
    installRequestPatcher(win.webContents);
    out('patcher', { mode: 'cdp', duration: requestPatcher.duration, scope: '*chat/completion*' });
  }

  await win.loadURL(DOLA_CHAT_URL);
  await sleep(Number(args['boot-ms'] || 9000));
  await evaluate(win.webContents, PAGE_HELPERS);

  if ((args['patch-duration'] || args['patch-text']) && patchMode === 'page') {
    const spec = {};
    if (args['patch-duration']) spec.duration = Number(args['patch-duration']);
    if (args['patch-text']) {
      const [from, to] = String(args['patch-text']).split('=>');
      spec.text = { from, to: to === undefined ? '' : to };
    }
    const result = await evaluate(win.webContents, installPagePatcherScript(spec));
    out('patcher', { mode: 'page', spec, result });
  }

  const login = await evaluate(win.webContents, loginStateScript());
  out('login', login);

  if (command === 'probe') {
    const inventory = await evaluate(win.webContents, skillInventoryScript());
    out('ui', inventory);
    const pack = await evaluate(win.webContents, skillPackScript());
    out('skill_pack_status', { status: pack.status, bytes: (pack.text || '').length });
    out('skill_pack_body', sanitizeBody(pack.text, 4000));
    const recent = await evaluate(win.webContents, recentConvScript());
    out('recent_conv_status', { status: recent.status, bytes: (recent.text || '').length });
    out('recent_conv_summary', summarizeRecentConv(recent.text));
    appendCapture({ ts: new Date().toISOString(), event: 'probe', account: account.name, login: { title: login.title, hasComposer: login.hasComposer, loginHits: login.loginHits } });
    return;
  }

  if (command === 'panel' || command === 'ui') {
    const clicks = [];
    if (command === 'panel') clicks.push(String(args.skill || 'Create Videos'));
    if (args.click) for (const part of String(args.click).split('|')) clicks.push(part);
    const results = [];
    for (const text of clicks) {
      const result = args.trusted === true
        ? await trustedClickAt(win.webContents, text, args.exact === true)
        : await evaluate(win.webContents, clickByTextScript(text, args.exact === true));
      results.push({ text, result });
      await sleep(Number(args['wait-ms'] || 2500));
    }
    const description = await evaluate(win.webContents, describePanelScript());
    out('clicks', results);
    out('ui', description);
    appendCapture({ ts: new Date().toISOString(), event: 'ui_probe', account: account.name, clicks: results, bodyText: description.bodyText.slice(0, 1500) });
    return;
  }

  if (command === 'media') {
    const clicks = String(args.click || '').split('|').filter(Boolean);
    for (const text of clicks) {
      const result = await trustedClickAt(win.webContents, text, args.exact === true);
      out('clicked', { text, result });
      await sleep(Number(args['wait-ms'] || 5000));
    }
    const media = await evaluate(win.webContents, mediaInventoryScript());
    out('media', media);
    for (const video of media.videos) {
      for (const src of video.sources) if (/\.mp4|video/i.test(src) && !recentBodies.some(b => b.url === src)) recentBodies.push({ ts: new Date().toISOString(), url: src, mimeType: 'video/mp4', body: '' });
    }
    appendCapture({ ts: new Date().toISOString(), event: 'media_probe', account: account.name, media: { videos: media.videos.length, images: media.images.length, actions: media.actions.map(a => a.text) } });
    if (args.download === true) {
      const candidate = (media.videos.flatMap(v => v.sources).find(u => /\.mp4/i.test(u)))
        || findMediaUrl(null);
      if (!candidate) { out('download', { status: 'no_media_url' }); return; }
      const outDir = path.join(REPO_ROOT, 'outputs');
      ensureDir(outDir);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = path.join(outDir, `dola-${stamp}.mp4`);
      const res = await win.webContents.session.fetch(candidate, { method: 'GET' });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dest, buffer);
      out('downloaded', { file: dest, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
      appendCapture({ ts: new Date().toISOString(), event: 'media_downloaded', account: account.name, bytes: buffer.length, file: path.basename(dest) });
    }
    return;
  }


  if (command === 'chat') {
    // Plain text message through the real composer: used to test whether a body
    // rewrite alone triggers server-side enforcement, without spending credits.
    const text = String(args.text || 'ping');
    const wc = win.webContents;
    const box = await evaluate(wc, `(() => {
      const el = window.__dola.q('[contenteditable=true],textarea').find(node => window.__dola.visible(node));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + Math.min(80, r.width / 2)), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!box) throw new Error('composer not found');
    const dbg = wc.debugger;
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(300);
    await dbg.sendCommand('Input.insertText', { text });
    await sleep(800);
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' });
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    out('chat_sent', { text });
    appendCapture({ ts: new Date().toISOString(), event: 'chat_sent', account: account.name, text });
    const waitSeconds = Number(args['wait-seconds'] || 90);
    const deadline = Date.now() + waitSeconds * 1000;
    let lastText = '';
    while (Date.now() < deadline) {
      await sleep(10000);
      const patcher = await evaluate(wc, `window.__dolaPatcher || null`);
      const pageText = await evaluate(wc, `(document.body.innerText || '').slice(0, 2000)`);
      if (pageText !== lastText) {
        lastText = pageText;
        out('chat_poll', pageText.replace(/\n+/g, ' | ').slice(0, 400));
        appendCapture({ ts: new Date().toISOString(), event: 'chat_poll', patcher, text: pageText.slice(0, 1500) });
      }
      if (/Log In/.test(pageText) || findStreamError()) break;
    }
    const patcher = await evaluate(wc, `window.__dolaPatcher || null`);
    out('patcher_state', patcher);
    out('stream_error', findStreamError());
    return;
  }

  if (command === 'poll') {
    // Poll one conversation through the page's own IM API (no UI clicking) and
    // report / download the finished video.
    const conversationId = String(args.conversation || '');
    if (!conversationId) throw new Error('--conversation <id> is required');
    const wc = win.webContents;
    // The IM template URL only appears once the client opens a conversation, so
    // optionally click it first (opening the chat also triggers chain/single).
    if (args.click) {
      for (const text of String(args.click).split('|')) {
        const clicked = await trustedClickAt(wc, text, false);
        out('clicked', { text, clicked: clicked.clicked === true });
        await sleep(6000);
      }
    }
    let template = newestRequestUrl(/\/im\/chain\/single/);
    for (let i = 0; i < 5 && !template; i += 1) {
      await sleep(4000);
      template = newestRequestUrl(/\/im\/chain\/single/);
    }
    if (!template) throw new Error('no im/chain/single template URL captured yet');
    const url = template.split('?')[0] + '?' + new URL(template).searchParams.toString();
    const waitSeconds = Number(args['wait-seconds'] || 600);
    const deadline = Date.now() + waitSeconds * 1000;
    let video = null;
    while (Date.now() < deadline) {
      const response = await evaluate(wc, `window.__dola.api(${JSON.stringify(url)}, ${JSON.stringify(chainQueryBody(conversationId))})`);
      video = extractVideoFromMessages(response.text);
      out('poll', { status: response.status, ready: video.ready, duration: video.duration, vid: video.vid, error: video.errorText });
      if (args['dump-body'] === true) { out('poll_body_head', (response.text || '').slice(0, 1500)); out('poll_body_tail', (response.text || '').slice(-1500)); }
      appendCapture({ ts: new Date().toISOString(), event: 'poll', account: account.name, conversationId, status: response.status, ready: video.ready, duration: video.duration, vid: video.vid, error: video.errorText });
      if (video.mainUrl || video.downloadUrl || video.errorText) break;
      await sleep(20000);
    }
    if (!video || (!video.mainUrl && !video.downloadUrl)) {
      out('result', { status: video && video.errorText ? 'conversation_error' : 'no_video_found', detail: video });
      return;
    }
    const target = args.prefer === 'client' ? (video.downloadUrl || video.mainUrl) : (video.mainUrl || video.downloadUrl);
    out('video_url', { kind: target === video.mainUrl ? 'unwatermarked(main_url)' : 'client(download_url)', host: new URL(target).host });
    if (args.download === true) {
      const outDir = path.join(REPO_ROOT, 'outputs');
      ensureDir(outDir);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = path.join(outDir, `${String(args.name || 'dola')}-${stamp}.mp4`);
      const res = await win.webContents.session.fetch(target, { method: 'GET' });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dest, buffer);
      out('downloaded', { file: dest, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), reportedDuration: video.duration });
      appendCapture({ ts: new Date().toISOString(), event: 'media_downloaded', account: account.name, bytes: buffer.length, file: path.basename(dest), reportedDuration: video.duration });
    }
    return;
  }

  if (command === 'attach') {
    // Attach local image(s) to the composer through the page's own file input and
    // report what the client does with them (upload endpoint, resulting UI state).
    const images = String(args.image || '').split('|').filter(Boolean).map(p => normalizeLocalPath(p));
    if (!images.length) throw new Error('--image <path>[|path] is required');
    for (const file of images) if (!fs.existsSync(file)) throw new Error(`missing image: ${file}`);
    const skill = String(args.skill || 'Create Videos');
    const wc = win.webContents;
    if (args['no-skill'] !== true) {
      await evaluate(wc, clickByTextScript(skill, true));
      await sleep(2500);
    }
    const dbg = wc.debugger;
    const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
    const found = await dbg.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    if (!found || !found.nodeId) throw new Error('file input not found');
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId: found.nodeId, files: images });
    out('attached', { files: images.map(f => path.basename(f)) });
    await sleep(Number(args['wait-ms'] || 8000));
    const description = await evaluate(wc, describePanelScript());
    out('ui_state', { href: description.href, bodyText: description.bodyText.slice(0, 900), chips: description.chips.slice(0, 40) });
    appendCapture({ ts: new Date().toISOString(), event: 'attach_probe', account: account.name, files: images.length, bodyText: description.bodyText.slice(0, 1500) });
    return;
  }

  if (command === 'submit') {
    const duration = String(args.duration || '');
    const model = String(args.model || '');
    const ratio = String(args.ratio || '');
    const promptFile = args['prompt-file'] ? normalizeLocalPath(args['prompt-file']) : null;
    if (!promptFile || !fs.existsSync(promptFile)) throw new Error('--prompt-file is required for submit');
    const prompt = fs.readFileSync(promptFile, 'utf8').trim();
    if (!duration || !prompt) throw new Error('--duration and a non-empty prompt file are required');
    out('submit_plan', { duration, model: model || '(default)', ratio: ratio || '(default)', promptChars: prompt.length, send: args.submit === true });

    const wc = win.webContents;
    if (args['clear-draft'] === true) {
      // A leftover composer draft (text + attachments) rides along with the next
      // send, so drop the stored draft and reload before touching anything.
      const cleared = await evaluate(wc, `(() => {
        const removed = [];
        for (const store of [window.localStorage, window.sessionStorage]) {
          try {
            for (const key of Object.keys(store)) {
              if (/draft/i.test(key)) { removed.push(key.slice(0, 60)); store.removeItem(key); }
            }
          } catch (_) {}
        }
        return removed;
      })()`);
      out('draft_cleared', cleared);
      await wc.reload();
      await sleep(Number(args['boot-ms'] || 9000));
      await evaluate(wc, PAGE_HELPERS);
      if (args['patch-duration'] && patchMode === 'page') {
        await evaluate(wc, installPagePatcherScript({ duration: Number(args['patch-duration']) }));
      }
    }
    await evaluate(wc, clickByTextScript('Create Videos', true));
    await sleep(2500);

    if (args.image) {
      // Reference images travel through the composer's own file input; the client
      // uploads them and binds them to the pending message.
      const files = String(args.image).split('|').filter(Boolean).map(p => normalizeLocalPath(p));
      for (const file of files) if (!fs.existsSync(file)) throw new Error(`missing image: ${file}`);
      const doc = await wc.debugger.sendCommand('DOM.getDocument', { depth: -1 });
      const node = await wc.debugger.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
      if (!node || !node.nodeId) throw new Error('file input not found');
      await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: node.nodeId, files });
      out('attached', { files: files.map(f => path.basename(f)) });
      await sleep(Number(args['attach-wait-ms'] || 12000));
      const afterAttach = await evaluate(wc, `(() => {
        const el = window.__dola.q('[contenteditable=true],textarea').find(node => window.__dola.visible(node));
        return { chars: el ? (el.innerText || el.value || '').length : 0 };
      })()`);
      void afterAttach;
    }

    // The chips show the current selection; click the chip, then the option.
    const chipHints = {
      model: ['2.0 Fast', '2.5', '1.0', 'Fast', 'Model'],
      duration: ['5s', '10s', 'Duration'],
      ratio: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9', 'Ratio']
    };
    const selections = [];
    for (const [kind, wanted] of [['model', model], ['duration', duration], ['ratio', ratio]]) {
      if (!wanted) continue;
      let opened = null;
      for (const hint of chipHints[kind]) {
        const click = await trustedClickAt(wc, hint, true);
        if (click.clicked) { opened = click; break; }
      }
      await sleep(1200);
      const chosen = await trustedClickAt(wc, wanted, false);
      selections.push({ kind, wanted, opened: Boolean(opened), chosen });
      await sleep(1200);
      out('selected_' + kind, { wanted, chosen: chosen.clicked === true });
    }

    // Insert the prompt through real input events so the editor's own state updates.
    const box = await evaluate(wc, `(() => {
      const el = window.__dola.q('[contenteditable=true],textarea').find(node => window.__dola.visible(node));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + Math.min(80, r.width / 2)), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!box) throw new Error('composer not found');
    const dbg = wc.debugger;
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(300);
    await dbg.sendCommand('Input.insertText', { text: prompt });
    await sleep(1500);
    const typed = await evaluate(wc, `(() => {
      const el = window.__dola.q('[contenteditable=true],textarea').find(node => window.__dola.visible(node));
      return { chars: el ? (el.innerText || el.value || '').length : 0, head: el ? (el.innerText || el.value || '').slice(0, 60) : null };
    })()`);
    out('composer', typed);
    const description = await evaluate(wc, describePanelScript());
    out('ui_state', description.bodyText.slice(0, 900));
    appendCapture({ ts: new Date().toISOString(), event: 'submit_prepared', account: account.name, duration, model, ratio, promptChars: prompt.length, typedChars: typed.chars, sent: args.submit === true });

    if (args.submit !== true) {
      out('note', 'prepared but NOT sent: re-run with --submit to press Enter and create the task');
      return;
    }
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' });
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    out('sent', { at: new Date().toISOString() });
    appendCapture({ ts: new Date().toISOString(), event: 'submit_sent', account: account.name, duration, model, ratio, promptChars: prompt.length, patchDuration: requestPatcher ? requestPatcher.duration : null });

    const sentAt = new Date().toISOString();
    const waitSeconds = Number(args['wait-seconds'] || 900);
    const deadline = Date.now() + waitSeconds * 1000;
    let lastText = '';
    let mediaUrl = null;
    let streamError = null;
    while (Date.now() < deadline) {
      await sleep(15000);
      const text = await evaluate(wc, `(document.body.innerText || '').slice(0, 3000)`);
      if (text && text !== lastText) {
        lastText = text;
        out('ui_poll', text.replace(/\n+/g, ' | ').slice(0, 500));
        appendCapture({ ts: new Date().toISOString(), event: 'ui_poll', text: text.slice(0, 2000) });
      }
      mediaUrl = findMediaUrl(sentAt);
      if (mediaUrl) { out('media_url_found', { url: mediaUrl.slice(0, 120) + '…' }); break; }
      streamError = findStreamError();
      if (streamError) { out('stream_error', streamError); break; }
      const failed = /something went wrong|try again|not enough credit|insufficient|failed/i.test(text || '');
      const done = /download|save|\.mp4|drag/i.test(text || '');
      if (failed && !done) { out('ui_error_marker', text.slice(0, 400)); break; }
    }

    if (streamError) {
      out('result', { status: 'server_rejected', error: streamError });
      return;
    }
    if (!mediaUrl) {
      out('result', { status: 'no_media_url_captured', waitedSeconds: waitSeconds });
      return;
    }
    const outDir = path.join(REPO_ROOT, 'outputs');
    ensureDir(outDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(outDir, `dola3-${stamp}.mp4`);
    const ses = win.webContents.session;
    const res = await ses.fetch(mediaUrl, { method: 'GET' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buffer);
    out('downloaded', { file: dest, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
    appendCapture({ ts: new Date().toISOString(), event: 'media_downloaded', account: account.name, bytes: buffer.length, file: path.basename(dest) });
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    await main();
  } catch (error) {
    out('error', String((error && error.stack) || error));
    code = 1;
  } finally {
    if (captureFile) out('capture', captureFile);
    app.exit(code);
  }
});
