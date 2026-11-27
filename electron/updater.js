// Automatic updates from the GitHub Releases of arzakanyanprojects/footballclubmanager
// (set in package.json → build.publish). Updates are mandatory, but don't interrupt the work: a new
// version downloads in the background, then the app warns that it restarts in 3 minutes (status.installAt)
// so the user can finish and save what they are doing — or press «Update now». At 0 it installs by itself.
const { app } = require('electron');

let autoUpdater = null;
let status = { state: 'idle', current: null };
let notify = () => {};
let onReady = () => {};
let autoInstall = () => install();
let installTimer = null;

const CHECK_EVERY = 30 * 60 * 1000; // 30 minutes
const INSTALL_DELAY = 3 * 60 * 1000; // the warning before the automatic restart

// The new version is downloaded: install it by itself after INSTALL_DELAY.
function ready(version) {
  clearTimeout(installTimer);
  const installAt = Date.now() + INSTALL_DELAY;
  set({ state: 'ready', version, installAt });
  installTimer = setTimeout(() => autoInstall(), INSTALL_DELAY);
  onReady(status);
}

function set(next) {
  status = { ...status, ...next, current: app.getVersion() };
  notify(status);
}

// onStatus(status): every change. opts.onReady(status): the download finished and the countdown started.
// opts.install(): what runs when the countdown ends (the app's own quit-and-install).
function setup(onStatus, opts = {}) {
  notify = onStatus;
  if (opts.onReady) onReady = opts.onReady;
  if (opts.install) autoInstall = opts.install;
  status.current = app.getVersion();
  if (!app.isPackaged) {
    status.state = 'dev';
    // Testing (FC_FAKE_UPDATE=1.2.3): pretend that version was found and downloads, to see the update screen.
    if (process.env.FC_FAKE_UPDATE) {
      setTimeout(() => {
        set({ state: 'downloading', version: process.env.FC_FAKE_UPDATE, percent: 0, required: true });
        const tick = setInterval(() => {
          const percent = Math.min(100, (status.percent || 0) + 20);
          if (percent < 100) set({ percent });
          else {
            clearInterval(tick);
            ready(process.env.FC_FAKE_UPDATE);
          }
        }, 1000);
      }, 3000);
    }
    return;
  }
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => set({ state: 'none', checkedAt: new Date().toISOString() }));
  autoUpdater.on('update-available', (i) => set({ state: 'downloading', version: i.version, percent: 0, required: true, error: null }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => ready(i.version));
  autoUpdater.on('error', (err) => {
    const msg = String(err?.message || err);
    // No release published yet on GitHub: nothing to update to.
    if (/404|No published versions|Cannot find latest/i.test(msg)) set({ state: 'none', checkedAt: new Date().toISOString() });
    else set({ state: 'error', error: msg.split('\n')[0].slice(0, 200) });
  });

  setTimeout(check, 3 * 1000);
  setInterval(check, CHECK_EVERY);
}

function check() {
  if (!autoUpdater) return status;
  if (['checking', 'downloading', 'ready'].includes(status.state)) return status;
  if (status.required) set({ state: 'downloading', percent: 0, error: null }); // trying again after a failed download
  autoUpdater.checkForUpdates().catch(() => {}); // reported through the 'error' event
  return status;
}

function install() {
  if (autoUpdater && status.state === 'ready') autoUpdater.quitAndInstall(true, true);
}

module.exports = { setup, check, install, getStatus: () => status };
