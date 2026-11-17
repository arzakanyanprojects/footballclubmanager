const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { openDatabase } = require('./db');
const { createService, DEFAULT_TEMPLATES } = require('./service');
const notify = require('./notify');
const network = require('./network');
const { buildReport, buildForm, buildSchedule, buildStudentsTransfer } = require('./xlsx');
const hdm = require('./hdm');
const updater = require('./updater');
const importer = require('./importer');

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
let changeTimer = null;
function notifyChanged() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => win?.webContents.send('data-changed'), 80);
}

function sendStatus() {
  win?.webContents.send('connection-status', remote ? remote.isOnline() : true);
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

function createBackup(label = 'manual') {
  if (!db) throw new Error('Backups are made on the host PC');
  fs.mkdirSync(backupDir(), { recursive: true });
  const file = path.join(backupDir(), `fcmanager-${stamp()}-${label}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  cloudCopy(file);
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // Started by Windows at sign-in: stay in the tray.
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });

  // × hides the window to the tray; the app keeps running (other PCs stay connected).
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!config.trayHintShown && tray) {
      tray.displayBalloon({
        title: 'FC Manager',
        content: config.language === 'hy'
          ? 'Ծրագիրը շարունակում է աշխատել։ Բացելու կամ փակելու համար օգտագործեք ժամացույցի մոտի նշանը։'
          : 'FC Manager keeps running. Use the icon near the clock to open or quit it.',
        iconType: 'info',
      });
      config.trayHintShown = true;
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
          }
        : null,
  };
}

async function renderHtmlWindow(html) {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return w;
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
    if (config.mode === 'host' && service) return service.call(method, params, { user: config.operator || 'host', token: authToken });
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
    const source = pick.filePaths[0];
    createBackup('before-restore');
    stopBackend();
    for (const suffix of ['-wal', '-shm']) fs.rmSync(dbFile() + suffix, { force: true });
    fs.copyFileSync(source, dbFile());
    await startBackend();
    dataVersion++;
    notifyChanged();
    return { ok: true };
  });

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

  // Import from another program: pick one or more Excel/CSV files (e.g. one per team) and read them as rows of text.
  ipcMain.handle('import:read', async () => {
    // FC_IMPORT_FILE (testing, several separated by "|"): read without the file dialog.
    let paths = process.env.FC_IMPORT_FILE ? process.env.FC_IMPORT_FILE.split('|') : null;
    if (!paths) {
      const r = await dialog.showOpenDialog(win, {
        filters: [{ name: 'Excel / CSV', extensions: ['xlsx', 'csv', 'txt'] }],
        properties: ['openFile', 'multiSelections'],
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, error: 'CANCELLED' };
      paths = r.filePaths;
    }
    // Excel's lock files ("~$2012-1.xlsx") are skipped.
    paths = paths.filter((p) => !path.basename(p).startsWith('~$'));
    try {
      const files = [];
      for (const p of paths) files.push(await importer.readTable(p));
      return { ok: true, result: { files } };
    } catch (err) {
      return { ok: false, error: 'IMPORT_READ_FAILED', detail: err.message };
    }
  });

  ipcMain.handle('xlsx:save', async (_e, report) => {
    // FC_EXPORT_DIR (testing) saves straight into that folder without asking.
    const r = process.env.FC_EXPORT_DIR
      ? { filePath: path.join(process.env.FC_EXPORT_DIR, report.defaultName) }
      : await dialog.showSaveDialog(win, { defaultPath: report.defaultName, filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
    if (r.canceled || !r.filePath) return { ok: false, error: 'CANCELLED' };
    try {
      const build = { form: buildForm, schedule: buildSchedule, students: buildStudentsTransfer }[report.kind] || buildReport;
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

  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
}

// ------------------------------------------------------------------ tray + start with Windows
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Quit from the tray: asks in the app's own confirm window (CloseGuard in App.jsx), unless the page can't answer.
function requestQuit() {
  if (!win || win.webContents.isLoading() || win.webContents.isCrashed()) {
    quitting = true;
    app.quit();
    return;
  }
  showWindow();
  win.webContents.send('close-requested');
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
    updater.setup((s) => win?.webContents.send('update-status', s));
  });

  app.on('window-all-closed', () => {
    stopBackend();
    app.quit();
  });
}
