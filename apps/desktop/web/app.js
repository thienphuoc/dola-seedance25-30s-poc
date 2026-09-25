'use strict';

const el = (id) => document.getElementById(id);
const state = { accounts: [], jobs: [], defaults: null, images: [], busy: false, poll: null };

function toast(text, isError) {
  const node = el('toast');
  node.textContent = text;
  node.className = isError ? 'toast err' : 'toast';
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 6000);
}

async function api(path, options) {
  const res = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, options));
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: text }; }
  if (!res.ok) throw new Error((body && body.error) || `Lỗi ${res.status}`);
  return body;
}

function fillSelect(node, values, selected) {
  node.replaceChildren();
  for (const value of values) {
    const option = document.createElement('option');
    if (typeof value === 'object') { option.value = value.value; option.textContent = value.label; }
    else { option.value = value; option.textContent = value; }
    node.appendChild(option);
  }
  if (selected !== undefined) node.value = selected;
}

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

function renderAccounts() {
  const select = el('accountSelect');
  const previous = select.value || localStorage.getItem('dolaAccountId') || '';
  select.replaceChildren();
  if (!state.accounts.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Chưa có tài khoản nào';
    select.appendChild(option);
  }
  for (const account of state.accounts) {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.name;
    select.appendChild(option);
  }
  if (previous && state.accounts.some((account) => account.id === previous)) select.value = previous;
  el('removeAccount').disabled = !select.value;
}

function renderJobs() {
  const container = el('jobs');
  container.replaceChildren();
  if (!state.jobs.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'Chưa có việc nào.';
    container.appendChild(empty);
    return;
  }
  for (const job of state.jobs) {
    const card = document.createElement('div');
    card.className = 'job';

    const head = document.createElement('div');
    head.className = 'job-head';
    const chip = document.createElement('span');
    chip.className = `chip ${job.status}`;
    chip.textContent = STATUS_TEXT[job.status] || job.status;
    const title = document.createElement('span');
    title.className = 'job-title';
    title.textContent = `${job.duration}s · ${job.ratio} · ${job.accountName}`;
    const meta = document.createElement('span');
    meta.className = 'job-meta';
    meta.textContent = `${new Date(job.createdAt).toLocaleString('vi-VN')}${job.imageCount ? ` · ${job.imageCount} ảnh` : ''} · ${job.promptChars} ký tự`;
    head.append(chip, title, meta);
    card.appendChild(head);

    const message = document.createElement('div');
    message.className = 'job-msg';
    message.textContent = job.message || '';
    card.appendChild(message);

    if (job.status === 'completed' && job.media && job.media.unwatermarked) {
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.src = `/api/media/${job.id}/unwatermarked`;
      card.appendChild(video);

      const actions = document.createElement('div');
      actions.className = 'job-actions';
      const main = document.createElement('a');
      main.className = 'primary';
      main.href = `/api/media/${job.id}/unwatermarked/download`;
      main.textContent = 'Tải bản sạch (không dấu chìm)';
      actions.appendChild(main);
      if (job.media.client) {
        const alt = document.createElement('a');
        alt.href = `/api/media/${job.id}/client/download`;
        alt.textContent = 'Tải bản của Dola';
        actions.appendChild(alt);
      }
      card.appendChild(actions);

      const info = document.createElement('div');
      info.className = 'job-meta';
      const d = job.media.durationSeconds || job.media.reportedDuration;
      info.textContent = [
        d ? `${Number(d).toFixed(2)} giây` : null,
        job.media.width && job.media.height ? `${job.media.width}x${job.media.height}` : null,
        job.media.unwatermarked && job.media.unwatermarked.bytes ? `${(job.media.unwatermarked.bytes / 1048576).toFixed(1)} MB` : null,
        job.media.videoCodec ? `${job.media.videoCodec}${job.media.audioCodec ? ' + ' + job.media.audioCodec : ''}` : null
      ].filter(Boolean).join(' · ');
      card.appendChild(info);
    }

    const ACTIVE = ['queued', 'running', 'submitting', 'accepted', 'generating'];
    if (ACTIVE.includes(job.status)) {
      const actions = document.createElement('div');
      actions.className = 'job-actions';
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.textContent = 'Hủy việc này';
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        await api('/api/jobs/' + job.id + '/cancel', { method: 'POST', body: '{}' }).catch(() => {});
        await refresh();
      });
      actions.appendChild(stop);
      card.appendChild(actions);
    }

    if (job.log && job.log.length) {
      const log = document.createElement('div');
      log.className = 'job-log';
      log.textContent = job.log.slice(-6).map((entry) => `${new Date(entry.at).toLocaleTimeString('vi-VN')}  ${entry.text}`).join('\n');
      card.appendChild(log);
    }

    container.appendChild(card);
  }
}

const JOB_ACTIVE = ['queued', 'running', 'submitting', 'accepted', 'generating'];

// Việc đang chạy chỉ chặn chính tài khoản của nó. Tài khoản khác vẫn gửi được vì mỗi
// tài khoản có khung Dola và phiên riêng.
function activeJob() {
  const accountId = el('accountSelect').value;
  return state.jobs.find((job) => job.accountId === accountId && JOB_ACTIVE.includes(job.status)) || null;
}

function renderSendState() {
  const running = activeJob();
  el('send').disabled = Boolean(running);
  el('sendHint').textContent = running
    ? `Tài khoản này đang có việc chạy (${running.id}). Đổi sang tài khoản khác để gửi tiếp.`
    : '';
}

async function refresh() {
  try {
    const data = await api('/api/state');
    state.accounts = data.accounts || [];
    state.jobs = data.jobs || [];
    state.defaults = data.defaults;
    el('connection').textContent = 'Đã kết nối bàn điều khiển';
    renderAccounts();
    renderJobs();
    renderSendState();
  } catch (error) {
    el('connection').textContent = 'Mất kết nối ứng dụng';
    toast(String(error.message || error), true);
  }
}

function setupOptions() {
  const defaults = state.defaults || {};
  if (!el('duration').options.length) {
    fillSelect(el('duration'), (defaults.durations || [5, 10, 15, 30]).map((value) => ({ value: String(value), label: `${value} giây` })), String(defaults.defaultDuration || 30));
    fillSelect(el('ratio'), defaults.ratios || ['16:9'], defaults.defaultRatio || '16:9');
    fillSelect(el('model'), defaults.models || ['Dreamina Seedance 2.5'], defaults.defaultModel || 'Dreamina Seedance 2.5');
  }
}

function renderImages() {
  const list = el('imageList');
  list.replaceChildren();
  for (const image of state.images) {
    const node = document.createElement('div');
    node.className = image.uploading ? 'thumb uploading' : 'thumb';
    const img = document.createElement('img');
    img.src = image.preview;
    img.alt = image.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Bỏ ảnh này';
    remove.addEventListener('click', () => {
      state.images = state.images.filter((item) => item !== image);
      renderImages();
    });
    const label = document.createElement('span');
    label.textContent = image.name;
    node.append(img, remove, label);
    list.appendChild(node);
  }
}

function addFiles(files) {
  const accepted = Array.from(files).filter((file) => /image\/(png|jpeg|jpg|webp)/.test(file.type));
  if (!accepted.length) return;
  const room = 6 - state.images.length;
  if (room <= 0) { toast('Đã đủ 6 ảnh, bỏ bớt trước khi thêm.', true); return; }
  for (const file of accepted.slice(0, room)) {
    const entry = { name: file.name, preview: '', uploading: true, file: null };
    state.images.push(entry);
    const reader = new FileReader();
    reader.onload = async () => {
      entry.preview = reader.result;
      renderImages();
      try {
        const saved = await api('/api/uploads', { method: 'POST', body: JSON.stringify({ name: file.name, dataUrl: reader.result }) });
        entry.file = saved.file;
        entry.uploading = false;
      } catch (error) {
        entry.uploading = false;
        entry.error = true;
        toast(`Ảnh ${file.name} lỗi: ${String(error.message || error)}`, true);
      }
      renderImages();
    };
    reader.readAsDataURL(file);
  }
  renderImages();
}

async function addAccount() {
  const raw = el('cookieInput').value.trim();
  if (!raw) { toast('Chưa dán cookie', true); return; }
  let cookies;
  try {
    const parsed = JSON.parse(raw);
    cookies = Array.isArray(parsed) ? parsed : parsed.cookies;
  } catch (_) {
    toast('Cookie không đúng định dạng mảng JSON', true);
    return;
  }
  if (!Array.isArray(cookies) || !cookies.length) { toast('Không đọc được cookie nào', true); return; }
  el('addAccount').disabled = true;
  try {
    const result = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ name: el('accountName').value.trim(), cookies }) });
    el('cookieInput').value = '';
    el('accountName').value = '';
    await refresh();
    el('accountSelect').value = result.account.id;
    localStorage.setItem('dolaAccountId', result.account.id);
    const check = result.check || {};
    if (check.loggedIn) toast(`Đã nhận tài khoản: ${check.nickname || result.account.name}`);
    else toast('Đã lưu tài khoản nhưng chưa thấy đăng nhập. Mở cửa sổ Dola để đăng nhập.', true);
  } catch (error) {
    toast(String(error.message || error), true);
  } finally {
    el('addAccount').disabled = false;
  }
}

async function checkAccount() {
  const id = el('accountSelect').value;
  if (!id) { toast('Chưa chọn tài khoản', true); return; }
  el('accountStatus').textContent = 'Đang kiểm tra…';
  try {
    const check = await api(`/api/accounts/${id}/check`, { method: 'POST', body: '{}' });
    if (check.loggedIn) {
      el('accountStatus').textContent = `Đang đăng nhập: ${check.nickname || check.account.name}${check.membership ? ' · gói ' + check.membership : ''}`;
      toast('Tài khoản dùng được');
    } else {
      el('accountStatus').textContent = 'Chưa đăng nhập. Mở cửa sổ Dola của tài khoản này để đăng nhập lại.';
      toast('Tài khoản chưa đăng nhập', true);
    }
  } catch (error) {
    el('accountStatus').textContent = 'Kiểm tra lỗi: ' + String(error.message || error);
    toast(String(error.message || error), true);
  }
}

async function removeAccount() {
  const id = el('accountSelect').value;
  if (!id) return;
  const account = state.accounts.find((item) => item.id === id);
  if (!window.confirm(`Xoá tài khoản "${account ? account.name : id}" khỏi bàn điều khiển?`)) return;
  try {
    await api(`/api/accounts/${id}`, { method: 'DELETE' });
    localStorage.removeItem('dolaAccountId');
    await refresh();
    el('accountStatus').textContent = 'Đã xoá tài khoản.';
  } catch (error) {
    toast(String(error.message || error), true);
  }
}

async function enableDuration() {
  const id = el('accountSelect').value;
  if (!id) { toast('Chưa chọn tài khoản', true); return; }
  el('enableDuration').disabled = true;
  el('accountStatus').textContent = 'Đang thêm lựa chọn số giây vào trang Dola…';
  try {
    const result = await api(`/api/accounts/${id}/inject-duration`, { method: 'POST', body: '{}' });
    if (result.ok) {
      el('accountStatus').textContent = `Đã bật cho ${result.nickname || 'tài khoản này'}. Ô chọn số giây hiện có: ${(result.options || []).join(', ') || 'không đọc được'}`;
      toast('Đã thêm lựa chọn số giây vào trang Dola');
    } else {
      el('accountStatus').textContent = `Không bật được: ${result.error || 'lỗi không rõ'}`;
      toast(result.error || 'Không bật được', true);
    }
  } catch (error) {
    toast(String(error.message || error), true);
  } finally {
    el('enableDuration').disabled = false;
  }
}

async function send() {
  const accountId = el('accountSelect').value;
  const prompt = el('prompt').value.trim();
  if (!accountId) { toast('Chưa chọn tài khoản', true); return; }
  if (!prompt) { toast('Chưa có đoạn mô tả', true); return; }
  const uploading = state.images.some((image) => image.uploading);
  if (uploading) { toast('Ảnh đang tải lên, chờ một chút', true); return; }
  const images = state.images.map((image) => image.file).filter(Boolean);
  el('send').disabled = true;
  try {
    await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        accountId,
        prompt,
        images,
        duration: Number(el('duration').value),
        ratio: el('ratio').value,
        model: el('model').value
      })
    });
    toast('Đã gửi việc. Theo dõi tiến trình bên dưới.');
    await refresh();
  } catch (error) {
    toast(String(error.message || error), true);
    el('send').disabled = false;
  }
}

function wire() {
  el('prompt').addEventListener('input', () => {
    el('promptCount').textContent = `${el('prompt').value.length} ký tự`;
  });
  el('accountSelect').addEventListener('change', () => {
    localStorage.setItem('dolaAccountId', el('accountSelect').value);
    el('removeAccount').disabled = !el('accountSelect').value;
    el('accountStatus').textContent = 'Chưa kiểm tra tài khoản này.';
    renderSendState();
  });
  el('addAccount').addEventListener('click', () => { addAccount(); });
  el('checkAccount').addEventListener('click', () => { checkAccount(); });
  el('removeAccount').addEventListener('click', () => { removeAccount(); });
  el('enableDuration').addEventListener('click', () => { enableDuration(); });
  el('send').addEventListener('click', () => { send(); });

  const drop = el('dropZone');
  el('pickImages').addEventListener('click', () => el('imageInput').click());
  el('imageInput').addEventListener('change', (event) => {
    addFiles(event.target.files);
    event.target.value = '';
  });
  ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (event) => {
    if (event.dataTransfer && event.dataTransfer.files) addFiles(event.dataTransfer.files);
  });
}

async function boot() {
  wire();
  await refresh();
  setupOptions();
  clearInterval(state.poll);
  state.poll = setInterval(async () => {
    await refresh();
  }, 5000);
}

boot();
