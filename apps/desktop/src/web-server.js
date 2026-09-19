'use strict';

/*
 * Bàn điều khiển web chạy local (127.0.0.1): phục vụ giao diện và nhận lệnh,
 * rồi chuyển cho bộ chạy việc điều khiển cửa sổ Dola của tài khoản.
 * Chỉ mở ở địa chỉ local, không lộ ra mạng ngoài.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp'
};

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function readJsonBody(req, limit = 128 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Dữ liệu gửi lên quá lớn')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (error) { reject(new Error('JSON không hợp lệ')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, file) {
  fs.readFile(file, (error, buffer) => {
    if (error) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Không thấy file'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buffer);
  });
}

// Phát video kèm hỗ trợ tua (HTTP Range) để xem ngay trên trang.
function serveMedia(res, file, download) {
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Không thấy video'); return; }
    const headers = {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store'
    };
    if (download) headers['content-disposition'] = `attachment; filename="${path.basename(file)}"`;
    const range = res.__range;
    if (range) {
      const [startText, endText] = range.replace(/bytes=/, '').split('-');
      const start = Number(startText) || 0;
      const end = endText ? Number(endText) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, Object.assign({}, headers, {
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'content-length': end - start + 1
      }));
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, Object.assign({}, headers, { 'content-length': stat.size }));
    fs.createReadStream(file).pipe(res);
  });
}

function createWebServer(options) {
  const rootDir = options.rootDir;
  const webDir = options.webDir;
  const outputsDir = options.outputsDir;
  const runner = options.runner;
  const getAccounts = options.getAccounts;
  const addAccount = options.addAccount;
  const removeAccount = options.removeAccount;
  const onAccountsChanged = options.onAccountsChanged;
  const port = Number(process.env.DOLA_WEB_CLIENT_PORT || options.port || 3211);
  const host = '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    const pathname = decodeURIComponent(url.pathname);
    res.__range = req.headers.range || null;

    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        serveStatic(res, path.join(webDir, 'index.html'));
        return;
      }
      if (req.method === 'GET' && /^\/(app|styles)\.(js|css)$/.test(pathname)) {
        serveStatic(res, path.join(webDir, pathname.slice(1)));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        const accounts = getAccounts().map((account) => ({ id: account.id, name: account.name, createdAt: account.createdAt }));
        sendJson(res, 200, { accounts, jobs: runner.listJobs(), defaults: runner.defaults });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/accounts') {
        const body = await readJsonBody(req);
        const cookies = Array.isArray(body.cookies) ? body.cookies : (body.cookies && Array.isArray(body.cookies.cookies) ? body.cookies.cookies : null);
        if (!cookies || !cookies.length) { sendJson(res, 400, { error: 'Chưa có cookie để nhận tài khoản' }); return; }
        const account = await addAccount(String(body.name || '').trim(), cookies);
        if (onAccountsChanged) onAccountsChanged();
        const check = await runner.checkAccount(account.id).catch((error) => ({ ok: false, error: String(error.message || error) }));
        sendJson(res, 200, { account: { id: account.id, name: account.name }, check });
        return;
      }

      const injectMatch = pathname.match(/^\/api\/accounts\/([a-zA-Z0-9]+)\/inject-duration$/);
      if (injectMatch && req.method === 'POST') {
        const result = await runner.enableDurationForAccount(injectMatch[1]);
        sendJson(res, 200, result);
        return;
      }

      const cancelJobsMatch = pathname.match(/^\/api\/accounts\/([a-zA-Z0-9]+)\/cancel-jobs$/);
      if (cancelJobsMatch && req.method === 'POST') {
        sendJson(res, 200, { stopped: runner.cancelActiveJobs(cancelJobsMatch[1]) });
        return;
      }

      const conversationMatch = pathname.match(/^\/api\/accounts\/([a-zA-Z0-9]+)\/(conversations|get-videos)$/);
      if (conversationMatch) {
        const accountId = conversationMatch[1];
        if (conversationMatch[2] === 'conversations' && req.method === 'GET') {
          sendJson(res, 200, await runner.listConversations(accountId));
          return;
        }
        if (conversationMatch[2] === 'get-videos' && req.method === 'POST') {
          const body = await readJsonBody(req);
          sendJson(res, 200, await runner.getVideosFromConversation(accountId, { title: body && body.title, href: body && body.href }));
          return;
        }
      }

      const inspectMatch = pathname.match(/^\/api\/accounts\/([a-zA-Z0-9]+)\/inspect$/);
      if (inspectMatch && req.method === 'POST') {
        const body = await readJsonBody(req);
        sendJson(res, 200, await runner.inspectAccount(inspectMatch[1], { title: body && body.title ? String(body.title) : null }));
        return;
      }

      const probeMatch = pathname.match(/^\/api\/accounts\/([a-zA-Z0-9]+)\/probe$/);
      if (probeMatch && req.method === 'POST') {
        const result = await runner.probeCapability(probeMatch[1], { simple: url.searchParams.get("simple") === "1" });
        sendJson(res, 200, result);
        return;
      }

      const accountMatch = pathname.match(/^\/api\/accounts\/([a-zA-Z0-9]+)(?:\/(check))?$/);
      if (accountMatch) {
        const accountId = accountMatch[1];
        if (req.method === 'POST' && accountMatch[2] === 'check') {
          const check = await runner.checkAccount(accountId);
          sendJson(res, 200, check);
          return;
        }
        if (req.method === 'DELETE') {
          runner.forgetTarget(accountId);
          const removed = removeAccount(accountId);
          sendJson(res, 200, { removed: Boolean(removed) });
          return;
        }
      }

      if (req.method === 'POST' && pathname === '/api/uploads') {
        const body = await readJsonBody(req);
        const saved = runner.saveUpload(body.name, body.dataUrl);
        sendJson(res, 200, saved);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/jobs') {
        const body = await readJsonBody(req);
        const job = await runner.startJob({
          accountId: body.accountId,
          prompt: body.prompt,
          duration: Number(body.duration),
          ratio: body.ratio,
          model: body.model,
          images: Array.isArray(body.images) ? body.images : []
        });
        sendJson(res, 200, { job: runner.listJobs().find((item) => item.id === job.id) });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/jobs') {
        sendJson(res, 200, { jobs: runner.listJobs() });
        return;
      }

      const jobAction = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9]+)\/(cancel|recover)$/);
      if (jobAction && req.method === 'POST') {
        if (jobAction[2] === 'cancel') {
          sendJson(res, 200, { canceled: runner.cancelJob(jobAction[1]) });
          return;
        }
        const body = await readJsonBody(req);
        const result = await runner.recoverJob(jobAction[1], { title: body && body.title ? String(body.title) : null });
        sendJson(res, 200, result);
        return;
      }

      const mediaMatch = pathname.match(/^\/api\/media\/([a-zA-Z0-9]+)\/(unwatermarked|client)(?:\/(download))?$/);
      if (mediaMatch && req.method === 'GET') {
        const job = runner.listJobs().find((item) => item.id === mediaMatch[1]);
        const kind = mediaMatch[2];
        const entry = job && job.media && job.media[kind];
        if (!entry || !entry.file) { sendJson(res, 404, { error: 'Việc này chưa có video' }); return; }
        const file = path.resolve(entry.file);
        if (!file.startsWith(path.resolve(outputsDir))) { sendJson(res, 403, { error: 'Ngoài thư mục cho phép' }); return; }
        serveMedia(res, file, Boolean(mediaMatch[3]));
        return;
      }

      sendJson(res, 404, { error: 'Không có đường dẫn này' });
    } catch (error) {
      sendJson(res, 500, { error: String((error && error.message) || error) });
    }
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(`http://${host}:${port}/`));
      });
    },
    stop() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    rootDir
  };
}

module.exports = { createWebServer };
