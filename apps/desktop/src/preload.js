'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seedanceDesktop', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addAccount: (name) => ipcRenderer.invoke('accounts:add', String(name || '')),
  removeAccount: (id, clearSession = false) => ipcRenderer.invoke('accounts:remove', String(id || ''), clearSession === true),
  clearAccountSession: (id) => ipcRenderer.invoke('accounts:clear-session', String(id || '')),
  importCookies: (id, cookies) => ipcRenderer.invoke('accounts:import-cookies', String(id || ''), cookies),
  enableDuration: (id) => ipcRenderer.invoke('accounts:enable-duration', String(id || '')),
  capacityReport: () => ipcRenderer.invoke('capacity:report'),
  recordCapacityJob: (payload) => ipcRenderer.invoke('capacity:record-job', payload),
  recordCapacityProviderState: (payload) => ipcRenderer.invoke('capacity:provider-state', payload),
  nextCapacityAccount: (afterAccountId) => ipcRenderer.invoke('capacity:next-account', String(afterAccountId || '')),
  // Cho bàn điều khiển web: chuyển sang tài khoản đang chạy và trả về mã khung Dola.
  onActivateAccount: (handler) => ipcRenderer.on('desktop:activate-account', (_event, accountId) => handler(String(accountId || ''))),
  onRefreshAccounts: (handler) => ipcRenderer.on('desktop:refresh-accounts', () => handler()),
  onResolveWebview: (handler) => ipcRenderer.on('desktop:resolve-webview', (_event, payload) => handler(payload || {})),
  reportWebview: (payload) => ipcRenderer.send('desktop:resolve-webview-result', payload || {}),
  // Popup "Tạo video" trong studio: gửi việc, xem tiến trình, mở thư mục kết quả.
  createVideo: (payload) => ipcRenderer.invoke('video:create', payload || {}),
  listVideoJobs: (accountId) => ipcRenderer.invoke('video:jobs', String(accountId || '')),
  cancelVideo: (jobId) => ipcRenderer.invoke('video:cancel', String(jobId || '')),
  cancelAccountVideos: (accountId) => ipcRenderer.invoke('video:cancel-account', String(accountId || '')),
  openOutputs: (jobId) => ipcRenderer.invoke('video:open-outputs', String(jobId || '')),
  videoDefaults: () => ipcRenderer.invoke('video:defaults'),
  listConversations: (id) => ipcRenderer.invoke('video:conversations', String(id || '')),
  getConversationVideos: (payload) => ipcRenderer.invoke('video:get-conversation', payload || {})
});
