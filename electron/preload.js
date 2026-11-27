const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('fc', {
  rpc: (method, params) => ipcRenderer.invoke('rpc', method, params),
  state: () => ipcRenderer.invoke('app:state'),
  setup: (opts) => ipcRenderer.invoke('app:setup', opts),
  resetMode: () => ipcRenderer.invoke('app:resetMode'),
  updateLocal: (patch) => ipcRenderer.invoke('app:updateLocal', patch),
  newAccessKey: () => ipcRenderer.invoke('host:newKey'),
  discover: () => ipcRenderer.invoke('net:discover'),
  testHost: (opts) => ipcRenderer.invoke('net:test', opts),
  backup: {
    create: () => ipcRenderer.invoke('backup:create'),
    list: () => ipcRenderer.invoke('backup:list'),
    openFolder: () => ipcRenderer.invoke('backup:openFolder'),
    restore: () => ipcRenderer.invoke('backup:restore'),
    cloudSet: (patch) => ipcRenderer.invoke('backup:cloudSet', patch),
    cloudPick: () => ipcRenderer.invoke('backup:cloudPick'),
    cloudOpen: () => ipcRenderer.invoke('backup:cloudOpen'),
    gdriveStatus: () => ipcRenderer.invoke('gdrive:status'),
    gdriveSet: (patch) => ipcRenderer.invoke('gdrive:set', patch),
    gdriveConnect: () => ipcRenderer.invoke('gdrive:connect'),
    gdriveDisconnect: () => ipcRenderer.invoke('gdrive:disconnect'),
    gdriveUploadNow: () => ipcRenderer.invoke('gdrive:uploadNow'),
    gdriveList: () => ipcRenderer.invoke('gdrive:list'),
    gdriveRestore: (file) => ipcRenderer.invoke('gdrive:restore', file),
    onGdrive: (cb) => {
      const h = (_e, st) => cb(st);
      ipcRenderer.on('gdrive:changed', h);
      return () => ipcRenderer.removeListener('gdrive:changed', h);
    },
  },
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts),
  saveXlsx: (report) => ipcRenderer.invoke('xlsx:save', report),
  saveBinary: (opts) => ipcRenderer.invoke('file:saveBinary', opts),
  exportPdf: (opts) => ipcRenderer.invoke('pdf:export', opts),
  print: (opts) => ipcRenderer.invoke('print', opts),
  printSilent: (opts) => ipcRenderer.invoke('print:silent', opts),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  onDataChanged: on('data-changed'),
  onConnection: on('connection-status'),
  onCloseRequested: on('close-requested'),
  onLogoutRequested: on('logout-requested'),
  confirmClose: () => ipcRenderer.invoke('app:confirmClose'),
  importRead: () => ipcRenderer.invoke('import:read'),
  saveTransfer: (job) => ipcRenderer.invoke('transfer:save', job),
  notify: {
    get: () => ipcRenderer.invoke('notify:get'),
    set: (patch) => ipcRenderer.invoke('notify:set', patch),
    testEmail: (to) => ipcRenderer.invoke('notify:testEmail', to),
    testTelegram: () => ipcRenderer.invoke('notify:testTelegram'),
    findChats: () => ipcRenderer.invoke('notify:findChats'),
    run: (kind) => ipcRenderer.invoke('notify:run', kind),
  },
  openTemp: (file) => ipcRenderer.invoke('file:openTemp', file),
  printFile: (file) => ipcRenderer.invoke('file:print', file),
  printDialog: (file) => ipcRenderer.invoke('file:printDialog', file),
  openMessenger: (job) => ipcRenderer.invoke('messenger:open', job),
  setAuthToken: (token, remember) => ipcRenderer.invoke('auth:setToken', token, remember),
  hdmPrint: (receipt) => ipcRenderer.invoke('hdm:print', receipt),
  printers: () => ipcRenderer.invoke('printers:list'),
  thermalPrint: (job) => ipcRenderer.invoke('thermal:print', job),
  printerAddress: (name) => ipcRenderer.invoke('printers:address', name),
  hdmTest: (settings) => ipcRenderer.invoke('hdm:test', settings),
  hdmAction: (req) => ipcRenderer.invoke('hdm:action', req),
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (cb) => {
      const h = (_e, s) => cb(s);
      ipcRenderer.on('update-status', h);
      return () => ipcRenderer.removeListener('update-status', h);
    },
  },
});
