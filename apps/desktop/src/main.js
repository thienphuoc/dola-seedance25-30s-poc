'use strict';

const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createDailyCapacityStore } = require('./shared/daily-capacity');
const { createJobRunner } = require('./job-runner');
const { createWebServer } = require('./web-server');

let mainWindow = null;
let jobRunner = null;

function dataPath() {
  return path.join(app.getPath('userData'), 'accounts.json');
}

function capacityPath() {
  return path.join(app.getPath('userData'), 'dola-daily-capacity.jsonl');
}

// --- D2 protocol observer (sanitized, local-only; captures/raw is gitignored) ---
const capturesDir = path.join(__dirname, '..', '..', '..', 'captures', 'raw');
const SENSITIVE_PARAM_RE = /(cookie|token|sign|mstoken|verifyfp|s_v_web_id|ttwid|sessionid|license)/i;
const SENSITIVE_JSON_KEY_RE = /("(?:[^"]*(?:cookie|token|authorization|password|sessionid)[^"]*)"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|null|true|false|\d+)/gi;
const STATIC_ASSET_RE = /\.(?:js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm)(?:$|[?#])/i;

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

function sanitizeBody(raw) {
  if (raw === undefined || raw === null) return null;
  const redacted = String(raw).replace(SENSITIVE_JSON_KEY_RE, '$1"<redacted>"');
  return redacted.slice(0, 8192);
}

function appendCapture(record) {
  try {
    fs.mkdirSync(capturesDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(capturesDir, `desktop-${day}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (_) {
    // observing must never break the app
  }
}

function observeWebview(wc) {
  const dbg = wc.debugger;
  if (!dbg || dbg.isAttached()) return;
  try {
    dbg.attach('1.3');
  } catch (error) {
    appendCapture({
      ts: new Date().toISOString(),
      event: 'observer_attach_failed',
      webContentsId: wc.id,
      type: wc.getType(),
      error: String((error && error.message) || error)
    });
    return;
  }
  appendCapture({
    ts: new Date().toISOString(),
    event: 'observer_attached',
    webContentsId: wc.id,
    type: wc.getType()
  });
  const mimeByRequest = new Map();
  const urlByRequest = new Map();
  const wsUrlsByRequest = new Map();
  try {
    dbg.sendCommand('Network.enable', { maxPostDataSize: 65536 });
  } catch (_) { /* ignore */ }
  dbg.on('message', async (_event, method, params) => {
    if (!params) return;
    const ts = new Date().toISOString();
    if (method === 'Network.webSocketCreated') {
      const wsUrl = sanitizeUrl(params.url || '');
      wsUrlsByRequest.set(params.requestId, wsUrl);
      if (/dola\.com/i.test(wsUrl)) {
        appendCapture({ ts, event: 'ws_created', requestId: params.requestId, url: wsUrl });
      }
      return;
    }
    if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
      const wsUrl = wsUrlsByRequest.get(params.requestId) || '';
      if (!/dola\.com/i.test(wsUrl)) return;
      const data = params.response && params.response.payload ? params.response.payload.data : null;
      appendCapture({
        ts,
        event: method === 'Network.webSocketFrameReceived' ? 'ws_frame_recv' : 'ws_frame_sent',
        requestId: params.requestId,
        data: sanitizeBody(data === null || data === undefined ? null : String(data).slice(0, 2048))
      });
      return;
    }
    const url = (params.request && params.request.url)
      || (params.response && params.response.url)
      || '';
    if (!url || !/dola\.com/i.test(url) || STATIC_ASSET_RE.test(url)) return;
    if (method === 'Network.requestWillBeSent') {
      const req = params.request || {};
      urlByRequest.set(params.requestId, req.url);
      let body = req.postData !== undefined ? sanitizeBody(req.postData) : null;
      if ((body === null || body === undefined) && req.hasPostData === true) {
        try {
          const postData = await dbg.sendCommand('Network.getRequestPostData', { requestId: params.requestId });
          body = sanitizeBody(postData.postData);
        } catch (_) {
          // buffer unavailable; leave null
        }
      }
      appendCapture({
        ts,
        event: 'request',
        requestId: params.requestId,
        method: req.method,
        url: sanitizeUrl(req.url),
        resourceType: params.type || null,
        body
      });
    } else if (method === 'Network.responseReceived') {
      const res = params.response || {};
      mimeByRequest.set(params.requestId, res.mimeType || null);
      if (res.url) urlByRequest.set(params.requestId, res.url);
      appendCapture({
        ts,
        event: 'response',
        requestId: params.requestId,
        status: res.status,
        mimeType: res.mimeType || null,
        url: sanitizeUrl(res.url)
      });
    } else if (method === 'Network.loadingFinished') {
      const rawUrl = urlByRequest.get(params.requestId) || '';
      const mimeType = mimeByRequest.get(params.requestId) || '';
      const diag = {
        ts,
        event: 'dbg_loading_finished',
        requestId: params.requestId,
        haveUrl: Boolean(rawUrl),
        urlOk: /dola\.com/i.test(rawUrl),
        staticOk: !STATIC_ASSET_RE.test(rawUrl),
        mimeType: mimeType || null
      };
      appendCapture(diag);
      if (!rawUrl || !/dola\.com/i.test(rawUrl) || STATIC_ASSET_RE.test(rawUrl)) return;
      if (!/json|event-stream|text\/plain/i.test(mimeType)) return;
      try {
        const result = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        appendCapture({
          ts,
          event: 'response_body',
          requestId: params.requestId,
          mimeType: mimeType || null,
          base64Encoded: result.base64Encoded === true,
          body: sanitizeBody(result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body)
        });
      } catch (error) {
        appendCapture({
          ts,
          event: 'dbg_get_body_failed',
          requestId: params.requestId,
          error: String((error && error.message) || error)
        });
      }
    } else if (method === 'Network.loadingFailed') {
      appendCapture({
        ts,
        event: 'load_failed',
        requestId: params.requestId,
        error: params.errorText || null,
        canceled: params.canceled === true
      });
    }
  });
  dbg.on('detach', () => {
    mimeByRequest.clear();
  });
}

app.on('web-contents-created', (_event, wc) => {
  if (wc.getType() !== 'webview') return;
  observeWebview(wc);
  wc.on('dom-ready', () => observeWebview(wc));
});
// --- end observer ---

function normalizeAccount(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '').trim();
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(id)) return null;
  const name = String(value.name || 'Tài khoản Dola').replace(/[\r\n\t]/g, ' ').trim().slice(0, 80) || 'Tài khoản Dola';
  return {
    id,
    name,
    partition: `persist:dola_${id}`,
    createdAt: Number(value.createdAt) || Date.now()
  };
}

function loadAccounts() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
    if (!Array.isArray(parsed.accounts)) return [];
    return parsed.accounts.map(normalizeAccount).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function saveAccounts(accounts) {
  const clean = accounts.map(normalizeAccount).filter(Boolean);
  fs.mkdirSync(path.dirname(dataPath()), { recursive: true });
  fs.writeFileSync(dataPath(), JSON.stringify({ accounts: clean }, null, 2), 'utf8');
  return clean;
}

function createAccount(name) {
  const accounts = loadAccounts();
  const account = normalizeAccount({
    id: crypto.randomUUID().replace(/-/g, ''),
    name,
    createdAt: Date.now()
  });
  accounts.push(account);
  saveAccounts(accounts);
  return account;
}

async function clearAccountSession(accountId) {
  const account = loadAccounts().find(item => item.id === String(accountId || ''));
  if (!account) return false;
  const ses = session.fromPartition(account.partition);
  await ses.clearStorageData();
  await ses.clearCache();
  return true;
}

const DOLA_COOKIE_SUFFIX = '.dola.com';
const MAX_IMPORT_COOKIES = 200;

function toElectronCookie(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const name = String(entry.name || '').trim();
  const value = String(entry.value || '');
  if (!name || !value) return null;
  let domain = String(entry.domain || '').toLowerCase().trim();
  if (!domain.endsWith(DOLA_COOKIE_SUFFIX)) return null;
  if (!domain.startsWith('.')) domain = `.${domain}`;
  const rawSameSite = entry.sameSite == null ? 'unspecified' : String(entry.sameSite).toLowerCase();
  const sameSite = ['unspecified', 'no_restriction', 'lax', 'strict'].includes(rawSameSite)
    ? rawSameSite
    : 'unspecified';
  const details = {
    url: 'https://www.dola.com',
    name,
    value,
    domain,
    path: String(entry.path || '/').trim() || '/',
    secure: entry.secure !== false,
    httpOnly: entry.httpOnly === true,
    sameSite
  };
  if (entry.session !== true && Number.isFinite(Number(entry.expirationDate))) {
    details.expirationDate = Number(entry.expirationDate);
  }
  return details;
}

async function importAccountCookies(accountId, payload) {
  const account = loadAccounts().find(item => item.id === String(accountId || ''));
  if (!account) return { imported: 0, skipped: 0 };
  const list = Array.isArray(payload)
    ? payload
    : (payload && Array.isArray(payload.cookies) ? payload.cookies : []);
  if (list.length > MAX_IMPORT_COOKIES) {
    throw new Error(`too many cookies (max ${MAX_IMPORT_COOKIES})`);
  }
  const ses = session.fromPartition(account.partition);
  let imported = 0;
  let skipped = 0;
  for (const entry of list) {
    const details = toElectronCookie(entry);
    if (!details) {
      skipped += 1;
      continue;
    }
    try {
      await ses.cookies.set(details);
      imported += 1;
    } catch (_) {
      skipped += 1;
    }
  }
  return { imported, skipped };
}

function deleteAccount(accountId) {
  const id = String(accountId || '');
  const before = loadAccounts();
  const account = before.find(item => item.id === id);
  const after = before.filter(item => item.id !== id);
  saveAccounts(after);
  return account || null;
}

// --- cầu nối để bàn điều khiển web điều khiển khung Dola có sẵn trong ứng dụng ---
const pendingWebviewRequests = new Map();

function activateAccountView(accountId) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.webContents.send('desktop:activate-account', String(accountId || ''));
  return true;
}

function refreshAccountViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop:refresh-accounts');
}

function resolveWebviewId(accountId, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) { resolve(null); return; }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (pendingWebviewRequests.has(requestId)) {
        pendingWebviewRequests.delete(requestId);
        resolve(null);
      }
    }, timeoutMs);
    pendingWebviewRequests.set(requestId, (webContentsId) => {
      clearTimeout(timer);
      resolve(webContentsId);
    });
    mainWindow.webContents.send('desktop:resolve-webview', { accountId: String(accountId || ''), requestId });
  });
}

// Ảnh từ popup được gửi lên dạng data URL (Electron mới không còn File.path), lưu ra đĩa rồi lấy đường dẫn.
function normalizeImagePayload(list) {
  if (!Array.isArray(list)) return [];
  const paths = [];
  for (const item of list.slice(0, 6)) {
    if (typeof item === 'string' && item) { paths.push(item); continue; }
    if (item && typeof item.dataUrl === 'string') {
      try {
        paths.push(jobRunner.saveUpload(item.name || 'image', item.dataUrl).file);
      } catch (_) { /* bỏ ảnh lỗi */ }
    }
  }
  return paths;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1050,
    minHeight: 700,
    title: 'Seedance Desktop Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    observeWebview(guest);
  });
}

app.whenReady().then(() => {
  ipcMain.handle('accounts:list', () => loadAccounts());
  ipcMain.handle('accounts:add', (_event, name) => createAccount(name));
  ipcMain.handle('accounts:remove', async (_event, id, clearSession) => {
    if (clearSession === true) await clearAccountSession(id);
    return deleteAccount(id);
  });
  ipcMain.handle('accounts:clear-session', (_event, id) => clearAccountSession(id));
  ipcMain.handle('accounts:import-cookies', (_event, id, cookies) => importAccountCookies(id, cookies));
  ipcMain.handle('accounts:enable-duration', (_event, id) => jobRunner.enableDurationForAccount(id));

  // Popup "Tạo video" trong studio: cùng bộ chạy việc với bàn điều khiển web.
  ipcMain.handle('video:defaults', () => jobRunner.defaults);
  ipcMain.handle('video:conversations', (_event, accountId) => jobRunner.listConversations(String(accountId || '')));
  ipcMain.handle('video:get-conversation', async (_event, payload) => {
    return await jobRunner.getVideosFromConversation(payload && payload.accountId, { title: payload && payload.title, href: payload && payload.href });
  });
  ipcMain.handle('video:create', async (_event, payload) => {
    const job = await jobRunner.startJob({
      accountId: payload && payload.accountId,
      prompt: payload && payload.prompt,
      duration: Number(payload && payload.duration),
      ratio: payload && payload.ratio,
      model: payload && payload.model,
      images: normalizeImagePayload(payload && payload.images)
    });
    return jobRunner.listJobs().find((item) => item.id === job.id) || null;
  });
  ipcMain.handle('video:jobs', (_event, accountId) => {
    const all = jobRunner.listJobs();
    return accountId ? all.filter((item) => item.accountId === accountId) : all.slice(0, 10);
  });
  ipcMain.handle('video:cancel', (_event, jobId) => jobRunner.cancelJob(jobId));
  ipcMain.handle('video:cancel-account', (_event, accountId) => jobRunner.cancelActiveJobs(String(accountId || '')));
  ipcMain.handle('video:open-outputs', async (_event, jobId) => {
    const job = jobRunner.listJobs().find((item) => item.id === String(jobId || ''));
    const file = job && job.media && job.media.unwatermarked && job.media.unwatermarked.file;
    if (file) {
      shell.showItemInFolder(file);
      return { ok: true, file };
    }
    shell.openPath(path.join(repoRoot, 'outputs'));
    return { ok: true, file: path.join(repoRoot, 'outputs') };
  });
  ipcMain.handle('capacity:report', () => createDailyCapacityStore(capacityPath()).report(loadAccounts()));
  ipcMain.handle('capacity:record-job', (_event, payload) => createDailyCapacityStore(capacityPath()).recordJob(payload || {}));
  ipcMain.handle('capacity:provider-state', (_event, payload) => createDailyCapacityStore(capacityPath()).recordProviderState(payload || {}));
  ipcMain.handle('capacity:next-account', (_event, afterAccountId) => {
    return createDailyCapacityStore(capacityPath()).nextAccount(loadAccounts(), { afterAccountId: String(afterAccountId || '') || null });
  });

  ipcMain.on('desktop:resolve-webview-result', (_event, payload) => {
    const requestId = payload && payload.requestId;
    const handler = pendingWebviewRequests.get(requestId);
    if (!handler) return;
    pendingWebviewRequests.delete(requestId);
    handler(payload.webContentsId === null || payload.webContentsId === undefined ? null : Number(payload.webContentsId));
  });

  // Bàn điều khiển web: nhận lệnh qua HTTP local rồi điều khiển khung Dola có sẵn.
  const repoRoot = path.join(__dirname, '..', '..', '..');
  jobRunner = createJobRunner({
    userDataDir: app.getPath('userData'),
    outputsDir: path.join(repoRoot, 'outputs'),
    uploadsDir: path.join(app.getPath('userData'), 'client', 'uploads'),
    jobsFile: path.join(app.getPath('userData'), 'client', 'jobs.json'),
    captureDir: capturesDir,
    getAccounts: loadAccounts,
    activateAccountView,
    refreshAccountViews,
    resolveWebviewId
  });
  const webServer = createWebServer({
    rootDir: repoRoot,
    webDir: path.join(__dirname, '..', 'web'),
    outputsDir: path.join(repoRoot, 'outputs'),
    runner: jobRunner,
    getAccounts: loadAccounts,
    addAccount: async (name, cookies) => {
      const accounts = loadAccounts();
      const target = createAccount(name || `Dola ${accounts.length + 1}`);
      const result = await importAccountCookies(target.id, cookies);
      if (!result.imported) throw new Error('Không nhận được cookie dola.com nào');
      return target;
    },
    removeAccount: (id) => deleteAccount(id),
    onAccountsChanged: refreshAccountViews
  });
  webServer.start()
    .then((url) => console.log(`Bàn điều khiển web: ${url}`))
    .catch((error) => console.error('Không mở được bàn điều khiển web:', error));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
