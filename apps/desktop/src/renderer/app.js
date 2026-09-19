'use strict';

const accountsEl = document.getElementById('accounts');
const webviewsEl = document.getElementById('webviews');
const emptyEl = document.getElementById('empty');
const addButton = document.getElementById('addAccount');
const reloadButton = document.getElementById('reload');
const clearButton = document.getElementById('clearSession');
const importCookiesButton = document.getElementById('importCookies');
const enableDurationButton = document.getElementById('enableDuration');
const cookieDialogBackdropEl = document.getElementById('cookieDialogBackdrop');
const cookieInputEl = document.getElementById('cookieInput');
const cookieConfirmButton = document.getElementById('cookieConfirm');
const cookieCancelButton = document.getElementById('cookieCancel');
const activeNameEl = document.getElementById('activeName');
const statusEl = document.getElementById('status');

const views = new Map();
let accounts = [];
let activeId = '';

function accountById(id) {
  return accounts.find(item => item.id === id) || null;
}

function ensureWebview(account) {
  if (views.has(account.id)) return views.get(account.id);

  const wrapper = document.createElement('div');
  wrapper.className = 'webview-wrapper';
  wrapper.dataset.accountId = account.id;

  const webview = document.createElement('webview');
  webview.src = 'https://www.dola.com/chat/';
  webview.partition = account.partition;
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('webpreferences', 'contextIsolation=yes');

  webview.addEventListener('did-start-loading', () => {
    if (activeId === account.id) statusEl.textContent = 'Đang tải trang Dola…';
  });
  webview.addEventListener('did-stop-loading', () => {
    if (activeId === account.id) statusEl.textContent = 'Đã tải xong phiên Dola; hãy đăng nhập hoặc sử dụng trực tiếp trên trang.';
  });
  webview.addEventListener('did-fail-load', (event) => {
    if (activeId === account.id && Number(event.errorCode) !== -3) {
      statusEl.textContent = `Không tải được trang Dola: ${event.errorDescription || event.errorCode}`;
    }
  });

  wrapper.appendChild(webview);
  webviewsEl.appendChild(wrapper);
  views.set(account.id, { wrapper, webview });
  return views.get(account.id);
}

function setActiveAccount(id) {
  activeId = id;
  const account = accountById(id);
  document.querySelectorAll('.account-card').forEach(el => {
    el.classList.toggle('active', el.dataset.accountId === id);
  });
  for (const [accountId, view] of views.entries()) {
    view.wrapper.classList.toggle('active', accountId === id);
  }

  if (!account) {
    emptyEl.hidden = false;
    activeNameEl.textContent = 'Chưa chọn tài khoản';
    statusEl.textContent = 'Thêm tài khoản để bắt đầu đăng nhập trong phiên Dola riêng';
    reloadButton.disabled = true;
    clearButton.disabled = true;
    importCookiesButton.disabled = true;
    enableDurationButton.disabled = true;
    document.getElementById('openComposer').disabled = true;
    return;
  }

  emptyEl.hidden = true;
  const view = ensureWebview(account);
  view.wrapper.classList.add('active');
  activeNameEl.textContent = account.name;
  statusEl.textContent = 'Phiên Dola riêng đã mở; trạng thái đăng nhập được lưu bền vững qua Chromium partition.';
  reloadButton.disabled = false;
  clearButton.disabled = false;
  importCookiesButton.disabled = false;
  enableDurationButton.disabled = false;
  document.getElementById('openComposer').disabled = false;
}

function renderAccounts() {
  accountsEl.replaceChildren();
  for (const account of accounts) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'account-card';
    card.dataset.accountId = account.id;
    card.innerHTML = `<span class="dot"></span><span class="account-copy"><strong></strong><small>Phiên riêng</small></span>`;
    card.querySelector('strong').textContent = account.name;
    card.addEventListener('click', () => setActiveAccount(account.id));
    accountsEl.appendChild(card);
    ensureWebview(account);
  }
  if (activeId && accountById(activeId)) setActiveAccount(activeId);
  else if (accounts[0]) setActiveAccount(accounts[0].id);
  else setActiveAccount('');
}

async function refreshAccounts() {
  accounts = await window.seedanceDesktop.listAccounts();
  renderAccounts();
}

const dialogBackdropEl = document.getElementById('dialogBackdrop');
const accountNameInput = document.getElementById('accountNameInput');
const dialogConfirmButton = document.getElementById('dialogConfirm');
const dialogCancelButton = document.getElementById('dialogCancel');

function suggestedAccountName() {
  return `Dola ${accounts.length + 1}`;
}

function openAddAccountDialog() {
  accountNameInput.value = suggestedAccountName();
  dialogBackdropEl.hidden = false;
  accountNameInput.focus();
  accountNameInput.select();
}

function closeAddAccountDialog() {
  dialogBackdropEl.hidden = true;
  accountNameInput.value = '';
}

async function submitAddAccount() {
  const name = accountNameInput.value.trim() || suggestedAccountName();
  closeAddAccountDialog();
  const account = await window.seedanceDesktop.addAccount(name);
  await refreshAccounts();
  setActiveAccount(account.id);
}

addButton.addEventListener('click', openAddAccountDialog);
dialogConfirmButton.addEventListener('click', () => { submitAddAccount().catch(console.error); });
dialogCancelButton.addEventListener('click', closeAddAccountDialog);
dialogBackdropEl.addEventListener('click', (event) => {
  if (event.target === dialogBackdropEl) closeAddAccountDialog();
});
accountNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitAddAccount().catch(console.error);
  } else if (event.key === 'Escape') {
    closeAddAccountDialog();
  }
});

reloadButton.addEventListener('click', () => {
  const view = views.get(activeId);
  if (view) view.webview.reload();
});

enableDurationButton.addEventListener('click', async () => {
  const account = accountById(activeId);
  if (!account) return;
  enableDurationButton.disabled = true;
  statusEl.textContent = 'Đang thêm lựa chọn số giây vào trang Dola của tài khoản này…';
  try {
    const result = await window.seedanceDesktop.enableDuration(account.id);
    if (result && result.ok) {
      const options = (result.options || []).join(', ') || 'không đọc được';
      statusEl.textContent = `Đã bật. Ô chọn số giây hiện có: ${options}`;
    } else {
      statusEl.textContent = `Không bật được: ${(result && result.error) || 'lỗi không rõ'}`;
    }
  } catch (error) {
    statusEl.textContent = `Lỗi khi bật: ${String(error && error.message || error)}`;
  } finally {
    enableDurationButton.disabled = false;
  }
});

clearButton.addEventListener('click', async () => {
  const account = accountById(activeId);
  if (!account) return;
  const confirmed = window.confirm(`Xác nhận xóa phiên đăng nhập Dola của "${account.name}" không?\n\nCác tài khoản khác không bị ảnh hưởng.`);
  if (!confirmed) return;
  await window.seedanceDesktop.clearAccountSession(account.id);
  const view = views.get(account.id);
  if (view) view.webview.loadURL('https://www.dola.com/chat/');
  statusEl.textContent = 'Đã xóa phiên cục bộ của tài khoản này, vui lòng đăng nhập lại.';
});

function openCookieDialog() {
  if (!activeId) return;
  cookieInputEl.value = '';
  cookieDialogBackdropEl.hidden = false;
  cookieInputEl.focus();
}

function closeCookieDialog() {
  cookieDialogBackdropEl.hidden = true;
  cookieInputEl.value = '';
}

function parseCookieList(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return null;
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.cookies)) return parsed.cookies;
  return null;
}

async function submitCookies() {
  const account = accountById(activeId);
  if (!account) return;
  const list = parseCookieList(cookieInputEl.value);
  if (!list) {
    statusEl.textContent = 'Cookie không đúng định dạng: cần mảng JSON (hoặc { cookies: [...] }).';
    return;
  }
  closeCookieDialog();
  const result = await window.seedanceDesktop.importCookies(account.id, list);
  statusEl.textContent = `Đã nhập ${result.imported} cookie vào "${account.name}" (bỏ qua ${result.skipped}). Đang tải lại Dola…`;
  const view = views.get(account.id);
  if (view) view.webview.reload();
}

importCookiesButton.addEventListener('click', openCookieDialog);
cookieCancelButton.addEventListener('click', closeCookieDialog);
cookieDialogBackdropEl.addEventListener('click', (event) => {
  if (event.target === cookieDialogBackdropEl) closeCookieDialog();
});
cookieConfirmButton.addEventListener('click', () => { submitCookies().catch(console.error); });
cookieInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeCookieDialog();
  } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submitCookies().catch(console.error);
  }
});

refreshAccounts().catch(error => {
  console.error(error);
  statusEl.textContent = 'Không đọc được cấu hình tài khoản.';
});

// Bàn điều khiển web điều khiển chính khung Dola trong ứng dụng này: nó cần
// chuyển sang đúng tài khoản và biết mã khung để gửi lệnh vào trang.
if (window.seedanceDesktop && window.seedanceDesktop.onActivateAccount) {
  window.seedanceDesktop.onActivateAccount((accountId) => {
    if (accountId && accountById(accountId)) setActiveAccount(accountId);
  });
}

if (window.seedanceDesktop && window.seedanceDesktop.onRefreshAccounts) {
  window.seedanceDesktop.onRefreshAccounts(() => {
    refreshAccounts().catch(console.error);
  });
}

if (window.seedanceDesktop && window.seedanceDesktop.onResolveWebview) {
  window.seedanceDesktop.onResolveWebview((payload) => {
    const { accountId, requestId } = payload;
    const view = views.get(accountId);
    let webContentsId = null;
    try {
      webContentsId = view && view.webview && typeof view.webview.getWebContentsId === 'function'
        ? view.webview.getWebContentsId()
        : null;
    } catch (_) {
      webContentsId = null;
    }
    window.seedanceDesktop.reportWebview({ requestId, accountId, webContentsId });
  });
}

// --- Popup "Tạo video" cho tài khoản đang chọn -------------------------------
const composerBackdrop = document.getElementById('composerBackdrop');
const composerAccountEl = document.getElementById('composerAccount');
const composerPromptEl = document.getElementById('composerPrompt');
const composerDurationEl = document.getElementById('composerDuration');
const composerRatioEl = document.getElementById('composerRatio');
const composerModelEl = document.getElementById('composerModel');
const composerImagesEl = document.getElementById('composerImages');
const composerImageListEl = document.getElementById('composerImageList');
const composerImageInfoEl = document.getElementById('composerImageInfo');
const composerStatusEl = document.getElementById('composerStatus');
const composerResultEl = document.getElementById('composerResult');
const composerSendButton = document.getElementById('composerSend');
const composerOpenFolderButton = document.getElementById('composerOpenFolder');
const composerPickImagesButton = document.getElementById('composerPickImages');
const composerClearImagesButton = document.getElementById('composerClearImages');
const composerCloseButton = document.getElementById('composerClose');

const composerImages = [];
let composerPollTimer = null;
let composerCurrentJobId = null;
let composerDefaultsLoaded = false;

function fillComposerOptions(defaults) {
  if (composerDefaultsLoaded) return;
  const durations = (defaults && defaults.durations) || [5, 10, 15, 30];
  const ratios = (defaults && defaults.ratios) || ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'];
  const models = (defaults && defaults.models) || ['Dreamina Seedance 2.5', 'Dreamina Seedance 2.0 Fast', 'Dreamina Seedance 1.0'];
  composerDurationEl.replaceChildren();
  for (const value of durations) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = `${value} giây`;
    composerDurationEl.appendChild(option);
  }
  composerDurationEl.value = String((defaults && defaults.defaultDuration) || 30);
  composerRatioEl.replaceChildren();
  for (const value of ratios) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    composerRatioEl.appendChild(option);
  }
  composerRatioEl.value = (defaults && defaults.defaultRatio) || '16:9';
  composerModelEl.replaceChildren();
  for (const value of models) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value.replace('Dreamina ', '');
    composerModelEl.appendChild(option);
  }
  composerModelEl.value = (defaults && defaults.defaultModel) || 'Dreamina Seedance 2.5';
  composerDefaultsLoaded = true;
}

function renderComposerImages() {
  composerImageListEl.replaceChildren();
  for (const image of composerImages) {
    const node = document.createElement('div');
    node.className = 'composer-thumb';
    const img = document.createElement('img');
    img.src = image.preview;
    img.alt = image.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Bỏ ảnh này';
    remove.addEventListener('click', () => {
      const index = composerImages.indexOf(image);
      if (index >= 0) composerImages.splice(index, 1);
      renderComposerImages();
    });
    const label = document.createElement('span');
    label.textContent = image.name;
    node.append(img, remove, label);
    composerImageListEl.appendChild(node);
  }
  composerImageInfoEl.textContent = composerImages.length
    ? `Đã gắn ${composerImages.length} ảnh.`
    : 'Chưa gắn ảnh nào.';
}

function addComposerFiles(files) {
  const accepted = Array.from(files).filter((file) => /image\/(png|jpeg|jpg|webp)/.test(file.type));
  const room = 6 - composerImages.length;
  if (!accepted.length) { composerStatusEl.textContent = 'Chỉ nhận ảnh png, jpg, webp.'; return; }
  if (room <= 0) { composerStatusEl.textContent = 'Đã đủ 6 ảnh, bỏ bớt trước khi thêm.'; return; }
  for (const file of accepted.slice(0, room)) {
    const entry = { name: file.name, preview: '', dataUrl: '' };
    composerImages.push(entry);
    const reader = new FileReader();
    reader.onload = () => {
      entry.preview = reader.result;
      entry.dataUrl = reader.result;
      renderComposerImages();
    };
    reader.readAsDataURL(file);
  }
  renderComposerImages();
}

function setComposerStatus(text) {
  composerStatusEl.textContent = text;
}

function renderComposerJob(job) {
  if (!job) return;
  const STATUS_TEXT = {
    queued: 'Đang chờ',
    running: 'Đang chạy',
    submitting: 'Đang gửi',
    accepted: 'Máy chủ đã nhận',
    generating: 'Đang vẽ',
    completed: 'Xong',
    failed: 'Lỗi',
    needs_login: 'Cần đăng nhập',
    canceled: 'Đã dừng'
  };
  setComposerStatus(`${STATUS_TEXT[job.status] || job.status}: ${job.message || ''}`);
  if (job.status === 'completed' && job.media && job.media.unwatermarked) {
    const seconds = job.media.durationSeconds || job.media.reportedDuration;
    composerResultEl.hidden = false;
    composerResultEl.innerHTML = '';
    const title = document.createElement('strong');
    title.textContent = `Video đã xong: ${seconds ? Number(seconds).toFixed(2) + ' giây' : '?'} · ${job.media.width || '?'}x${job.media.height || '?'}`;
    const file = document.createElement('div');
    file.className = 'dialog-hint';
    file.textContent = job.media.unwatermarked.file;
    composerResultEl.append(title, file);
    composerOpenFolderButton.disabled = false;
  } else {
    composerResultEl.hidden = true;
    composerOpenFolderButton.disabled = true;
  }
  const busy = ['queued', 'running', 'submitting', 'accepted', 'generating'].includes(job.status);
  composerSendButton.disabled = busy;
}

function startComposerPolling() {
  clearInterval(composerPollTimer);
  composerPollTimer = setInterval(() => {
    refreshComposerJob().catch(() => {});
  }, 5000);
}

async function openComposer() {
  const account = accountById(activeId);
  if (!account) return;
  const defaults = window.seedanceDesktop.videoDefaults ? await window.seedanceDesktop.videoDefaults() : null;
  fillComposerOptions(defaults);
  composerAccountEl.textContent = `Tài khoản đang chọn: ${account.name}`;
  composerBackdrop.hidden = false;
  composerStatusEl.textContent = 'Sẵn sàng.';
  composerPromptEl.focus();
  await refreshComposerJob().catch(() => {});
  startComposerPolling();
}

function closeComposer() {
  composerBackdrop.hidden = true;
  clearInterval(composerPollTimer);
  composerPollTimer = null;
}

async function sendComposerJob() {
  const account = accountById(activeId);
  if (!account) return;
  const prompt = composerPromptEl.value.trim();
  if (!prompt) { setComposerStatus('Chưa có đoạn mô tả.'); return; }
  composerSendButton.disabled = true;
  setComposerStatus('Đang gửi việc…');
  try {
    const job = await window.seedanceDesktop.createVideo({
      accountId: account.id,
      prompt,
      duration: Number(composerDurationEl.value),
      ratio: composerRatioEl.value,
      model: composerModelEl.value,
      images: composerImages.map((image) => ({ name: image.name, dataUrl: image.dataUrl }))
    });
    if (job) renderComposerJob(job);
    setComposerStatus(`Đã gửi việc ${job ? job.id : ''} — theo dõi ở đây, không cần chạm vào trang Dola.`);
  } catch (error) {
    setComposerStatus(`Không gửi được: ${String((error && error.message) || error)}`);
    composerSendButton.disabled = false;
  }
}

document.getElementById('openComposer').addEventListener('click', () => { openComposer().catch(console.error); });
composerCloseButton.addEventListener('click', closeComposer);
composerBackdrop.addEventListener('click', (event) => {
  if (event.target === composerBackdrop) closeComposer();
});
composerPickImagesButton.addEventListener('click', () => composerImagesEl.click());
composerImagesEl.addEventListener('change', (event) => {
  addComposerFiles(event.target.files);
  event.target.value = '';
});
composerClearImagesButton.addEventListener('click', () => {
  composerImages.length = 0;
  renderComposerImages();
});
composerSendButton.addEventListener('click', () => { sendComposerJob().catch(console.error); });
composerOpenFolderButton.addEventListener('click', () => {
  if (composerCurrentJobId && window.seedanceDesktop.openOutputs) {
    window.seedanceDesktop.openOutputs(composerCurrentJobId).catch(console.error);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !composerBackdrop.hidden) closeComposer();
});

// --- Lấy video từ hội thoại cũ trong popup -----------------------------------
const composerConversationEl = document.getElementById('composerConversation');
const composerGetStatusEl = document.getElementById('composerGetStatus');
const composerGetVideosButton = document.getElementById('composerGetVideos');
const composerLoadConvosButton = document.getElementById('composerLoadConvos');

async function loadComposerConversations() {
  const account = accountById(activeId);
  if (!account) { composerGetStatusEl.textContent = 'Chưa chọn tài khoản.'; return; }
  composerGetStatusEl.textContent = 'Đang nạp danh sách hội thoại…';
  try {
    const result = await window.seedanceDesktop.listConversations(account.id);
    composerConversationEl.replaceChildren();
    for (const item of (result.conversations || [])) {
      const option = document.createElement('option');
      option.value = item.href;
      option.textContent = item.text;
      composerConversationEl.appendChild(option);
    }
    composerGetStatusEl.textContent = `Có ${(result.conversations || []).length} hội thoại.`;
  } catch (error) {
    composerGetStatusEl.textContent = `Lỗi: ${String((error && error.message) || error)}`;
  }
}

async function getComposerConversationVideos() {
  const account = accountById(activeId);
  if (!account) { composerGetStatusEl.textContent = 'Chưa chọn tài khoản.'; return; }
  const selected = composerConversationEl.selectedOptions[0];
  if (!selected) { composerGetStatusEl.textContent = 'Bấm "Nạp danh sách" trước.'; return; }
  composerGetVideosButton.disabled = true;
  composerGetStatusEl.textContent = `Đang mở hội thoại và tải video…`;
  try {
    const result = await window.seedanceDesktop.getConversationVideos({
      accountId: account.id,
      href: selected.value,
      title: selected.textContent
    });
    if (result.downloaded && result.downloaded.length) {
      const lines = result.downloaded.map((item) => {
        if (item.error) return `  ✗ ${item.vid}: ${item.error}`;
        const file = item.unwatermarked ? item.unwatermarked.file.split('\\').pop() : '(không có)';
        const seconds = item.unwatermarked && item.unwatermarked.durationSeconds ? item.unwatermarked.durationSeconds.toFixed(2) + 's' : '';
        return `  ✓ ${seconds} ${file}`;
      });
      composerGetStatusEl.textContent = `Đã tải ${result.downloaded.length} video về thư mục outputs.\n${lines.join('\n')}`;
      composerGetStatusEl.style.whiteSpace = 'pre-wrap';
    } else {
      composerGetStatusEl.textContent = result.message || 'Không thấy video nào.';
    }
  } catch (error) {
    composerGetStatusEl.textContent = `Lỗi: ${String((error && error.message) || error)}`;
  } finally {
    composerGetVideosButton.disabled = false;
  }
}

composerLoadConvosButton.addEventListener('click', () => { loadComposerConversations().catch(console.error); });
composerGetVideosButton.addEventListener('click', () => { getComposerConversationVideos().catch(console.error); });

// --- Quản lý việc trong popup: hủy, tạo mới, danh sách việc gần đây --------
const composerCancelButton = document.getElementById('composerCancel');
const composerNewTaskButton = document.getElementById('composerNewTask');
const composerJobsEl = document.getElementById('composerJobs');
const composerTaskInfoEl = document.getElementById('composerTaskInfo');

const COMPOSER_STATUS_TEXT = {
  queued: 'Đang chờ',
  running: 'Đang chạy',
  submitting: 'Đang gửi',
  accepted: 'Đã nhận',
  generating: 'Đang vẽ',
  completed: 'Xong',
  failed: 'Lỗi',
  needs_login: 'Cần đăng nhập',
  canceled: 'Đã dừng'
};

const COMPOSER_ACTIVE = ['queued', 'running', 'submitting', 'accepted', 'generating'];

function renderComposerJobs(jobs) {
  composerJobsEl.replaceChildren();
  const list = (jobs || []).slice(0, 6);
  for (const job of list) {
    const row = document.createElement('div');
    row.className = 'composer-job';
    const chip = document.createElement('span');
    chip.className = `chip ${job.status}`;
    chip.textContent = COMPOSER_STATUS_TEXT[job.status] || job.status;
    const text = document.createElement('span');
    text.className = 'job-text';
    text.textContent = `${job.duration}s · ${job.ratio} · ${(job.message || '').slice(0, 60)}`;
    row.append(chip, text);
    if (COMPOSER_ACTIVE.includes(job.status)) {
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.textContent = 'Hủy';
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        await window.seedanceDesktop.cancelVideo(job.id).catch(() => {});
        await refreshComposerJob().catch(() => {});
      });
      row.appendChild(stop);
    } else if (job.media && job.media.unwatermarked) {
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Mở thư mục';
      open.addEventListener('click', () => {
        window.seedanceDesktop.openOutputs(job.id).catch(() => {});
      });
      row.appendChild(open);
    }
    composerJobsEl.appendChild(row);
  }
  const activeCount = list.filter((job) => COMPOSER_ACTIVE.includes(job.status)).length;
  composerTaskInfoEl.textContent = activeCount ? `${activeCount} việc đang chạy` : '';
  composerCancelButton.disabled = activeCount === 0;
}

async function refreshComposerJob() {
  const account = accountById(activeId);
  if (!account || !window.seedanceDesktop.listVideoJobs) return;
  const jobs = await window.seedanceDesktop.listVideoJobs(account.id);
  const newest = (jobs || [])[0];
  renderComposerJobs(jobs || []);
  if (newest) {
    composerCurrentJobId = newest.id;
    renderComposerJob(newest);
  } else {
    composerCurrentJobId = null;
  }
}

async function cancelComposerJobs() {
  const account = accountById(activeId);
  if (!account) return;
  composerCancelButton.disabled = true;
  const stopped = await window.seedanceDesktop.cancelAccountVideos(account.id).catch(() => 0);
  setComposerStatus(stopped ? `Đã dừng ${stopped} việc.` : 'Không có việc nào đang chạy.');
  await refreshComposerJob().catch(() => {});
}

async function startNewComposerTask() {
  const account = accountById(activeId);
  if (account) {
    const stopped = await window.seedanceDesktop.cancelAccountVideos(account.id).catch(() => 0);
    if (stopped) setComposerStatus(`Đã dừng ${stopped} việc cũ để bắt đầu việc mới.`);
  }
  composerImages.length = 0;
  renderComposerImages();
  composerPromptEl.value = '';
  composerResultEl.hidden = true;
  composerOpenFolderButton.disabled = true;
  composerSendButton.disabled = false;
  setComposerStatus('Việc mới: dán mô tả, chọn số giây và ảnh, rồi bấm Gửi.');
  composerPromptEl.focus();
  await refreshComposerJob().catch(() => {});
}

composerCancelButton.addEventListener('click', () => { cancelComposerJobs().catch(console.error); });
composerNewTaskButton.addEventListener('click', () => { startNewComposerTask().catch(console.error); });
