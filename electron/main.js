const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Tray, Menu, nativeImage, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { openDatabase } = require('./db');
const { createService, DEFAULT_TEMPLATES } = require('./service');
const notify = require('./notify');
const network = require('./network');
const PizZip = require('pizzip');
const { buildReport, buildForm, buildSchedule, buildStudentsTransfer, buildGroups, buildTable } = require('./xlsx');
const hdm = require('./hdm');
const updater = require('./updater');
const importer = require('./importer');
const escpos = require('./escpos');
// This app window, for edit locks (one person on two computers is two editors).
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');
const { createGDrive } = require('./gdrive');

// Lets a second copy run on the same PC with its own data (useful for testing host + client together).
if (process.env.FC_USER_DATA) app.setPath('userData', process.env.FC_USER_DATA);

const DEFAULT_PORT = 47800;
const BACKUPS_KEPT = 30;

let win = null;
let tray = null;
let quitting = false;
let authToken = null; // this PC's sign-in session (kept in config only with "remember me") // true once the app is really quitting (not just hiding to the tray)
let config = null;
let db = null;
let service = null;
let host = null;
let remote = null;
let dataVersion = 0;
let backupTimer = null;
let notifier = null;
const notifyCfg = () => notify.merge(notify.DEFAULTS, config.notify);

// ------------------------------------------------------------------ per-PC config
const userDir = () => app.getPath('userData');
const configFile = () => path.join(userDir(), 'config.json');
const dataDir = () => path.join(userDir(), 'data');
const dbFile = () => path.join(dataDir(), 'fcmanager.db');
const backupDir = () => path.join(userDir(), 'backups');

function loadConfig() {
  const defaults = {
    mode: null, // 'host' | 'client'
    port: DEFAULT_PORT,
    accessKey: '',
    hostAddress: '',
    hostPort: DEFAULT_PORT,
    language: 'en',
    theme: 'system',
    operator: '',
    hdm: hdm.DEFAULTS,
    thermal: { enabled: false, printer: '', width: 80, auto: false }, // customer receipt printer (80 mm)
    autoStart: true, // start hidden in the tray when Windows starts
    trayHintShown: false,
    cloud: { enabled: false, folder: '', lastAt: null, lastFile: null, lastError: null },
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) };
  } catch {
    return defaults;
  }
}

function saveConfig() {
  fs.mkdirSync(userDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

const newAccessKey = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
};

// ------------------------------------------------------------------ backend lifecycle
// A message to the page — only while the window still exists (timers can fire after it is gone, e.g. when quitting).
function toPage(channel, ...args) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args);
}

let changeTimer = null;
function notifyChanged() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => toPage('data-changed'), 80);
}

function sendStatus() {
  toPage('connection-status', remote ? remote.isOnline() : true);
}

function stopBackend() {
  clearInterval(backupTimer);
  notifier?.stop();
  notifier = null;
  host?.close();
  host = null;
  remote?.stop();
  remote = null;
  try {
    db?.close();
  } catch {}
  db = null;
  service = null;
}

async function startBackend() {
  stopBackend();
  if (config.mode === 'host') {
    fs.mkdirSync(dataDir(), { recursive: true });
    db = openDatabase(dbFile());
    service = createService(db, {
      onWrite: () => {
        dataVersion++;
        notifyChanged();
        notifier?.sendNow(); // receipts / alerts go out right away
      },
      getNotify: notifyCfg,
    });
    notifier = notify.startWorker({
      getConfig: notifyCfg,
      getService: () => service,
      saveState: (patch) => {
        config.notify = notify.merge(notifyCfg(), { state: patch });
        saveConfig();
      },
    });
    service.ensureMonthlyCharges();
    autoBackup();
    backupTimer = setInterval(autoBackup, 60 * 60 * 1000);
    try {
      host = await network.startHost({
        service,
        port: config.port,
        getKey: () => config.accessKey,
        getVersion: () => dataVersion,
        getInfo: () => ({ club: service.settings().club_name, host: require('os').hostname() }),
      });
    } catch (err) {
      console.error('[host] could not start LAN server:', err.message);
      host = null;
    }
  } else if (config.mode === 'client') {
    remote = network.createRemote({
      owner: INSTANCE_ID,
      host: config.hostAddress,
      port: config.hostPort,
      key: config.accessKey,
      getUser: () => config.operator,
      getToken: () => authToken,
      onChange: notifyChanged,
      onStatus: sendStatus,
    });
  }
}

// ------------------------------------------------------------------ backups (host only)
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

function createBackup(label = 'manual', { drive = true } = {}) {
  if (!db) throw new Error('Backups are made on the host PC');
  fs.mkdirSync(backupDir(), { recursive: true });
  const file = path.join(backupDir(), `fcmanager-${stamp()}-${label}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  cloudCopy(file);
  if (drive) gdrive.upload(file);
  return file;
}

// ------------------------------------------------------------------ OneDrive copy of backups
// Backups are copied into the OneDrive folder on this PC; the OneDrive app uploads them to the cloud.
const oneDriveRoot = () => process.env.OneDriveCommercial || process.env.OneDriveConsumer || process.env.OneDrive || '';
const defaultCloudFolder = () => (oneDriveRoot() ? path.join(oneDriveRoot(), 'FC Manager Backups') : '');
const cloudFolder = () => config.cloud?.folder || defaultCloudFolder();

function cloudCopy(file) {
  const c = config.cloud || {};
  if (!c.enabled) return;
  try {
    const folder = cloudFolder();
    if (!folder) throw Object.assign(new Error('NO_ONEDRIVE'), { code: 'NO_ONEDRIVE' });
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(file, path.join(folder, path.basename(file)));
    // Keep only the newest copies there too (file names start with the date, so name order is time order).
    fs.readdirSync(folder)
      .filter((f) => /^fcmanager-.*\.db$/.test(f))
      .sort()
      .reverse()
      .slice(BACKUPS_KEPT)
      .forEach((f) => fs.rmSync(path.join(folder, f), { force: true }));
    config.cloud = { ...c, lastAt: new Date().toISOString(), lastFile: path.basename(file), lastError: null };
  } catch (err) {
    console.error('[backup] OneDrive copy failed:', err.message);
    config.cloud = { ...c, lastError: err.code === 'NO_ONEDRIVE' ? 'NO_ONEDRIVE' : err.message };
  }
  saveConfig();
}

// ------------------------------------------------------------------ Google Drive copy of backups
const gdrive = createGDrive({
  getCfg: () => config.gdrive,
  setCfg: (patch) => {
    config.gdrive = { ...(config.gdrive || {}), ...patch };
    saveConfig();
    notifyGdrive();
  },
  // The sign-in token, encrypted with Windows' own protection for this user.
  encrypt: (str) => (safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(str).toString('base64') : 'raw:' + str),
  decrypt: (str) => (str.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(str.slice(4), 'base64')) : str.replace(/^raw:/, '')),
  // Testing (FC_GDRIVE_MOCK): the fake Google answers the sign-in page itself.
  openUrl: (url) => (process.env.FC_GDRIVE_MOCK ? fetch(url).catch(() => {}) : shell.openExternal(url)),
  keep: BACKUPS_KEPT,
  lang: () => config.language,
});
const notifyGdrive = () => {
  toPage('gdrive:changed', gdrive.status());
};

function listBackups() {
  try {
    return fs
      .readdirSync(backupDir())
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const st = fs.statSync(path.join(backupDir(), f));
        return { name: f, path: path.join(backupDir(), f), size: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

function autoBackup() {
  if (!db) return;
  const today = new Date().toISOString().slice(0, 10);
  const backups = listBackups();
  if (backups.some((b) => b.name.includes('-auto') && b.at.slice(0, 10) === today)) return;
  try {
    createBackup('auto');
    listBackups()
      .filter((b) => b.name.includes('-auto'))
      .slice(BACKUPS_KEPT)
      .forEach((b) => fs.rmSync(b.path, { force: true }));
  } catch (err) {
    console.error('[backup] failed:', err.message);
  }
}

// ------------------------------------------------------------------ window
function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121417' : '#f5f6f8',
    title: 'FC Manager',
    icon: path.join(__dirname, 'icons', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Keeps timers on time while minimized (edit locks say "still here" every 20 s).
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // Started by Windows at sign-in: stay in the tray.
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });

  // × signs the user out and hides the window to the tray; the app keeps running (other PCs stay
  // connected). Opening it again asks for the sign-in.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    toPage('logout-requested');
    // In case the page could not do it itself: forget that sign-in here too (not a newer one).
    const was = authToken;
    setTimeout(() => {
      if (!was || authToken !== was) return;
      authToken = null;
      delete config.authToken;
      saveConfig();
      toPage('logout-requested');
    }, 3000);
    if (!config.trayHintSignOut && tray) {
      tray.displayBalloon({
        title: 'FC Manager',
        content: config.language === 'hy'
          ? 'Դուք դուրս եկաք համակարգից։ Ծրագիրը շարունակում է աշխատել․ բացելու կամ փակելու համար օգտագործեք ժամացույցի մոտի նշանը։'
          : 'You are signed out. FC Manager keeps running — use the icon near the clock to open or quit it.',
        iconType: 'info',
      });
      config.trayHintSignOut = true;
      saveConfig();
    }
  });
  // Windows shutting down or signing out: quit without asking.
  win.on('session-end', () => {
    quitting = true;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function appState() {
  return {
    config,
    version: app.getVersion(),
    online: remote ? remote.isOnline() : true,
    host:
      config.mode === 'host'
        ? {
            running: !!host,
            port: config.port,
            accessKey: config.accessKey,
            addresses: network.localAddresses().map((a) => a.address),
            dbPath: dbFile(),
            backupDir: backupDir(),
            cloud: { ...config.cloud, folder: cloudFolder(), oneDrive: !!oneDriveRoot() },
            gdrive: gdrive.status(),
          }
        : null,
  };
}

// Reads a transfer zip back: transfer.json with each document's bytes put back in as base64.
function readTransfer(file) {
  const zip = new PizZip(fs.readFileSync(file));
  const json = zip.file('transfer.json');
  if (!json) throw new Error('not an FC Manager transfer file');
  const data = JSON.parse(json.asText());
  for (const st of data.students || [])
    for (const f of st.files || []) {
      if (!f.path) continue;
      const entry = zip.file(f.path);
      f.data = entry ? entry.asNodeBuffer().toString('base64') : null;
      delete f.path;
    }
  return data;
}

async function renderHtmlWindow(html) {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return w;
}

// The thermal receipt as a pure black-and-white picture (no grey: thermal heads print grey as faint dots).
// Drawn as wide as `px` (default 2× ≈ the 203 dpi of the printer head). Returns the PNG and the 1-bit pixels.
async function receiptImage(html, widthMm, px) {
  const cssWidth = Math.ceil(((widthMm - 8) * 96) / 25.4);
  const width = px || cssWidth * 2;
  const zoom = width / cssWidth;
  const w = new BrowserWindow({ show: false, useContentSize: true, width, height: 400, webPreferences: { sandbox: true, zoomFactor: zoom, offscreen: true } });
  try {
    // Offscreen: painted although never shown, and not limited to the screen height.
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await w.webContents.insertCSS('html { overflow: hidden !important; } ::-webkit-scrollbar { display: none; }');
    w.webContents.setZoomFactor(zoom);
    const h = await w.webContents.executeJavaScript(
      `document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => Math.ceil(document.documentElement.scrollHeight))`
    );
    const height = Math.ceil(h * zoom);
    w.setContentSize(width, height);
    await w.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))))');
    let img = await w.webContents.capturePage({ x: 0, y: 0, width, height });
    if (!img.getSize().width) throw new Error('THERMAL_RENDER');
    if (img.getSize().width !== width) img = img.resize({ width, quality: 'best' }); // display scaling
    const size = img.getSize();
    const bmp = img.toBitmap(); // BGRA
    const bits = new Uint8Array(size.width * size.height);
    for (let i = 0, k = 0; i < bmp.length; i += 4, k++) {
      const black = 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2] < 170;
      bits[k] = black ? 1 : 0;
      bmp[i] = bmp[i + 1] = bmp[i + 2] = black ? 0 : 255;
      bmp[i + 3] = 255;
    }
    return { png: nativeImage.createFromBitmap(bmp, size).toPNG(), width: size.width, height: size.height, bits };
  } finally {
    w.destroy();
  }
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  ipcMain.handle('auth:setToken', (_e, token, remember) => {
    authToken = token || null;
    if (remember && token) config.authToken = token;
    else delete config.authToken;
    saveConfig();
    return true;
  });

  // ---------------------------------------------------------------- email / Telegram (host PC)
  const notifyState = () => ({ isHost: config.mode === 'host', config: notifyCfg(), defaults: DEFAULT_TEMPLATES });
  ipcMain.handle('notify:get', () => notifyState());
  ipcMain.handle('notify:set', (_e, patch) => {
    if (config.mode !== 'host') return notifyState();
    const before = notifyCfg();
    const next = notify.merge(before, patch);
    // Switching on monthly summaries / automatic reminders starts with next month, not right away.
    const month = new Date().toISOString().slice(0, 7);
    if (next.monthly.enabled && !before.monthly.enabled) next.state = { ...next.state, monthly: month };
    if (next.reminders.auto && !before.reminders.auto) next.state = { ...next.state, reminders: month };
    if (patch?.telegram?.chats) next.telegram.chats = patch.telegram.chats; // lists are replaced, not merged
    config.notify = next;
    saveConfig();
    return notifyState();
  });
  const attempt = async (fn) => {
    try {
      return { ok: true, result: await fn() };
    } catch (err) {
      return { ok: false, error: 'SEND_FAILED', detail: err.message };
    }
  };
  ipcMain.handle('notify:testEmail', (_e, to) =>
    attempt(() =>
      notify.sendEmail(notifyCfg(), {
        to,
        subject: 'FC Manager — test',
        text: 'This is a test message from FC Manager. Email sending works.\n\nՍա FC Manager-ի փորձնական նամակն է։ Էլ. փոստով ուղարկումն աշխատում է։',
      })
    )
  );
  ipcMain.handle('notify:testTelegram', () =>
    attempt(async () => {
      const cfg = notifyCfg();
      const chats = (cfg.telegram.chats || []).filter((c) => c.on !== false);
      if (!chats.length) throw new Error('No chats selected');
      for (const c of chats) await notify.sendTelegram(cfg, { chatId: c.id, text: '✅ FC Manager: Telegram ծանուցումներն աշխատում են։' });
      return chats.length;
    })
  );
  ipcMain.handle('notify:findChats', () => attempt(() => notify.findChats(notifyCfg())));
  ipcMain.handle('notify:run', (_e, kind) =>
    attempt(() => {
      if (!service) throw new Error('Only on the main computer');
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const n =
        kind === 'monthly'
          ? service.outbox.summary('monthly', `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}`)
          : service.outbox.summary('daily', today);
      notifier?.sendNow();
      dataVersion++;
      notifyChanged();
      return n;
    })
  );

  ipcMain.handle('update:status', () => updater.getStatus());
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:install', () => {
    quitting = true;
    updater.install();
  });

  // The user confirmed "Quit" in the app's own window.
  ipcMain.handle('app:confirmClose', () => {
    quitting = true;
    app.quit();
  });
  ipcMain.handle('rpc', async (_e, method, params) => {
    if (config.mode === 'host' && service) return service.call(method, params, { user: config.operator || 'host', pc: config.operator || 'host', owner: INSTANCE_ID, token: authToken });
    if (config.mode === 'client' && remote) return remote.call(method, params);
    return { ok: false, error: 'NOT_CONFIGURED' };
  });

  ipcMain.handle('app:state', () => appState());

  ipcMain.handle('app:setup', async (_e, opts) => {
    if (opts.mode === 'host') {
      config.mode = 'host';
      config.port = Number(opts.port) || DEFAULT_PORT;
      if (!config.accessKey || config.hostAddress) config.accessKey = newAccessKey();
      config.hostAddress = '';
    } else if (opts.mode === 'client') {
      const test = await network.testHost({ host: opts.hostAddress, port: opts.hostPort, key: opts.accessKey });
      if (!test.ok) return test;
      config.mode = 'client';
      config.hostAddress = opts.hostAddress;
      config.hostPort = Number(opts.hostPort) || DEFAULT_PORT;
      config.accessKey = String(opts.accessKey || '').trim().toUpperCase();
    }
    if (opts.operator !== undefined) config.operator = opts.operator;
    if (opts.language) config.language = opts.language;
    saveConfig();
    await startBackend();
    return { ok: true, result: appState() };
  });

  ipcMain.handle('app:resetMode', async () => {
    stopBackend();
    config.mode = null;
    authToken = null;
    delete config.authToken;
    saveConfig();
    return appState();
  });

  ipcMain.handle('app:updateLocal', (_e, patch) => {
    for (const k of ['language', 'theme', 'operator', 'autoStart']) if (patch[k] !== undefined) config[k] = patch[k];
    if (patch.autoStart !== undefined) applyAutoStart();
    if (patch.language !== undefined && tray) {
      tray.destroy();
      createTray();
    }
    if (patch.hdm) config.hdm = { ...hdm.DEFAULTS, ...config.hdm, ...patch.hdm };
    if (patch.thermal) config.thermal = { ...(config.thermal || {}), ...patch.thermal };
    saveConfig();
    return appState();
  });

  ipcMain.handle('host:newKey', () => {
    config.accessKey = newAccessKey();
    saveConfig();
    return appState();
  });

  ipcMain.handle('hdm:print', (_e, receipt) =>
    hdm.printReceipt({ ...hdm.DEFAULTS, ...config.hdm }, receipt, () => {
      config.hdm = { ...hdm.DEFAULTS, ...config.hdm, testCounter: (config.hdm?.testCounter || 0) + 1 };
      saveConfig();
      return config.hdm.testCounter;
    })
  );
  ipcMain.handle('hdm:test', (_e, settings) => hdm.testConnection({ ...hdm.DEFAULTS, ...config.hdm, ...(settings || {}) }));
  ipcMain.handle('hdm:action', (_e, req) => hdm.action({ ...hdm.DEFAULTS, ...config.hdm }, req || {}));

  ipcMain.handle('net:discover', () => network.discoverHosts());
  ipcMain.handle('net:test', (_e, o) => network.testHost({ host: o.hostAddress, port: o.hostPort, key: o.accessKey }));

  ipcMain.handle('backup:create', () => {
    try {
      return { ok: true, result: createBackup('manual') };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('backup:list', () => listBackups());
  ipcMain.handle('backup:cloudSet', (_e, patch) => {
    const was = !!config.cloud?.enabled;
    config.cloud = { ...config.cloud, ...patch };
    saveConfig();
    // Turning it on: send the newest backup right away (or make one).
    if (!was && config.cloud.enabled && db) {
      const latest = listBackups()[0];
      if (latest) cloudCopy(latest.path);
      else createBackup('manual');
    }
    return appState();
  });
  ipcMain.handle('backup:cloudPick', async () => {
    const r = await dialog.showOpenDialog(win, { defaultPath: cloudFolder() || undefined, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0] || null;
  });
  ipcMain.handle('backup:cloudOpen', () => {
    const folder = cloudFolder();
    if (!folder) return;
    fs.mkdirSync(folder, { recursive: true });
    shell.openPath(folder);
  });
  ipcMain.handle('backup:openFolder', () => {
    fs.mkdirSync(backupDir(), { recursive: true });
    shell.openPath(backupDir());
  });
  ipcMain.handle('backup:restore', async () => {
    if (config.mode !== 'host') return { ok: false, error: 'HOST_ONLY' };
    const pick = await dialog.showOpenDialog(win, {
      defaultPath: backupDir(),
      filters: [{ name: 'FC Manager backup', extensions: ['db'] }],
      properties: ['openFile'],
    });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false, error: 'CANCELLED' };
    return restoreFrom(pick.filePaths[0]);
  });
  async function restoreFrom(source) {
    createBackup('before-restore');
    stopBackend();
    for (const suffix of ['-wal', '-shm']) fs.rmSync(dbFile() + suffix, { force: true });
    fs.copyFileSync(source, dbFile());
    await startBackend();
    dataVersion++;
    notifyChanged();
    return { ok: true };
  }

  // Google Drive (main computer only).
  const gdriveCall = async (fn) => {
    if (config.mode !== 'host') return { ok: false, error: 'HOST_ONLY' };
    try {
      return { ok: true, result: await fn() };
    } catch (err) {
      return { ok: false, error: err.code || 'GDRIVE_API', detail: err.message };
    }
  };
  ipcMain.handle('gdrive:status', () => gdrive.status());
  ipcMain.handle('gdrive:set', (_e, patch) =>
    gdriveCall(async () => {
      const keys = ['clientId', 'clientSecret', 'enabled'];
      const next = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => keys.includes(k)));
      if ('clientId' in next) next.clientId = String(next.clientId || '').trim();
      if ('clientSecret' in next) next.clientSecret = String(next.clientSecret || '').trim();
      const was = !!config.gdrive?.enabled;
      config.gdrive = { ...(config.gdrive || {}), ...next };
      saveConfig();
      // Turning it on: send the newest backup right away (or make one).
      if (!was && config.gdrive.enabled && db) {
        const latest = listBackups()[0];
        if (latest) gdrive.upload(latest.path);
        else createBackup('manual');
      }
      notifyGdrive();
      return gdrive.status();
    })
  );
  ipcMain.handle('gdrive:connect', () => gdriveCall(() => gdrive.connect()));
  ipcMain.handle('gdrive:disconnect', () => gdriveCall(() => gdrive.disconnect().then(() => gdrive.status())));
  // A fresh backup, sent now (also when automatic sending is off).
  ipcMain.handle('gdrive:uploadNow', () =>
    gdriveCall(async () => {
      const file = createBackup('manual', { drive: false });
      await gdrive.upload(file, { force: true });
      if (config.gdrive?.lastError) throw Object.assign(new Error(config.gdrive.lastError), { code: /^GDRIVE_/.test(config.gdrive.lastError) ? config.gdrive.lastError : 'GDRIVE_API' });
      return gdrive.status();
    })
  );
  ipcMain.handle('gdrive:list', () => gdriveCall(() => gdrive.list()));
  // Puts a backup from Drive back: downloaded next to the local backups, then restored like one of them.
  ipcMain.handle('gdrive:restore', (_e, { id, name }) =>
    gdriveCall(async () => {
      if (!/^fcmanager-[\w.-]+\.db$/.test(String(name))) throw Object.assign(new Error('bad name'), { code: 'GDRIVE_API' });
      fs.mkdirSync(backupDir(), { recursive: true });
      const file = await gdrive.download(id, path.join(backupDir(), `drive-${name}`));
      const r = await restoreFrom(file);
      if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error });
      return true;
    })
  );

  ipcMain.handle('file:save', async (_e, { defaultName, content, filters }) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
    if (r.canceled || !r.filePath) return { ok: false, error: 'CANCELLED' };
    fs.writeFileSync(r.filePath, content, 'utf8');
    return { ok: true, result: r.filePath };
  });

  // Saves a file the renderer already has as base64 (e.g. a filled Word contract) and opens it.
  ipcMain.handle('file:saveBinary', async (_e, { defaultName, data, filters }) => {
    const r = process.env.FC_EXPORT_DIR
      ? { filePath: path.join(process.env.FC_EXPORT_DIR, defaultName) }
      : await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
    if (r.canceled || !r.filePath) return { ok: false, error: 'CANCELLED' };
    try {
      fs.writeFileSync(r.filePath, Buffer.from(data, 'base64'));
    } catch (err) {
      return { ok: false, error: 'FILE_LOCKED', detail: err.message };
    }
    if (!process.env.FC_EXPORT_DIR) shell.openPath(r.filePath);
    return { ok: true, result: r.filePath };
  });

  // Opens a stored document (e.g. a student's medical certificate) with its usual program.
  ipcMain.handle('file:openTemp', async (_e, { name, data }) => {
    try {
      const dir = path.join(app.getPath('temp'), 'FC Manager');
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(name || 'document').replace(/[\\/:*?"<>|]+/g, '_').slice(-120);
      const file = path.join(dir, `${Date.now()}-${safe}`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      const err = await shell.openPath(file);
      return err ? { ok: false, error: 'OPEN_FAILED', detail: err } : { ok: true };
    } catch (err) {
      return { ok: false, error: 'OPEN_FAILED', detail: err.message };
    }
  });

  // Prints a stored document (e.g. an absence application) on the default printer with its usual program.
  ipcMain.handle('file:print', async (_e, { name, data }) => {
    try {
      const dir = path.join(app.getPath('temp'), 'FC Manager');
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(name || 'document').replace(/[\\/:*?"<>|]+/g, '_').slice(-120);
      const file = path.join(dir, `${Date.now()}-${safe}`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      await new Promise((resolve, reject) =>
        require('child_process').execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${file.replace(/'/g, "''")}' -Verb Print`],
          { windowsHide: true, timeout: 30000 },
          (err) => (err ? reject(err) : resolve())
        )
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: 'PRINT_FAILED', detail: err.message };
    }
  });

  // A Word file with Word's own print screen (preview, printer, copies) instead of printing straight away.
  // Without Word, the file just opens in its usual program.
  ipcMain.handle('file:printDialog', async (_e, { name, data }) => {
    const dir = path.join(app.getPath('temp'), 'FC Manager');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || 'document.docx').replace(/[\\/:*?"<>|]+/g, '_').slice(-120);
    const file = path.join(dir, `${Date.now()}-${safe}`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    if (process.env.FC_EXPORT_DIR) {
      fs.copyFileSync(file, path.join(process.env.FC_EXPORT_DIR, `print-dialog-${safe}`));
      return { ok: true, via: 'test' };
    }
    const { execFile, spawn } = require('child_process');
    const hasWord = await new Promise((resolve) =>
      execFile('reg.exe', ['query', 'HKCR\\Word.Application\\CurVer'], { windowsHide: true, timeout: 10000 }, (err) => resolve(!err))
    );
    if (!hasWord) {
      const err = await shell.openPath(file); // no Word: its usual program (print from there)
      return err ? { ok: false, error: 'PRINT_FAILED', detail: err } : { ok: true, via: 'open' };
    }
    // Word's Print window (printer, pages, copies). Printing finishes before the file is closed again;
    // Word itself closes only if nothing else is open in it. The app doesn't wait for the window.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$w = New-Object -ComObject Word.Application',
      '$w.Visible = $true',
      '$d = $w.Documents.Open($env:FC_DOC, $false, $true)',
      '$w.Options.PrintBackground = $false',
      '$w.Activate()',
      // Windows keeps a program started in the background behind FC Manager: a tap of Alt lets Word come forward.
      "try { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class FcFg { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); }'; $h = [IntPtr]$w.ActiveWindow.Hwnd; [FcFg]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [void][FcFg]::ShowWindow($h, 3); [void][FcFg]::SetForegroundWindow($h); [FcFg]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero) } catch { }",
      'try { [void]$w.Dialogs.Item(88).Show() } finally { $d.Close(0); if ($w.Documents.Count -eq 0) { $w.Quit() } }',
    ].join('; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_DOC: file },
      windowsHide: true,
      stdio: 'ignore', // not awaited: the app goes on while Word's Print window is open
    });
    child.on('error', () => {});
    child.unref();
    return { ok: true, via: 'word' };
  });

  // Import from another program: pick one or more Excel/CSV files (e.g. one per team) and read them as rows of text.
  ipcMain.handle('import:read', async () => {
    // FC_IMPORT_FILE (testing, several separated by "|"): read without the file dialog.
    let paths = process.env.FC_IMPORT_FILE ? process.env.FC_IMPORT_FILE.split('|') : null;
    if (!paths) {
      const r = await dialog.showOpenDialog(win, {
        filters: [{ name: 'Excel / CSV / FC Manager', extensions: ['xlsx', 'csv', 'txt', 'zip'] }],
        properties: ['openFile', 'multiSelections'],
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, error: 'CANCELLED' };
      paths = r.filePaths;
    }
    // Excel's lock files ("~$2012-1.xlsx") are skipped.
    paths = paths.filter((p) => !path.basename(p).startsWith('~$'));
    try {
      // A full transfer from another FC Manager (zip): its data instead of a table.
      const zipPath = paths.find((p) => /\.zip$/i.test(p));
      if (zipPath) return { ok: true, result: { transfer: readTransfer(zipPath), fileName: path.basename(zipPath) } };
      const files = [];
      for (const p of paths) files.push(await importer.readTable(p));
      return { ok: true, result: { files } };
    } catch (err) {
      return { ok: false, error: 'IMPORT_READ_FAILED', detail: err.message };
    }
  });

  // «Արտահանել տեղափոխման համար»: a zip with transfer.json (all the data), the uploaded documents in files/,
  // and students.xlsx (the same students as a readable table, also importable on its own).
  ipcMain.handle('transfer:save', async (_e, { defaultName, data, xlsx }) => {
    const r = process.env.FC_EXPORT_DIR
      ? { filePath: path.join(process.env.FC_EXPORT_DIR, defaultName) }
      : await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'FC Manager', extensions: ['zip'] }] });
    if (r.canceled || !r.filePath) return { ok: false, error: 'CANCELLED' };
    try {
      const zip = new PizZip();
      let n = 0;
      const out = {
        ...data,
        students: (data.students || []).map((st) => ({
          ...st,
          files: (st.files || []).map((f) => {
            if (!f.data) return f;
            const name = `files/${++n}-${String(f.file_name || 'file').replace(/[^\w.-]+/g, '_').slice(-60)}`;
            zip.file(name, Buffer.from(f.data, 'base64'));
            const { data: _d, ...rest } = f;
            return { ...rest, path: name };
          }),
        })),
      };
      zip.file('transfer.json', JSON.stringify(out));
      if (xlsx) zip.file('students.xlsx', Buffer.from(await buildStudentsTransfer(xlsx)));
      fs.writeFileSync(r.filePath, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
    } catch (err) {
      return { ok: false, error: 'FILE_LOCKED', detail: err.message };
    }
    if (!process.env.FC_EXPORT_DIR) shell.showItemInFolder(r.filePath);
    return { ok: true, result: r.filePath };
  });

  ipcMain.handle('xlsx:save', async (_e, report) => {
    // FC_EXPORT_DIR (testing) saves straight into that folder without asking.
    const r = process.env.FC_EXPORT_DIR
      ? { filePath: path.join(process.env.FC_EXPORT_DIR, report.defaultName) }
      : await dialog.showSaveDialog(win, { defaultPath: report.defaultName, filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
    if (r.canceled || !r.filePath) return { ok: false, error: 'CANCELLED' };
    try {
      const build = { form: buildForm, schedule: buildSchedule, students: buildStudentsTransfer, groups: buildGroups, table: buildTable }[report.kind] || buildReport;
      fs.writeFileSync(r.filePath, Buffer.from(await build(report)));
    } catch (err) {
      // Most often the file is open in Excel and locked.
      return { ok: false, error: 'FILE_LOCKED', detail: err.message };
    }
    if (!process.env.FC_EXPORT_DIR) shell.openPath(r.filePath);
    return { ok: true, result: r.filePath };
  });

  ipcMain.handle('pdf:export', async (_e, { html, defaultName }) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return { ok: false, error: 'CANCELLED' };
    const w = await renderHtmlWindow(html);
    try {
      const pdf = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
      fs.writeFileSync(r.filePath, pdf);
      shell.openPath(r.filePath);
      return { ok: true, result: r.filePath };
    } finally {
      w.destroy();
    }
  });

  ipcMain.handle('print', async (_e, { html }) => {
    const w = await renderHtmlWindow(html);
    // Testing (FC_EXPORT_DIR): save what would be printed as a PDF instead of opening the print dialog.
    if (process.env.FC_EXPORT_DIR) {
      const pdf = await w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
      fs.writeFileSync(path.join(process.env.FC_EXPORT_DIR, `print-${Date.now()}.pdf`), pdf);
      w.destroy();
      return { ok: true };
    }
    return new Promise((resolve) => {
      w.webContents.print({ printBackground: true }, (success, reason) => {
        w.destroy();
        resolve({ ok: success, error: success ? undefined : reason });
      });
    });
  });

  // The printers installed in Windows (for choosing the receipt printer).
  // The network address of a Windows printer (for the direct network mode).
  ipcMain.handle('printers:address', (_e, name) => escpos.printerAddress(name));
  ipcMain.handle('printers:list', async () =>
    (await win.webContents.getPrintersAsync()).map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }))
  );

  // A customer receipt on the thermal (roll) printer, straight to the chosen printer without a dialog.
  // The page is as wide as the roll and as long as the receipt.
  // Modes (Settings → receipt printer):
  //   net    — straight to a network printer (ESC/POS picture on TCP 9100), without the Windows driver;
  //            the default when the printer is on a TCP/IP port
  //   image  — the receipt as a black-and-white picture on a roll-long page (default: works with POS drivers
  //            that swap in their own fonts, which have no Armenian letters and print blank paper)
  //   imageA — the same picture on the driver's own paper size (drivers that ignore a custom page size)
  //   text   — the receipt as text on a roll-long page (the first way; sharpest where the driver allows it)
  ipcMain.handle('thermal:print', async (_e, { html }) => {
    const t = config.thermal || {};
    if (!t.printer && !t.host && !process.env.FC_EXPORT_DIR) return { ok: false, error: 'THERMAL_NOT_SET' };
    const widthMm = Number(t.width) || 80;
    const stamp = Date.now();
    let mode = ['net', 'image', 'imageA', 'text'].includes(t.mode) ? t.mode : null;
    let addr = t.host ? { host: t.host, port: Number(t.port) || 9100 } : null;
    if (mode === 'net' || !mode) addr = addr || (await escpos.printerAddress(t.printer));
    if (!mode) mode = addr ? 'net' : 'image';
    if (mode === 'net') {
      if (!addr) return { ok: false, error: 'THERMAL_NO_HOST' };
      try {
        const img = await receiptImage(html, widthMm, escpos.headDots(widthMm));
        if (process.env.FC_EXPORT_DIR) fs.writeFileSync(path.join(process.env.FC_EXPORT_DIR, `thermal-${stamp}.png`), img.png);
        await escpos.sendRaw(addr.host, addr.port, escpos.rasterJob(img, { cut: t.cut !== false }));
        return { ok: true, mode };
      } catch (err) {
        return { ok: false, error: err.code || 'PRINT_FAILED', detail: err.message };
      }
    }
    let page = html;
    if (mode !== 'text') {
      const { png } = await receiptImage(html, widthMm);
      if (process.env.FC_EXPORT_DIR) fs.writeFileSync(path.join(process.env.FC_EXPORT_DIR, `thermal-${stamp}.png`), png);
      page = `<!doctype html><html><head><meta charset="utf-8"><style>
        @page { margin: 0; } html, body { margin: 0; padding: 0; background: #fff; }
        img { display: block; width: ${widthMm - 8}mm; }
      </style></head><body><img src="data:image/png;base64,${png.toString('base64')}"></body></html>`;
    }
    const w = await renderHtmlWindow(page);
    try {
      // Fonts and the picture fully laid out before printing.
      const heightPx = await w.webContents.executeJavaScript(
        `document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => Math.ceil(document.documentElement.scrollHeight))`
      );
      const pageSize = { width: widthMm * 1000, height: Math.max(40000, Math.ceil(((heightPx + 8) * 25.4 * 1000) / 96)) }; // microns
      if (process.env.FC_EXPORT_DIR) {
        const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: { width: pageSize.width / 25400, height: pageSize.height / 25400 }, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        fs.writeFileSync(path.join(process.env.FC_EXPORT_DIR, `thermal-${stamp}.pdf`), pdf);
        fs.writeFileSync(path.join(process.env.FC_EXPORT_DIR, `thermal-${stamp}.html`), html);
        return { ok: true, mode };
      }
      const opts = { silent: true, deviceName: t.printer, printBackground: true, margins: { marginType: 'none' } };
      if (mode !== 'imageA') opts.pageSize = pageSize;
      return await new Promise((resolve) => w.webContents.print(opts, (success, reason) => resolve({ ok: success, error: success ? undefined : reason })));
    } finally {
      w.destroy();
    }
  });

  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

  // WhatsApp / Viber: opens the parent's chat in the app installed on this PC.
  // WhatsApp gets the text in the box; Viber links can't carry text, so it goes to the clipboard to paste.
  ipcMain.handle('messenger:open', async (_e, { app: which, phone, text }) => {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 8) return { ok: false, error: 'NO_PHONE' };
    // Testing (FC_EXPORT_DIR): write the link that would open instead of opening it.
    const openLink = (url) =>
      process.env.FC_EXPORT_DIR ? fs.appendFileSync(path.join(process.env.FC_EXPORT_DIR, 'messenger.txt'), `${url}\n`) : shell.openExternal(url);
    const installed = (proto) => {
      if (process.env.FC_EXPORT_DIR) return proto === 'whatsapp://' || proto === 'viber://';
      try {
        return !!app.getApplicationNameForProtocol(proto);
      } catch {
        return false;
      }
    };
    try {
      if (which === 'viber') {
        if (!installed('viber://')) return { ok: false, error: 'VIBER_MISSING' };
        clipboard.writeText(String(text || ''));
        await openLink(`viber://chat?number=%2B${digits}`);
        return { ok: true, via: 'viber', copied: true };
      }
      const msg = encodeURIComponent(String(text || ''));
      if (installed('whatsapp://')) {
        await openLink(`whatsapp://send?phone=${digits}&text=${msg}`);
        return { ok: true, via: 'app' };
      }
      await openLink(`https://wa.me/${digits}?text=${msg}`); // WhatsApp Web in the browser
      return { ok: true, via: 'web' };
    } catch (err) {
      return { ok: false, error: 'MESSENGER_FAILED', detail: err.message };
    }
  });
}

// ------------------------------------------------------------------ tray + start with Windows
function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Quit from the tray: asks in the app's own confirm window (CloseGuard in App.jsx), unless the page can't answer.
function requestQuit() {
  if (!win || win.isDestroyed() || win.webContents.isLoading() || win.webContents.isCrashed()) {
    quitting = true;
    app.quit();
    return;
  }
  showWindow();
  toPage('close-requested');
}

function createTray() {
  const dir = path.join(__dirname, 'icons');
  tray = new Tray(nativeImage.createFromPath(path.join(dir, 'tray.png')));
  tray.setToolTip('FC Manager');
  const hy = config.language === 'hy';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: hy ? 'Բացել FC Manager-ը' : 'Open FC Manager', click: showWindow },
      { type: 'separator' },
      { label: hy ? 'Դուրս գալ' : 'Quit', click: requestQuit },
    ])
  );
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// Registers (or removes) the Windows sign-in start. Only for the installed app, not dev/test copies.
function applyAutoStart() {
  if (!app.isPackaged || process.env.FC_USER_DATA) return;
  app.setLoginItemSettings({ openAtLogin: config.autoStart !== false, args: ['--hidden'] });
}

// ------------------------------------------------------------------ app lifecycle
// Date fields show day/month/year (dd/MM/yyyy) whatever the Windows language is.
app.commandLine.appendSwitch('lang', 'en-GB');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
  });

  app.whenReady().then(async () => {
    config = loadConfig();
    authToken = config.authToken || null;
    registerIpc();
    try {
      await startBackend();
    } catch (err) {
      dialog.showErrorBox('FC Manager', `Could not open the database:\n${err.message}`);
    }
    createWindow();
    createTray();
    applyAutoStart();
    updater.setup((s) => toPage('update-status', s));
  });

  app.on('window-all-closed', () => {
    stopBackend();
    app.quit();
  });
}
