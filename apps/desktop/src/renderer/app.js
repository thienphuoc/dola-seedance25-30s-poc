'use strict';

const accountsEl = document.getElementById('accounts');
const webviewsEl = document.getElementById('webviews');
const emptyEl = document.getElementById('empty');
const addButton = document.getElementById('addAccount');
const reloadButton = document.getElementById('reload');
const clearButton = document.getElementById('clearSession');
const importCookiesButton = document.getElementById('importCookies');
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
