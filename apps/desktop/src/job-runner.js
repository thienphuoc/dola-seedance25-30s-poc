'use strict';

/*
 * Bộ chạy việc: điều khiển một cửa sổ Dola riêng của tài khoản để
 * chọn mô hình / khung hình / số giây, gắn ảnh mẫu, gõ đoạn mô tả, bấm gửi,
 * chờ máy chủ trả video rồi tải bản không dấu chìm về thư mục outputs.
 *
 * Cửa sổ hiện ra nhưng được thu nhỏ, để khi Dola hỏi xác minh thì người dùng mở lên xử lý.
 */

const { webContents, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { buildPageScript } = require('./dola-page-script');
const { patchSkillPack, patchActionBarConfig } = require('./dola-capability');

const DOLA_URL = 'https://www.dola.com/chat/';
const DEFAULT_DURATIONS = [5, 10, 15, 30];

const PAGE_HELPERS = `
window.__dq = (sel) => Array.from(document.querySelectorAll(sel));
window.__dvisible = (el) => {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
};
window.__dlabel = (el) => ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 90);
true;
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
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

// Bóc thông tin video từ một câu trả lời /im/chain/single (đã quan sát thực tế).
// Đọc từng video một: đi qua dữ liệu hội thoại, gom vid (theo thứ tự) và các cặp
// main_url (base64, bản không dấu chìm) / download_url (bản của trang), rồi ghép theo
// thứ tự — cách cũ quét cả câu trả lời bằng một biểu thức chính quy nên mọi video
// đều dính URL của video mới nhất.
function extractVideos(rawBody) {
  if (!rawBody) return [];
  const vids = [];
  const mainUrls = [];
  const downloadUrls = [];
  const seenMain = new Set();
  const seenDownload = new Set();

  function visit(node, depth, seenNodes) {
    if (node === null || typeof node !== 'object' || depth > 14 || seenNodes.has(node)) return;
    seenNodes.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1, seenNodes);
      return;
    }
    const vid = typeof node.vid === 'string' && /^v[0-9a-z]+$/.test(node.vid) ? node.vid : null;
    if (vid && !vids.some((item) => item.vid === vid)) {
      vids.push({
        vid,
        duration: Number(node.duration) || null,
        width: Number(node.vwidth) || null,
        height: Number(node.vheight) || null
      });
    }
    if (typeof node.main_url === 'string' && node.main_url.length >= 32) {
      const decoded = decodeMaybeBase64(node.main_url);
      if (/^https?:\/\//.test(decoded) && !seenMain.has(decoded)) {
        seenMain.add(decoded);
        mainUrls.push(decoded);
      }
    }
    if (typeof node.download_url === 'string' && /^https?:\/\//.test(node.download_url)) {
      const url = node.download_url.replace(/\\u0026/g, '&');
      if (!seenDownload.has(url)) {
        seenDownload.add(url);
        downloadUrls.push(url);
      }
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            visit(JSON.parse(value), depth + 1, seenNodes);
          } catch (_) { /* chuỗi thường */ }
        }
      } else {
        visit(value, depth + 1, seenNodes);
      }
    }
  }

  try {
    visit(JSON.parse(String(rawBody)), 0, new Set());
  } catch (_) {
    return [];
  }

  const out = [];
  for (let index = 0; index < vids.length; index += 1) {
    const item = vids[index];
    out.push({
      vid: item.vid,
      duration: item.duration,
      width: item.width,
      height: item.height,
      mainUrl: mainUrls[index] || null,
      downloadUrl: downloadUrls[index] || null
    });
  }
  return out;
}

function hasLogInMarker(text) {
  return /(^|\n)\s*Log In\s*(\n|$)/.test(String(text || ''));
}

// Máy chủ Dola từ chối tạo video kèm lý do cụ thể (thiếu credit, tham số vượt giới hạn…).
// Bắt đúng câu đó để dừng ngay thay vì chờ vô ích.
function matchRefusal(text) {
  const raw = String(text || '');
  const patterns = [
    /Generating with the current parameters will use[\s\S]{0,200}?(?:\n|$)/i,
    /You only have \d+[\s\S]{0,120}?(?:left today|remaining)[\s\S]{0,80}?(?:\n|$)/i,
    /currently supports durations from[^\n]{0,160}/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    const line = match[0].replace(/\s+/g, ' ').trim();
    const needs = (line.match(/will use (\d+) video credits/i) || [])[1];
    const left = (line.match(/only have (\d+) left/i) || [])[1];
    return {
      text: line,
      summary: needs && left
        ? `Không đủ credit: bộ tham số này cần ${needs} credit, tài khoản còn ${left}. Giảm số giây, bớt ảnh tham chiếu hoặc dùng mô hình rẻ hơn rồi chạy lại.`
        : `Máy chủ từ chối: ${line.slice(0, 200)}`
    };
  }
  return null;
}

function createJobRunner(options) {
  const userDataDir = options.userDataDir;
  const outputsDir = options.outputsDir;
  const uploadsDir = options.uploadsDir;
  const jobsFile = options.jobsFile;
  const captureDir = options.captureDir;
  const getAccounts = options.getAccounts;
  const activateAccountView = options.activateAccountView || null;
  const refreshAccountViews = options.refreshAccountViews || null;
  const resolveWebviewId = options.resolveWebviewId || null;
  const ffprobePath = process.env.DOLA_FFPROBE || 'ffprobe';

  const targets = new Map();
  const activeJobs = new Map();
  let jobs = loadJobs();

  for (const dir of [outputsDir, uploadsDir, captureDir, path.dirname(jobsFile)]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  }

  function loadJobs() {
    try {
      const parsed = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      // Việc đang chạy mà ứng dụng đã bị đóng thì không còn ai theo dõi; đánh dấu lại
      // để không chặn việc mới và không hiển thị sai trạng thái.
      const active = new Set(['queued', 'running', 'submitting', 'accepted', 'generating']);
      for (const job of parsed) {
        if (job && active.has(job.status)) {
          job.status = 'failed';
          job.message = 'Ứng dụng đã đóng giữa lúc chờ nên không theo dõi tiếp. Mở hội thoại Dola của tài khoản để xem kết quả.';
          job.updatedAt = new Date().toISOString();
          job.log = job.log || [];
          job.log.push({ at: job.updatedAt, text: 'Ứng dụng khởi động lại: dừng theo dõi việc này' });
        }
      }
      return parsed;
    } catch (_) {
      return [];
    }
  }

  function saveJobs() {
    try {
      const tmp = `${jobsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(jobs.slice(0, 200), null, 2), 'utf8');
      fs.renameSync(tmp, jobsFile);
    } catch (_) { /* không để lỗi ghi đè việc chạy */ }
  }

  function appendCapture(record) {
    try {
      const day = new Date().toISOString().slice(0, 10);
      fs.appendFileSync(path.join(captureDir, `dola-web-${day}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
    } catch (_) { /* ignore */ }
  }

  function log(job, text) {
    const entry = { at: new Date().toISOString(), text: String(text) };
    job.log.push(entry);
    if (job.log.length > 120) job.log.shift();
    job.message = entry.text;
    job.updatedAt = entry.at;
    saveJobs();
    appendCapture({ ts: entry.at, event: 'job_log', jobId: job.id, account: job.accountName, status: job.status, text: entry.text });
  }

  function setStatus(job, status, text) {
    job.status = status;
    if (text) log(job, text); else { job.updatedAt = new Date().toISOString(); saveJobs(); }
    appendCapture({ ts: new Date().toISOString(), event: 'job_status', jobId: job.id, account: job.accountName, status });
  }

  // Dùng chính khung Dola có sẵn trong ứng dụng (không mở thêm cửa sổ trình duyệt).
  // Khung đó do màn hình chính của ứng dụng tạo, nên phải nhờ nó chuyển sang đúng
  // tài khoản rồi trả về mã khung.
  async function resolveTarget(account) {
    const cached = targets.get(account.id);
    if (cached && !cached.isDestroyed()) return cached;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (activateAccountView) activateAccountView(account.id);
      const id = resolveWebviewId ? await resolveWebviewId(account.id) : null;
      if (id) {
        const wc = webContents.fromId(Number(id));
        if (wc && !wc.isDestroyed()) {
          targets.set(account.id, wc);
          attachDebugger(wc);
          wc.once('destroyed', () => targets.delete(account.id));
          return wc;
        }
      }
      if (attempt === 2 && refreshAccountViews) refreshAccountViews();
      await sleep(1500);
    }
    throw new Error('Không tìm thấy khung Dola của tài khoản trong ứng dụng. Mở ứng dụng lên rồi chạy lại.');
  }

  // Cửa sổ ẩn riêng cho tài khoản: nơi đọc dữ liệu hội thoại đáng tin cậy (khung
  // webview trong ứng dụng không bắn Network.loadingFinished nên không đọc được body).
  const hiddenWindows = new Map();

  async function ensureHiddenWindow(account) {
    const existing = hiddenWindows.get(account.id);
    if (existing && !existing.isDestroyed()) return existing;
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      title: `Dola (ẩn) · ${account.name}`,
      webPreferences: {
        partition: account.partition,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    hiddenWindows.set(account.id, win);
    win.on('closed', () => hiddenWindows.delete(account.id));
    return win;
  }

  // Mở hội thoại trong cửa sổ ẩn và để bộ bắt CDP thu dữ liệu tin nhắn vào chainBodies.
  async function fetchConversationIntoCapture(account, href) {
    const win = await ensureHiddenWindow(account);
    const wc = win.webContents;
    attachDebugger(wc);
    enableChainCapture(wc, account.id);
    chainBodies.set(account.id, []);
    await wc.loadURL(href);
    await sleep(6000);
    return true;
  }

  function forgetTarget(accountId) {
    const wc = targets.get(String(accountId));
    if (wc) targets.delete(String(accountId));
  }

  function attachDebugger(wc) {
    const dbg = wc.debugger;
    if (dbg.isAttached()) return;
    try {
      dbg.attach('1.3');
    } catch (_) { /* đã bị gắn ở nơi khác */ }
  }

  // Thêm số giây vào câu trả lời cấu hình ngay trên đường truyền, trước khi trang đọc.
  // Yêu cầu gửi đi không bị sửa, nên trang vẫn tự ký bằng mã của nó.
  const injectionStats = { skillPack: 0, actionBar: 0, lastError: null };
  const injectionState = new Map();

  // Bắt dữ liệu hội thoại ở tầng mạng (CDP): bắt được cả fetch lẫn XHR, bất kể
  // trang có tự hỏi lại hay nhận qua kênh đẩy.
  const chainBodies = new Map(); // accountId -> [{ts, url, body}]
  const chainRequestUrls = new Map(); // requestId -> url
  const chainObserverOn = new Set(); // webContents id đã gắn

  function enableChainCapture(wc, accountId) {
    const key = wc.id;
    if (chainObserverOn.has(key)) return;
    const dbg = wc.debugger;
    attachDebugger(wc);
    try { dbg.sendCommand('Network.enable', {}); } catch (_) { /* có thể đã bật */ }
    chainObserverOn.add(key);
    dbg.on('message', async (_event, method, params) => {
      if (!params) return;
      if (method === 'Network.requestWillBeSent' && params.request) {
        chainRequestUrls.set(params.requestId, params.request.url);
        if (chainRequestUrls.size > 500) {
          for (const id of [...chainRequestUrls.keys()].slice(0, 250)) chainRequestUrls.delete(id);
        }
        return;
      }
      if (method !== 'Network.loadingFinished') return;
      const url = chainRequestUrls.get(params.requestId) || '';
      if (process.env.DOLA_DEBUG_CHAIN === '1') {
        appendCapture({ ts: new Date().toISOString(), event: 'chain_any_url', url: url.split('?')[0].slice(0, 90) });
      }
      if (!/im\/chain\/single/.test(url)) return;
      try {
        const result = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
        if (!body) return;
        const list = chainBodies.get(accountId) || [];
        list.push({ ts: Date.now(), url: url.split('?')[0], body });
        if (list.length > 6) list.shift();
        chainBodies.set(accountId, list);
      } catch (_) { /* body có thể đã rời bộ nhớ */ }
    });
  }

  function readChainSnapshot(wc, accountId) {
    const list = chainBodies.get(String(accountId)) || [];
    return list.length ? list[list.length - 1] : null;
  }

  function readChainBodies(accountId) {
    return chainBodies.get(String(accountId)) || [];
  }

  async function enableCapabilityInjection(wc, durations) {
    const key = wc.id;
    if (injectionState.get(key) === 'enabled') return true;
    if (injectionState.get(key) === 'off') return false;
    const dbg = wc.debugger;
    attachDebugger(wc);
    try {
      await dbg.sendCommand('Fetch.enable', {
        patterns: [
          { urlPattern: '*dola.com/samantha/skill/pack*', requestStage: 'Response' },
          { urlPattern: '*dola.com/alice/slot/action_bar_v3/get_item_conf*', requestStage: 'Response' }
        ]
      });
      injectionState.set(key, 'enabled');
    } catch (error) {
      injectionStats.lastError = String((error && error.message) || error);
      return false;
    }
    dbg.on('message', async (_event, method, params) => {
      if (method !== 'Fetch.requestPaused' || !params) return;
      const url = (params.request && params.request.url) || '';
      try {
        const body = await dbg.sendCommand('Fetch.getResponseBody', { requestId: params.requestId });
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        let result = { text, changed: false };
        if (/samantha\/skill\/pack/.test(url)) {
          result = patchSkillPack(text, durations);
          if (result.changed) injectionStats.skillPack += 1;
        } else if (/action_bar_v3\/get_item_conf/.test(url)) {
          result = patchActionBarConfig(text, durations);
          if (result.changed) injectionStats.actionBar += 1;
        }
        const headers = (params.responseHeaders || []).filter((header) => !/content-length/i.test(header.name));
        if (result.changed) {
          headers.push({ name: 'content-length', value: String(Buffer.byteLength(result.text, 'utf8')) });
        }
        // Bỏ content-encoding: phần thân mình trả về là JSON thô, giữ header nén của
        // máy chủ sẽ làm trang đọc hỏng.
        const cleanHeaders = headers.filter((header) => !/content-encoding|transfer-encoding/i.test(header.name));
        if (!cleanHeaders.some((header) => /content-type/i.test(header.name))) {
          cleanHeaders.push({ name: 'content-type', value: 'application/json; charset=utf-8' });
        }
        await dbg.sendCommand('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: params.responseStatusCode || 200,
          responsePhrase: params.responseStatusText || 'OK',
          responseHeaders: cleanHeaders,
          body: Buffer.from(result.text, 'utf8').toString('base64')
        });
      } catch (error) {
        injectionStats.lastError = String((error && error.message) || error);
        try { await dbg.sendCommand('Fetch.continueRequest', { requestId: params.requestId }); } catch (_) { /* bỏ qua */ }
      }
    });
    return true;
  }

  async function evaluate(wc, code) {
    return await wc.executeJavaScript(code, true);
  }

  async function pageHelpers(wc) {
    return await evaluate(wc, PAGE_HELPERS);
  }

  async function waitForPage(wc, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last = { title: '', hasComposer: false };
    while (Date.now() < deadline) {
      try {
        last = await evaluate(wc, `(() => ({
          title: document.title,
          href: location.href,
          hasComposer: Boolean(window.__dq && window.__dola.q ? true : Array.from(document.querySelectorAll('[contenteditable=true],textarea')).length)
        }))()`);
        if (last.hasComposer) return last;
      } catch (_) { /* trang đang chuyển */ }
      await sleep(1500);
    }
    return last;
  }

  async function readLogin(wc) {
    return await evaluate(wc, `(() => {
      const text = (document.body.innerText || '');
      const hits = [];
      for (const el of (window.__dq ? window.__dq('button,[role=button],a') : [])) {
        if (!window.__dvisible(el)) continue;
        const t = window.__dlabel(el);
        if (t && /^(log ?in|sign ?in|đăng nhập)$/i.test(t)) hits.push(t);
      }
      return { hasLogInControl: hits.length > 0, hits, excerpt: text.replace(/\\s+/g, ' ').slice(0, 200) };
    })()`);
  }

  // Trang Dola vẽ giao diện trước khi biết phiên đăng nhập, nên phải chờ nó ổn định:
  // hỏi thẳng máy chủ tên tài khoản là bằng chứng mạnh nhất, DOM chỉ là dự phòng.
  async function resolveLogin(wc, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let dom = { hasLogInControl: true };
    while (Date.now() < deadline) {
      const profile = await readNickname(wc);
      if (profile && profile.nickname) {
        return { loggedIn: true, nickname: profile.nickname, membership: profile.level || null, source: 'profile' };
      }
      dom = await readLogin(wc).catch(() => dom);
      if (!dom.hasLogInControl) {
        await sleep(2500);
        const again = await readNickname(wc);
        if (again && again.nickname) {
          return { loggedIn: true, nickname: again.nickname, membership: again.level || null, source: 'profile' };
        }
        const domAgain = await readLogin(wc).catch(() => dom);
        if (!domAgain.hasLogInControl) {
          return { loggedIn: true, nickname: null, membership: null, source: 'dom' };
        }
        dom = domAgain;
      }
      await sleep(2500);
    }
    return { loggedIn: false, source: 'dom', detail: dom };
  }

  async function readNickname(wc) {
    // Hai endpoint trang Dola tự gọi lúc khởi động; gọi lại bằng chính phiên trang.
    try {
      const result = await evaluate(wc, `(async () => {
        const post = async (url, body) => {
          const res = await fetch(url, {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          });
          if (!res.ok) return { ok: false, status: res.status };
          const json = await res.json();
          const brief = json && json.data && json.data.profile_brief;
          return {
            ok: true,
            nickname: (brief && brief.nickname) || null,
            level: ((json.data && json.data.membership_info) || {}).level || null,
            raw: JSON.stringify(json).slice(0, 300)
          };
        };
        const brief = await post('/alice/profile/self_brief?aid=495671&device_platform=web&language=en', {});
        if (brief.ok && brief.nickname) return brief;
        const self = await post('/alice/profile/self?aid=495671&device_platform=web&language=en', { visit_id: '', avatar_format: 'png' });
        if (self.ok && self.nickname) return self;
        return brief.ok ? self : brief;
      })()`);
      return result || { ok: false };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  async function trustedClick(wc, text, exact) {
    const box = await evaluate(wc, `(() => {
      const needle = ${JSON.stringify(String(text))};
      const nodes = window.__dq('button,[role=button],a,[role=tab],[role=menuitem],[role=radio],div,span,p')
        .filter((el) => window.__dvisible(el) && el.children.length <= 2)
        .filter((el) => {
          const t = window.__dlabel(el).trim();
          return ${exact === true} ? t === needle : t.includes(needle);
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return ra.width * ra.height - rb.width * rb.height;
        });
      if (!nodes.length) return null;
      const el = nodes[0];
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: window.__dlabel(el) };
    })()`);
    if (!box) return { clicked: false };
    const dbg = wc.debugger;
    try {
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
      await sleep(50);
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await sleep(40);
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    } catch (error) {
      return { clicked: false, error: String((error && error.message) || error) };
    }
    return { clicked: true, at: box };
  }

  async function selectOption(wc, chipHints, wanted) {
    let opened = false;
    for (const hint of chipHints) {
      const result = await trustedClick(wc, hint, true);
      if (result.clicked) { opened = true; break; }
    }
    await sleep(1000);
    const chosen = opened ? await trustedClick(wc, wanted, false) : { clicked: false };
    await sleep(900);
    return { opened, chosen: chosen.clicked === true };
  }

  // Liệt kê các phần tử có thể bấm theo nhãn (nhỏ nhất trước), để bấm có kiểm chứng.
  async function listClickCandidates(wc, needle, exact) {
    return await evaluate(wc, `(() => {
      const needle = ${JSON.stringify(String(needle))};
      return window.__dq('button,[role=button],a,[role=tab],[role=menuitem],[role=radio],div,span,p')
        .filter((el) => window.__dvisible(el))
        .filter((el) => {
          const text = window.__dlabel(el).trim();
          return ${exact === true} ? text === needle : text.includes(needle);
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            text: window.__dlabel(el),
            tag: el.tagName,
            w: Math.round(r.width),
            h: Math.round(r.height)
          };
        })
        .filter((item) => item.w > 4 && item.h > 4)
        .sort((a, b) => a.w * a.h - b.w * b.h)
        .slice(0, 8);
    })()`).catch(() => []);
  }

  async function clickAt(wc, point) {
    const dbg = wc.debugger;
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    await sleep(60);
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await sleep(50);
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }

  // Mở hội thoại bằng cách bấm trong trang (điều hướng nội bộ) — cách này khiến trang
  // tự hỏi lại danh sách tin nhắn, qua đó bắt được video mới. Tải lại cả trang thì
  // không dùng được vì trang nạp xong mới tới lượt mình gắn bộ đọc.
  async function clickConversation(wc, href, title) {
    const box = await evaluate(wc, `(() => {
      const want = ${JSON.stringify(String(href || ''))};
      const wantId = want ? (want.match(/\\/chat\\/(\\d+)/) || [])[1] : null;
      const needle = ${JSON.stringify(String(title || '').toLowerCase())};
      const links = Array.from(document.querySelectorAll('a[href^="/chat/"]'));
      const match = (wantId ? links.find((a) => a.getAttribute('href') === '/chat/' + wantId) : null)
        || (needle ? links.find((a) => (a.innerText || '').toLowerCase().includes(needle)) : null)
        || links.find((a) => /^\\/chat\\/\\d+$/.test(a.getAttribute('href') || ''));
      if (!match) return null;
      const rect = match.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return null;
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), text: (match.innerText || '').trim().slice(0, 40) };
    })()`).catch(() => null);
    if (!box) return null;
    await clickAt(wc, box);
    await sleep(4000);
    return box.text;
  }

  // Bấm cho tới khi điều kiện đúng: thử lần lượt từng ứng viên, sai thì thử cái kế tiếp.
  async function clickUntil(wc, needle, verify, attemptLog) {
    const candidates = await listClickCandidates(wc, needle, false);
    if (!candidates.length) return { clicked: false, reason: 'không thấy phần tử' };
    for (const point of candidates) {
      await clickAt(wc, point);
      await sleep(1400);
      if (await verify()) {
        if (attemptLog) attemptLog.push({ needle, clicked: point.text, w: point.w, h: point.h, ok: true });
        return { clicked: true, at: point };
      }
      if (attemptLog) attemptLog.push({ needle, tried: point.text, w: point.w, h: point.h, ok: false });
    }
    return { clicked: false, reason: 'bấm hết ứng viên mà không đổi trạng thái' };
  }

  async function hasVideoPanel(wc) {
    return await evaluate(wc, `(() => {
      const texts = window.__dq('span,div,button,[role=button]')
        .filter((el) => window.__dvisible(el) && el.children.length === 0)
        .map((el) => window.__dlabel(el).trim());
      const labels = texts.filter((t) => t === 'Duration' || t === 'Ratio' || t === 'Model').length;
      const values = texts.some((t) => /^\\d{1,2}\\s?s$/.test(t)) || texts.some((t) => /^\\d{1,2}:\\d{1,2}$/.test(t));
      return labels > 0 && values;
    })()`).catch(() => false);
  }

  // Mở bảng chọn tạo video, có kiểm chứng; thử lại sau khi tải lại trang nếu cần.
  async function openVideoPanel(wc, attemptLog) {
    for (let round = 0; round < 2; round += 1) {
      await trustedClick(wc, 'Create Videos', true);
      await sleep(2000);
      if (await hasVideoPanel(wc)) return 'chip';
      const viaChip = await clickUntil(wc, 'Create Videos', () => hasVideoPanel(wc), attemptLog);
      if (viaChip.clicked) return 'chip-candidates';
      const composer = await evaluate(wc, `(() => {
        const el = window.__dq('[contenteditable=true],textarea').find((node) => window.__dvisible(node));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + 40), y: Math.round(r.y + r.height / 2) };
      })()`).catch(() => null);
      if (composer) {
        await clickAt(wc, composer);
        await sleep(800);
        await trustedClick(wc, 'Create Videos', true);
        await sleep(2000);
        if (await hasVideoPanel(wc)) return 'composer-then-chip';
      }
      await wc.reload();
      await waitForPage(wc);
      await pageHelpers(wc);
      await sleep(1500);
    }

    // Đường B: mục AI Creation ở thanh bên, rồi tab Video.
    const nav = await trustedClick(wc, 'AI Creation', true);
    if (nav.clicked) {
      await sleep(2500);
      if (await hasVideoPanel(wc)) return 'ai-creation';
      const tab = await trustedClick(wc, 'Video', true);
      if (tab.clicked) {
        await sleep(2500);
        if (await hasVideoPanel(wc)) return 'ai-creation-video';
        if (attemptLog) attemptLog.push({ needle: 'AI Creation→Video', ok: false });
      }
    }
    return false;
  }

  // Mở ô chọn số giây và đọc danh sách lựa chọn (không bấm chọn gì).
  async function openDurationOptions(wc) {
    const current = await evaluate(wc, `(() => {
      const texts = window.__dq('span,div,button,[role=button]')
        .filter((el) => window.__dvisible(el) && el.children.length === 0)
        .map((el) => window.__dlabel(el).trim())
        .filter((text) => /^\\d{1,2}\\s?s$/.test(text));
      return [...new Set(texts)];
    })()`).catch(() => []);
    let opened = false;
    for (const label of (current || [])) {
      const click = await trustedClick(wc, label, true);
      if (click.clicked) { opened = true; break; }
    }
    if (!opened) {
      const fallback = await trustedClick(wc, 'Duration', false);
      opened = fallback.clicked === true;
    }
    await sleep(1200);
    const options = await evaluate(wc, `(() => {
      const texts = window.__dq('span,div,button,[role=button],[role=radio],[role=option],li')
        .filter((el) => window.__dvisible(el) && el.children.length === 0)
        .map((el) => window.__dlabel(el).trim())
        .filter((text) => /^\\d{1,2}\\s?s$/.test(text));
      return [...new Set(texts)];
    })()`).catch(() => []);
    return { opened, options };
  }

  // Nút "Bật 30s": thêm lựa chọn số giây vào bảng chọn của trang cho tài khoản này,
  // để người dùng tự thao tác trong ứng dụng cũng thấy. Không gửi gì, không tốn credit.
  async function enableDurationForAccount(accountId, durations) {
    const account = findAccount(accountId);
    if (!account) return { ok: false, error: 'Không thấy tài khoản' };
    const wc = await resolveTarget(account);
    await pageHelpers(wc);
    await waitForPage(wc);
    const login = await resolveLogin(wc);
    if (!login.loggedIn) {
      return { ok: false, loggedIn: false, error: 'Tài khoản chưa đăng nhập. Mở ứng dụng đăng nhập lại rồi bật.' };
    }
    const wanted = durations && durations.length ? durations : DEFAULT_DURATIONS;
    const enabled = await enableCapabilityInjection(wc, wanted);
    if (!enabled) {
      return { ok: false, loggedIn: true, error: injectionStats.lastError || 'Không bật được' };
    }
    await wc.reload();
    await waitForPage(wc);
    await pageHelpers(wc);
    const panelOpen = await openVideoPanel(wc, []);
    const duration = panelOpen ? await openDurationOptions(wc) : { options: [] };
    // Chọn sẵn cấu hình hay dùng, để người dùng chỉ việc gõ mô tả rồi bấm gửi.
    let applied = null;
    if (panelOpen) {
      const model = await selectOption(wc, ['2.5', '2.0 Fast', '1.0', 'Fast', 'Model'], 'Dreamina Seedance 2.5');
      const ratio = await selectOption(wc, ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9', 'Ratio'], '16:9');
      const chosen = await selectDuration(wc, 30);
      applied = { model: model.chosen, ratio: ratio.chosen, duration: chosen.chosen };
    }
    const result = {
      ok: true,
      loggedIn: true,
      nickname: login.nickname || null,
      requested: wanted,
      options: duration.options || [],
      hasThirty: (duration.options || []).includes('30s'),
      panelOpen,
      applied
    };
    appendCapture({ ts: new Date().toISOString(), event: 'enable_duration', account: account.name, ...result });
    return result;
  }

  // Chọn số giây: mở đúng ô đang hiển thị, đọc danh sách lựa chọn thật rồi chọn.
  async function selectDuration(wc, seconds) {
    const wanted = `${seconds}s`;
    const current = await evaluate(wc, `(() => {
      const texts = window.__dq('span,div,button,[role=button]')
        .filter((el) => window.__dvisible(el) && el.children.length === 0)
        .map((el) => window.__dlabel(el).trim())
        .filter((text) => /^\\d{1,2}\\s?s$/.test(text));
      return [...new Set(texts)];
    })()`).catch(() => []);
    let opened = false;
    for (const label of (current || [])) {
      const click = await trustedClick(wc, label, true);
      if (click.clicked) { opened = true; break; }
    }
    if (!opened) {
      const fallback = await trustedClick(wc, 'Duration', false);
      opened = fallback.clicked === true;
    }
    await sleep(1200);
    const options = await evaluate(wc, `(() => {
      const texts = window.__dq('span,div,button,[role=button],[role=radio],[role=option],li')
        .filter((el) => window.__dvisible(el) && el.children.length === 0)
        .map((el) => window.__dlabel(el).trim())
        .filter((text) => /^\\d{1,2}\\s?s$/.test(text));
      return [...new Set(texts)];
    })()`).catch(() => []);
    const chosen = options.includes(wanted) ? await trustedClick(wc, wanted, true) : { clicked: false };
    await sleep(900);
    return { opened, options, chosen: chosen.clicked === true };
  }

  async function setComposerText(wc, text) {
    const box = await evaluate(wc, `(() => {
      const el = window.__dq('[contenteditable=true],textarea').find((node) => window.__dvisible(node));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + Math.min(80, r.width / 2)), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!box) throw new Error('Không tìm thấy ô nhập nội dung trên trang Dola');
    const dbg = wc.debugger;
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(250);
    await dbg.sendCommand('Input.insertText', { text });
    await sleep(700);
    return await evaluate(wc, `(() => {
      const el = window.__dq('[contenteditable=true],textarea').find((node) => window.__dvisible(node));
      return el ? (el.innerText || el.value || '').length : 0;
    })()`);
  }

  async function attachImages(wc, files) {
    const doc = await wc.debugger.sendCommand('DOM.getDocument', { depth: -1 });
    const node = await wc.debugger.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    if (!node || !node.nodeId) throw new Error('Trang Dola không có ô chọn ảnh');
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: node.nodeId, files });
  }

  async function sendEnter(wc) {
    const dbg = wc.debugger;
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' });
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  }

  async function readRunnerState(wc) {
    return await evaluate(wc, `(() => {
      const s = window.__dolaRunner && window.__dolaRunner.state;
      if (!s) return null;
      const last = s.chainBodies.length ? s.chainBodies[s.chainBodies.length - 1] : null;
      return {
        patchedRequests: s.patchedRequests,
        patchedResponses: s.patchedResponses,
        notes: s.notes.slice(-6),
        lastError: s.lastError,
        bodyAt: last ? last.at : null,
        body: last ? last.body : null
      };
    })()`);
  }

  async function probeFfprobe(file) {
    return await new Promise((resolve) => {
      execFile(ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration,size',
        '-show_entries', 'stream=codec_name,codec_type,width,height',
        '-of', 'json', file
      ], { timeout: 30000 }, (error, stdout) => {
        if (error) { resolve(null); return; }
        try {
          const parsed = JSON.parse(stdout);
          const video = (parsed.streams || []).find((s) => s.codec_type === 'video') || {};
          const audio = (parsed.streams || []).find((s) => s.codec_type === 'audio') || {};
          resolve({
            durationSeconds: Number(parsed.format && parsed.format.duration) || null,
            bytes: Number(parsed.format && parsed.format.size) || null,
            width: video.width || null,
            height: video.height || null,
            videoCodec: video.codec_name || null,
            audioCodec: audio.codec_name || null
          });
        } catch (_) {
          resolve(null);
        }
      });
    });
  }

  async function checkAccount(accountId) {
    const account = getAccounts().find((item) => item.id === String(accountId || ''));
    if (!account) return { ok: false, error: 'Không thấy tài khoản' };
    const wc = await resolveTarget(account);
    await pageHelpers(wc);
    await waitForPage(wc);
    const login = await resolveLogin(wc);
    return {
      ok: true,
      loggedIn: login.loggedIn === true,
      account: { id: account.id, name: account.name },
      nickname: login.nickname || null,
      membership: login.membership || null,
      source: login.source || null,
      detail: login.loggedIn ? null : (login.detail || null)
    };
  }

  function findAccount(accountId) {
    return getAccounts().find((item) => item.id === String(accountId || '')) || null;
  }

  // Mở bảng chọn và chọn số giây, theo thứ tự: tiêm cấu hình trước, không tải lại;
  // không được thì tải lại một lần; vẫn không được thì tắt tiêm và lùi về đường sửa yêu cầu.
  async function ensurePanelAndDuration(wc, seconds, attemptLog) {
    const runOnce = async () => {
      const panelOpen = await openVideoPanel(wc, attemptLog);
      const duration = panelOpen ? await selectDuration(wc, seconds) : { options: [], chosen: false };
      return { panelOpen, duration };
    };

    let attempt = await runOnce();
    let mode = 'inject-no-reload';
    if (!attempt.duration.chosen) {
      await wc.reload();
      await waitForPage(wc);
      await pageHelpers(wc);
      attempt = await runOnce();
      mode = 'inject-after-reload';
    }
    if (!attempt.duration.chosen) {
      try { await wc.debugger.sendCommand('Fetch.disable'); } catch (_) { /* bỏ qua */ }
      injectionState.set(wc.id, 'off');
      injectionStats.lastError = injectionStats.lastError || 'đã tắt tiêm sau khi thử';
      await wc.reload();
      await waitForPage(wc);
      await pageHelpers(wc);
      attempt = await runOnce();
      mode = 'fallback-request-patch';
    }
    return { mode, panelOpen: attempt.panelOpen, options: attempt.duration.options || [], chosen: attempt.duration.chosen === true };
  }

  // Kiểm tra miễn phí: mở bảng chọn của trang xem số giây đã được thêm vào chưa.
  // Không gửi gì nên không tốn credit.
  async function probeCapability(accountId, options) {
    const simple = Boolean(options && options.simple);
    const account = findAccount(accountId);
    if (!account) throw new Error('Tài khoản không tồn tại');
    const wc = await resolveTarget(account);
    await pageHelpers(wc);
    await waitForPage(wc);
    const login = await resolveLogin(wc);
    if (!login.loggedIn) return { ok: true, loggedIn: false };

    const before = { skillPack: injectionStats.skillPack, actionBar: injectionStats.actionBar };
    let injected = false;
    if (!simple) injected = await enableCapabilityInjection(wc, DEFAULT_DURATIONS);
    const attemptLog = [];
    const outcome = await ensurePanelAndDuration(wc, 30, attemptLog);
    const panel = await evaluate(wc, `(() => {
      const texts = window.__dq('span,div,button,[role=button]')
        .filter((el) => window.__dvisible(el) && el.children.length === 0)
        .map((el) => window.__dlabel(el).trim())
        .filter((text) => text && text.length <= 24);
      return [...new Set(texts)].slice(0, 40);
    })()`).catch(() => []);
    const result = {
      ok: true,
      loggedIn: true,
      nickname: login.nickname,
      membership: login.membership,
      injected,
      injectionError: injectionStats.lastError,
      patched: {
        skillPack: injectionStats.skillPack - before.skillPack,
        actionBar: injectionStats.actionBar - before.actionBar
      },
      mode: outcome.mode,
      panelOpen: outcome.panelOpen,
      attempts: attemptLog.slice(-12),
      durationOptions: outcome.options,
      choseThirty: outcome.chosen,
      panelTexts: panel
    };
    appendCapture({ ts: new Date().toISOString(), event: 'capability_probe', account: account.name, ...result });
    return result;
  }

  async function startJob(spec) {
    const account = findAccount(spec.accountId);
    if (!account) throw new Error('Tài khoản không tồn tại');
    if (activeJobs.size > 0) throw new Error('Đang có việc chạy, chờ việc hiện tại xong đã');
    const job = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accountId: account.id,
      accountName: account.name,
      prompt: String(spec.prompt || '').trim(),
      duration: Number(spec.duration) || 30,
      ratio: String(spec.ratio || '16:9'),
      model: String(spec.model || 'Dreamina Seedance 2.5'),
      images: Array.isArray(spec.images) ? spec.images.slice(0, 6) : [],
      status: 'queued',
      message: 'Đã nhận việc',
      canceled: false,
      media: null,
      log: []
    };
    if (!job.prompt) throw new Error('Chưa có đoạn mô tả');
    jobs.unshift(job);
    saveJobs();
    appendCapture({ ts: job.createdAt, event: 'job_created', jobId: job.id, account: account.name, duration: job.duration, ratio: job.ratio, model: job.model, images: job.images.length, promptChars: job.prompt.length });

    const controller = { job, cancel: () => { job.canceled = true; } };
    activeJobs.set(job.id, controller);
    runJob(job, account).catch((error) => {
      setStatus(job, job.status === 'canceled' ? 'canceled' : 'failed', `Lỗi: ${String((error && error.message) || error)}`);
    }).finally(() => {
      activeJobs.delete(job.id);
      saveJobs();
    });
    return job;
  }

  async function runJob(job, account) {
    setStatus(job, 'running', 'Đang mở phiên Dola của tài khoản…');
    const wc = await resolveTarget(account);
    await pageHelpers(wc);
    await waitForPage(wc);

    const login = await resolveLogin(wc);
    if (!login.loggedIn) {
      setStatus(job, 'needs_login', 'Tài khoản chưa đăng nhập. Mở cửa sổ Dola lên đăng nhập rồi chạy lại.');
      return;
    }
    if (login.nickname) log(job, `Tài khoản đang đăng nhập: ${login.nickname}`);

    // Bật thêm số giây vào cấu hình ở tầng mạng, rồi tải lại trang để mọi cấu hình
    // được nạp lại qua đường đã sửa (trang nạp cấu hình từ lúc khởi động).
    const injected = await enableCapabilityInjection(wc, DEFAULT_DURATIONS);
    if (injected) {
      await wc.reload();
      await waitForPage(wc);
      await pageHelpers(wc);
    }
    enableChainCapture(wc, account.id);
    chainBodies.set(account.id, []);
    await evaluate(wc, buildPageScript({ durations: DEFAULT_DURATIONS, duration: job.duration }));
    const baseline = await readRunnerState(wc).catch(() => null);
    const baselineVids = new Set(extractVideos(baseline && baseline.body).map((item) => item.vid));

    setStatus(job, 'running', 'Đang chọn chế độ tạo video…');
    const panelAttempts = [];
    const panelOutcome = await ensurePanelAndDuration(wc, job.duration, panelAttempts);
    log(job, panelOutcome.panelOpen ? 'Đã mở bảng chọn tạo video' : 'Không mở được bảng chọn, vẫn thử tiếp');
    if (panelOutcome.chosen) {
      log(job, `Số giây ${job.duration}s do trang tự chọn (${panelOutcome.mode})`);
    } else {
      log(job, `Bảng chọn không có ${job.duration}s (ô chọn: ${(panelOutcome.options || []).join(', ') || 'không đọc được'}) → sẽ sửa yêu cầu trước khi gửi`);
    }

    const modelResult = await selectOption(wc, ['2.5', '2.0 Fast', '1.0', 'Fast', 'Model'], job.model);
    log(job, `Mô hình: ${modelResult.chosen ? 'đã chọn ' + job.model : 'không đổi được (giữ mặc định)'}`);
    const ratioResult = await selectOption(wc, ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9', 'Ratio'], job.ratio);
    log(job, `Khung hình: ${ratioResult.chosen ? 'đã chọn ' + job.ratio : 'không đổi được (giữ mặc định)'}`);
    // Chọn lại số giây sau cùng: đổi mô hình hoặc khung hình có thể làm bảng chọn vẽ lại.
    const durationFinal = await selectDuration(wc, job.duration);
    if (durationFinal.chosen) log(job, `Số giây: đã chốt ${job.duration}s`);
    else if (panelOutcome.chosen) log(job, `Số giây: giữ ${job.duration}s đã chọn trước đó`);
    else log(job, `Số giây: bảng chọn không có ${job.duration}s, sẽ sửa yêu cầu trước khi gửi`);

    if (job.images.length) {
      await attachImages(wc, job.images);
      log(job, `Đã gắn ${job.images.length} ảnh mẫu, chờ tải lên…`);
      await sleep(12000);
    }

    const typed = await setComposerText(wc, job.prompt);
    log(job, `Đã nhập ${typed}/${job.prompt.length} ký tự mô tả`);
    if (typed < job.prompt.length * 0.9) log(job, 'Cảnh báo: nội dung nhập vào chưa đủ, vẫn tiếp tục gửi');

    setStatus(job, 'submitting', 'Đang gửi yêu cầu…');
    await sendEnter(wc);

    // Sau khi gửi, chờ kết quả. Bắt đầu bằng việc xác nhận trang đã nhận việc.
    await sleep(6000);
    const afterSend = await readRunnerState(wc).catch(() => null);
    if (afterSend && afterSend.patchedRequests > 0) log(job, 'Bảng chọn chưa có số giây này, đã sửa yêu cầu trước khi gửi (đường lùi)');
    if (afterSend && afterSend.patchedResponses > 0) log(job, 'Đã thêm lựa chọn số giây vào bảng chọn của trang (đường sạch)');

    try {
      const href = await evaluate(wc, 'location.href');
      if (href && /\/chat\/\d+/.test(href)) {
        job.conversationHref = href;
        const convId = (href.match(/\/chat\/(\d+)/) || [])[1];
        const title = await evaluate(wc, `(() => {
          const links = Array.from(document.querySelectorAll('a[href^="/chat/"]'));
          const match = links.find((a) => (a.getAttribute('href') || '').indexOf(${JSON.stringify(String(convId))}) !== -1);
          return match ? (match.innerText || '').trim().split('\\n')[0].slice(0, 60) : null;
        })()`).catch(() => null);
        if (title) job.conversationTitle = title;
      }
    } catch (_) { /* bỏ qua */ }
    setStatus(job, 'accepted', 'Máy chủ đã nhận, đang vẽ video…');
    const timeoutMs = Number(process.env.DOLA_JOB_TIMEOUT_MS || 30 * 60 * 1000);
    const deadline = Date.now() + timeoutMs;
    let newVideo = null;
    let pollRounds = 0;

    while (Date.now() < deadline) {
      if (job.canceled) { setStatus(job, 'canceled', 'Đã dừng theo yêu cầu'); return; }
      await sleep(12000);
      pollRounds += 1;
      // Cứ ~2 phút mở lại hội thoại một lần: khung Dola nhận kết quả qua kênh đẩy nên
      // có thể không tự hỏi lại danh sách tin nhắn. Phải mở ĐÚNG hội thoại của việc,
      // vì tải lại trang thường chỉ về màn hình chính và không có tin nhắn nào.
      if (pollRounds % 10 === 0 && job.conversationHref) {
        try {
          await fetchConversationIntoCapture(account, job.conversationHref);
          log(job, 'Đã đọc lại hội thoại của việc trong cửa sổ ẩn để cập nhật kết quả');
        } catch (_) { /* lần sau thử lại */ }
      }
      const bodies = chainBodies.get(account.id) || [];
      const foundVideos = [];
      for (const entry of bodies) {
        for (const video of extractVideos(entry.body)) {
          if (!baselineVids.has(video.vid)) foundVideos.push(video);
        }
      }
      if (foundVideos.length) { newVideo = foundVideos[0]; break; }
      const tail = await evaluate(wc, `(document.body.innerText || '').slice(-1500)`).catch(() => '');
      if (hasLogInMarker(tail)) {
        setStatus(job, 'needs_login', 'Phiên đăng nhập đã hết hạn giữa lúc chạy. Đăng nhập lại rồi chạy lại.');
        return;
      }
      // Máy chủ từ chối vì thiếu credit hoặc tham số không hợp lệ — dừng ngay và nói rõ số liệu.
      const refusal = matchRefusal(tail);
      if (refusal) {
        setStatus(job, 'failed', refusal.summary);
        log(job, `Máy chủ trả lời: "${refusal.text}"`);
        return;
      }
      if (/something went wrong|went wrong|please try again|not enough credit|insufficient/i.test(tail)) {
        const matched = (tail.match(/[^\n]{0,120}(?:something went wrong|went wrong|please try again|not enough credit|insufficient)[^\n]{0,120}/i) || [tail.slice(-200)])[0];
        setStatus(job, 'failed', `Dola báo lỗi: "${matched.trim()}"`);
        return;
      }
      setStatus(job, 'generating', 'Vẫn đang vẽ… (video dài thường mất 5–15 phút)');
    }

    if (!newVideo) {
      setStatus(job, 'failed', 'Hết thời gian chờ mà chưa thấy video trả về.');
      return;
    }

    setStatus(job, 'generating', 'Đã có video, đang tải bản không dấu chìm…');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const baseName = `${slugify(job.accountName || 'dola')}-${job.duration}s-${stamp}`;
    const ses = wc.session;
    const media = { vid: newVideo.vid, reportedDuration: newVideo.duration, width: newVideo.width, height: newVideo.height };

    async function download(url, suffix) {
      if (!url) return null;
      const res = await ses.fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`tải thất bại: HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const file = path.join(outputsDir, `${baseName}-${suffix}.mp4`);
      fs.writeFileSync(file, buffer);
      const probe = await probeFfprobe(file);
      return {
        file,
        bytes: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        probe
      };
    }

    try {
      const clean = await download(newVideo.mainUrl, 'unwatermarked');
      const client = await download(newVideo.downloadUrl, 'client');
      media.unwatermarked = clean ? { file: clean.file, bytes: clean.bytes, sha256: clean.sha256 } : null;
      media.client = client ? { file: client.file, bytes: client.bytes, sha256: client.sha256 } : null;
      const probe = (clean && clean.probe) || (client && client.probe) || null;
      if (probe) {
        media.durationSeconds = probe.durationSeconds;
        media.width = probe.width || media.width;
        media.height = probe.height || media.height;
        media.videoCodec = probe.videoCodec;
        media.audioCodec = probe.audioCodec;
      }
      job.media = media;
      setStatus(job, 'completed', `Xong: ${media.durationSeconds ? media.durationSeconds.toFixed(2) + ' giây' : (media.reportedDuration || '?') + ' giây'}, ${media.width || '?'}x${media.height || '?'}`);
      appendCapture({ ts: new Date().toISOString(), event: 'job_completed', jobId: job.id, account: job.accountName, vid: media.vid, duration: media.durationSeconds || media.reportedDuration, bytes: media.unwatermarked ? media.unwatermarked.bytes : null });
    } catch (error) {
      setStatus(job, 'failed', `Video đã xong nhưng tải về lỗi: ${String((error && error.message) || error)}`);
    }
  }

  // Hủy việc: nếu tiến trình còn sống thì dừng nó; nếu tiến trình đã mất (ứng dụng bị
  // đóng giữa lúc chờ) thì vẫn đánh dấu dừng để không chặn việc mới.
  function cancelJob(jobId) {
    const id = String(jobId || '');
    const controller = activeJobs.get(id);
    if (controller) {
      controller.cancel();
      setStatus(controller.job, 'canceled', 'Đã dừng theo yêu cầu');
      return true;
    }
    const job = jobs.find((item) => item.id === id);
    if (!job) return false;
    const active = ['queued', 'running', 'submitting', 'accepted', 'generating'];
    if (!active.includes(job.status)) return false;
    job.canceled = true;
    setStatus(job, 'canceled', 'Đã đánh dấu dừng (không còn tiến trình theo dõi trong ứng dụng)');
    return true;
  }

  // Hủy mọi việc đang dang dở của một tài khoản — dùng cho nút "Tạo việc mới".
  function cancelActiveJobs(accountId) {
    const active = ['queued', 'running', 'submitting', 'accepted', 'generating'];
    let stopped = 0;
    for (const job of jobs) {
      if (accountId && job.accountId !== String(accountId)) continue;
      if (!active.includes(job.status)) continue;
      if (cancelJob(job.id)) stopped += 1;
    }
    return stopped;
  }

  // Xem nhanh trạng thái trang của một tài khoản: đang mở hội thoại nào, chữ hiển thị
  // cuối trang, và có video nào trong dữ liệu hội thoại vừa nhận không. Không gửi gì.
  async function inspectAccount(accountId, options) {
    const account = findAccount(accountId);
    if (!account) return { ok: false, error: 'Không thấy tài khoản' };
    const wc = await resolveTarget(account);
    await pageHelpers(wc);
    if (options && options.title) {
      const links = await evaluate(wc, `(() => Array.from(document.querySelectorAll('a[href^="/chat/"]'))
        .map((a) => ({ href: a.getAttribute('href'), text: (a.innerText || '').trim().replace(/\s+/g, ' ') }))
        .filter((item) => /^\/chat\/\d+$/.test(item.href || '')))()`).catch(() => []);
      const needle = String(options.title).toLowerCase();
      const match = (links || []).find((item) => item.text.toLowerCase().includes(needle));
      if (match) {
        await wc.loadURL('https://www.dola.com' + match.href);
        await waitForPage(wc);
        await pageHelpers(wc);
        await evaluate(wc, buildPageScript({ durations: DEFAULT_DURATIONS, duration: 15 }));
        await sleep(5000);
      }
    }
    const href = await evaluate(wc, 'location.href').catch(() => null);
    const tail = await evaluate(wc, `(document.body.innerText || '').slice(-1500)`).catch(() => '');
    const state = await readRunnerState(wc).catch(() => null);
    const videos = extractVideos(state && state.body);
    return {
      ok: true,
      href,
      runnerInstalled: Boolean(state),
      patched: state ? { requests: state.patchedRequests, responses: state.patchedResponses } : null,
      chainVideos: videos.map((item) => ({ vid: item.vid, duration: item.duration, width: item.width, height: item.height })),
      tail: String(tail || '').replace(/\s+/g, ' ').slice(-800)
    };
  }

  // Danh sách hội thoại trong thanh bên của tài khoản (để "Lấy video từ hội thoại").
  async function listConversations(accountId) {
    const account = findAccount(accountId);
    if (!account) return { ok: false, error: 'Không thấy tài khoản' };
    const wc = await resolveTarget(account);
    await pageHelpers(wc);
    const links = await evaluate(wc, `(() => Array.from(document.querySelectorAll('a[href^="/chat/"]'))
      .map((a) => ({ href: a.getAttribute('href'), text: (a.innerText || '').trim().replace(/\\s+/g, ' ').split(' ')[0] === '' ? '' : (a.innerText || '').trim().replace(/\\s+/g, ' ') }))
      .filter((item) => /^\\/chat\\/\\d+$/.test(item.href || '') && item.text))()`).catch(() => []);
    const seen = new Set();
    const conversations = [];
    for (const item of links || []) {
      const key = item.href + '|' + item.text;
      if (seen.has(key)) continue;
      seen.add(key);
      conversations.push(item);
    }
    return { ok: true, loggedIn: true, conversations: conversations.slice(0, 30) };
  }

  // Mở một hội thoại rồi tải về TẤT CẢ video có trong đó (bản sạch + bản của trang).
  async function getVideosFromConversation(accountId, options) {
    const account = findAccount(accountId);
    if (!account) throw new Error('Không thấy tài khoản');
    const wc = await resolveTarget(account);
    await pageHelpers(wc);
    const login = await resolveLogin(wc);
    if (!login.loggedIn) throw new Error('Tài khoản chưa đăng nhập');

    const title = options && options.title ? String(options.title) : null;
    const href = options && options.href ? String(options.href) : null;
    if (!href && !title) throw new Error('Chưa chỉ hội thoại cần lấy');

    // Xác định địa chỉ hội thoại: ưu tiên href, không có thì nạp danh sách từ khung
    // webview của ứng dụng rồi tra theo tên (thử vài lần vì danh sách nạp trễ).
    // Danh sách trả về đường dẫn tương đối (/chat/<id>) nên phải ghép thành địa chỉ đầy đủ.
    let conversationHref = null;
    if (href) {
      const value = String(href).trim();
      conversationHref = /^https?:\/\//i.test(value)
        ? value
        : (value.startsWith('/') ? `https://www.dola.com${value}` : null);
    }
    if (!conversationHref) {
      let links = [];
      for (let attempt = 0; attempt < 3 && !links.length; attempt += 1) {
        const listing = await listConversations(account.id).catch(() => null);
        links = (listing && listing.conversations) || [];
        if (!links.length) await sleep(2500);
      }
      const needle = title.toLowerCase();
      const match = (links || []).find((item) => item.text.toLowerCase().includes(needle));
      if (!match) {
        throw new Error(`Không thấy hội thoại "${title}". Danh sách hiện có: ${links.map((item) => item.text).slice(0, 8).join(', ') || '(trống)'}`);
      }
      conversationHref = 'https://www.dola.com' + match.href;
    }

    enableChainCapture(wc, account.id);
    chainBodies.set(account.id, []);
    await fetchConversationIntoCapture(account, conversationHref);

    let videos = [];
    for (let attempt = 0; attempt < 4 && !videos.length; attempt += 1) {
      const bodies = chainBodies.get(account.id) || [];
      for (const entry of bodies) videos = videos.concat(extractVideos(entry.body));
      if (!videos.length) {
        await fetchConversationIntoCapture(account, conversationHref);
      }
    }
    const unique = new Map();
    for (const video of videos) if (video.vid && !unique.has(video.vid)) unique.set(video.vid, video);
    videos = [...unique.values()];
    if (!videos.length) return { ok: true, downloaded: [], message: 'Hội thoại này chưa có video nào' };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const titleSlug = slugify(title || '') || 'hoi-thoai';
    const baseName = `${titleSlug}-${stamp}`;
    const results = [];
    let videoIndex = 0;
    for (const video of videos) {
      videoIndex += 1;
      const itemBase = videos.length > 1 ? `${baseName}-${videoIndex}` : baseName;
      async function download(url, suffix) {
        if (!url) return null;
        const res = await wc.session.fetch(url, { method: 'GET' });
        if (!res.ok) throw new Error(`tải thất bại: HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const file = path.join(outputsDir, `${itemBase}-${suffix}.mp4`);
        fs.writeFileSync(file, buffer);
        const probe = await probeFfprobe(file);
        return { file, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), probe };
      }
      try {
        const clean = await download(video.mainUrl, 'unwatermarked');
        const client = await download(video.downloadUrl, 'client');
        results.push({
          vid: video.vid,
          reportedDuration: video.duration,
          unwatermarked: clean ? { file: clean.file, bytes: clean.bytes, sha256: clean.sha256, durationSeconds: clean.probe ? clean.probe.durationSeconds : null } : null,
          client: client ? { file: client.file, bytes: client.bytes, sha256: client.sha256 } : null
        });
      } catch (error) {
        results.push({ vid: video.vid, error: String((error && error.message) || error) });
      }
    }
    appendCapture({ ts: new Date().toISOString(), event: 'conversation_media', account: account.name, title, count: results.length });
    return { ok: true, conversation: title || conversationHref, downloaded: results };
  }

  // Cứu kết quả: mở lại hội thoại của việc rồi lấy video mới nhất về máy.
  // Dùng khi ứng dụng bị đóng/khởi động lại giữa lúc chờ (việc trên máy chủ vẫn chạy tiếp).
  async function recoverJob(jobId, options) {
    const job = jobs.find((item) => item.id === String(jobId || ''));
    if (!job) throw new Error('Không thấy việc này');
    const account = findAccount(job.accountId);
    if (!account) throw new Error('Không thấy tài khoản của việc này');
    const wc = await resolveTarget(account);
    await pageHelpers(wc);
    await waitForPage(wc);
    const login = await resolveLogin(wc);
    if (!login.loggedIn) return { ok: false, error: 'Tài khoản chưa đăng nhập' };

    const install = async () => {
      await evaluate(wc, buildPageScript({ durations: DEFAULT_DURATIONS, duration: job.duration }));
    };
    await install();

    // Mở đúng hội thoại của việc: ưu tiên địa chỉ đã ghi lúc gửi, rồi tới tên hội thoại.
    const links = await evaluate(wc, `(() => Array.from(document.querySelectorAll('a[href^="/chat/"]'))
      .map((a) => ({ href: a.getAttribute('href'), text: (a.innerText || '').trim().replace(/\\s+/g, ' ') }))
      .filter((item) => /^\\/chat\\/\\d+$/.test(item.href || '')))()`).catch(() => []);
    let href = null;
    if (job.conversationHref) {
      const match = (links || []).find((item) => `https://www.dola.com${item.href}` === job.conversationHref);
      href = match ? match.href : job.conversationHref.replace('https://www.dola.com', '');
    }
    if (!href && options && options.title) {
      const needle = String(options.title).toLowerCase();
      const match = (links || []).find((item) => item.text.toLowerCase().includes(needle));
      if (match) href = match.href;
    }
    if (!href && links && links.length) href = links[0].href;
    if (href) {
      await fetchConversationIntoCapture(account, 'https://www.dola.com' + href);
    }

    let videos = extractVideos((readChainSnapshot(wc, account.id) || {}).body);
    if (!videos.length) {
      await sleep(6000);
      await fetchConversationIntoCapture(account, 'https://www.dola.com' + href);
      videos = extractVideos((readChainSnapshot(wc, account.id) || {}).body);
    }
    if (!videos.length) return { ok: false, error: 'Chưa thấy video nào trong hội thoại mới nhất' };

    const newest = videos[0];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const baseName = `${slugify(job.accountName || 'dola')}-${job.duration}s-${stamp}`;
    const media = { vid: newest.vid, reportedDuration: newest.duration, width: newest.width, height: newest.height };

    async function download(url, suffix) {
      if (!url) return null;
      const res = await wc.session.fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`tải thất bại: HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const file = path.join(outputsDir, `${baseName}-${suffix}.mp4`);
      fs.writeFileSync(file, buffer);
      const probe = await probeFfprobe(file);
      return { file, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), probe };
    }

    const clean = await download(newest.mainUrl, 'unwatermarked');
    const client = await download(newest.downloadUrl, 'client');
    media.unwatermarked = clean ? { file: clean.file, bytes: clean.bytes, sha256: clean.sha256 } : null;
    media.client = client ? { file: client.file, bytes: client.bytes, sha256: client.sha256 } : null;
    const probe = (clean && clean.probe) || (client && client.probe) || null;
    if (probe) {
      media.durationSeconds = probe.durationSeconds;
      media.width = probe.width || media.width;
      media.height = probe.height || media.height;
      media.videoCodec = probe.videoCodec;
      media.audioCodec = probe.audioCodec;
    }
    job.media = media;
    setStatus(job, 'completed', `Xong (lấy lại sau khi khởi động lại): ${media.durationSeconds ? media.durationSeconds.toFixed(2) + ' giây' : (media.reportedDuration || '?') + ' giây'}, ${media.width || '?'}x${media.height || '?'}`);
    appendCapture({ ts: new Date().toISOString(), event: 'job_recovered', jobId: job.id, account: job.accountName, vid: media.vid, duration: media.durationSeconds || media.reportedDuration });
    return { ok: true, media };
  }

  function listJobs() {
    return jobs.map((job) => ({
      id: job.id,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      accountId: job.accountId,
      accountName: job.accountName,
      promptPreview: job.prompt.slice(0, 160),
      promptChars: job.prompt.length,
      duration: job.duration,
      ratio: job.ratio,
      model: job.model,
      imageCount: job.images.length,
      status: job.status,
      message: job.message,
      media: job.media,
      log: job.log.slice(-12)
    }));
  }

  function saveUpload(name, dataUrl) {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!match) throw new Error('Ảnh không đúng định dạng dữ liệu');
    const mime = match[1];
    const ext = mime.includes('png') ? '.png' : mime.includes('jpeg') || mime.includes('jpg') ? '.jpg' : mime.includes('webp') ? '.webp' : null;
    if (!ext) throw new Error('Chỉ nhận ảnh png, jpg, webp');
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 12 * 1024 * 1024) throw new Error('Ảnh quá lớn (tối đa 12MB)');
    const safe = slugify(path.parse(String(name || 'image')).name) || 'image';
    const file = path.join(uploadsDir, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safe}${ext}`);
    fs.writeFileSync(file, buffer);
    return { file, bytes: buffer.length, name: path.basename(file) };
  }

  return {
    startJob,
    cancelJob,
    cancelActiveJobs,
    recoverJob,
    listConversations,
    getVideosFromConversation,
    inspectAccount,
    probeCapability,
    enableDurationForAccount,
    listJobs,
    checkAccount,
    saveUpload,
    targets,
    forgetTarget,
    defaults: {
      durations: DEFAULT_DURATIONS,
      ratios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'],
      models: ['Dreamina Seedance 2.5', 'Dreamina Seedance 2.0 Fast', 'Dreamina Seedance 1.0'],
      defaultDuration: 30,
      defaultRatio: '16:9',
      defaultModel: 'Dreamina Seedance 2.5'
    }
  };
}

module.exports = { createJobRunner };
