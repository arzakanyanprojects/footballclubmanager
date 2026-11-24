// Backups to Google Drive through the Drive API (no Google app needed on the PC).
// Sign-in: the browser opens Google's page; Google sends the answer back to a one-time local address
// (http://127.0.0.1:<port>, PKCE). Only the files this app creates are visible to it (drive.file scope).
// The refresh token is kept encrypted with Windows' own protection (safeStorage).
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'FC Manager Backups';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// FC_GDRIVE_MOCK=http://127.0.0.1:port sends every call to a local test server instead of Google.
function endpoints() {
  const m = process.env.FC_GDRIVE_MOCK;
  return {
    auth: m ? `${m}/o/oauth2/v2/auth` : 'https://accounts.google.com/o/oauth2/v2/auth',
    token: m ? `${m}/token` : 'https://oauth2.googleapis.com/token',
    revoke: m ? `${m}/revoke` : 'https://oauth2.googleapis.com/revoke',
    api: m ? `${m}/drive/v3` : 'https://www.googleapis.com/drive/v3',
    upload: m ? `${m}/upload/drive/v3` : 'https://www.googleapis.com/upload/drive/v3',
  };
}

class DriveError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * deps: getCfg() → config.gdrive, setCfg(patch), encrypt(str) → str, decrypt(str) → str,
 *       openUrl(url), keep (backups kept in Drive), lang() → 'hy' | 'en'
 */
function createGDrive({ getCfg, setCfg, encrypt, decrypt, openUrl, keep = 30, lang = () => 'hy' }) {
  let access = null; // { token, until }
  let queue = Promise.resolve();
  let busy = false;
  let pending = null; // sign-in in progress: { server, reject }

  const cfg = () => getCfg() || {};
  const configured = () => !!(cfg().clientId && cfg().clientSecret);
  const refreshToken = () => {
    try {
      return cfg().refresh ? decrypt(cfg().refresh) : null;
    } catch {
      return null;
    }
  };

  function status() {
    const c = cfg();
    return {
      configured: configured(),
      connected: !!(c.refresh && configured()),
      clientId: c.clientId || '',
      hasSecret: !!c.clientSecret,
      email: c.email || null,
      enabled: !!c.enabled,
      lastAt: c.lastAt || null,
      lastFile: c.lastFile || null,
      lastError: c.lastError || null,
      busy,
      signingIn: !!pending,
    };
  }

  async function post(url, form) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new DriveError(j.error === 'invalid_grant' ? 'GDRIVE_REAUTH' : 'GDRIVE_AUTH', j.error_description || j.error || `HTTP ${r.status}`);
    return j;
  }

  async function token() {
    if (access && access.until > Date.now() + 60000) return access.token;
    const rt = refreshToken();
    if (!rt || !configured()) throw new DriveError('GDRIVE_NOT_CONNECTED');
    try {
      const j = await post(endpoints().token, { client_id: cfg().clientId, client_secret: cfg().clientSecret, refresh_token: rt, grant_type: 'refresh_token' });
      access = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
      return access.token;
    } catch (err) {
      // Access taken back in the Google account (or the token expired): sign in again.
      if (err.code === 'GDRIVE_REAUTH') setCfg({ refresh: null, lastError: 'GDRIVE_REAUTH' });
      throw err;
    }
  }

  async function api(method, url, { json, body, headers = {}, raw = false } = {}) {
    const t = await token();
    const r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${t}`, ...(json ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}), ...headers },
      body: json ? JSON.stringify(json) : body,
    });
    if (raw) return r;
    if (r.status === 204) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new DriveError(r.status === 403 && /quota|storage/i.test(JSON.stringify(j)) ? 'GDRIVE_FULL' : 'GDRIVE_API', j.error?.message || `HTTP ${r.status}`);
    return j;
  }

  // The backups folder (made by this app, so visible with drive.file).
  async function folder() {
    const E = endpoints();
    const id = cfg().folderId;
    if (id) {
      try {
        const f = await api('GET', `${E.api}/files/${encodeURIComponent(id)}?fields=id,trashed`);
        if (f && !f.trashed) return id;
      } catch {
        /* gone — find or make it again */
      }
    }
    const q = `name = '${FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const found = await api('GET', `${E.api}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
    const fid = found.files?.[0]?.id || (await api('POST', `${E.api}/files?fields=id`, { json: { name: FOLDER_NAME, mimeType: FOLDER_MIME } })).id;
    setCfg({ folderId: fid });
    return fid;
  }

  async function listFiles() {
    const E = endpoints();
    const fid = await folder();
    const q = `'${fid}' in parents and trashed = false`;
    const out = [];
    let pageToken = '';
    do {
      const j = await api(
        'GET',
        `${E.api}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,size,createdTime)&orderBy=name desc&pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`
      );
      out.push(...(j.files || []));
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out.filter((f) => /^fcmanager-.*\.db$/.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
  }

  async function uploadNow(file) {
    const E = endpoints();
    const fid = await folder();
    const data = fs.readFileSync(file);
    const start = await api('POST', `${E.upload}/files?uploadType=resumable&fields=id`, {
      json: { name: path.basename(file), parents: [fid] },
      headers: { 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(data.length) },
      raw: true,
    });
    if (!start.ok) throw new DriveError(start.status === 403 ? 'GDRIVE_FULL' : 'GDRIVE_API', `HTTP ${start.status}`);
    const where = start.headers.get('location');
    if (!where) throw new DriveError('GDRIVE_API', 'no upload address');
    const put = await fetch(where, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data });
    if (!put.ok) throw new DriveError(put.status === 403 ? 'GDRIVE_FULL' : 'GDRIVE_API', `upload HTTP ${put.status}`);
    // Keep only the newest copies in Drive too.
    const files = await listFiles();
    for (const f of files.slice(keep)) await api('DELETE', `${E.api}/files/${encodeURIComponent(f.id)}`).catch(() => {});
  }

  // Queued: one upload at a time, in order. Never throws (the result is kept in the status).
  function upload(file, { force = false } = {}) {
    if (!force && !cfg().enabled) return Promise.resolve(false);
    if (!refreshToken() || !configured()) return Promise.resolve(false);
    queue = queue.then(async () => {
      busy = true;
      try {
        await uploadNow(file);
        setCfg({ lastAt: new Date().toISOString(), lastFile: path.basename(file), lastError: null });
        return true;
      } catch (err) {
        console.error('[gdrive] upload failed:', err.message);
        setCfg({ lastError: err.code && err.code !== 'GDRIVE_API' ? err.code : err.message });
        return false;
      } finally {
        busy = false;
      }
    });
    return queue;
  }

  async function download(id, dest) {
    const E = endpoints();
    const r = await api('GET', `${E.api}/files/${encodeURIComponent(id)}?alt=media`, { raw: true });
    if (!r.ok) throw new DriveError('GDRIVE_API', `HTTP ${r.status}`);
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return dest;
  }

  // The page the browser shows after Google sends it back.
  const donePage = (ok) => {
    const hy = lang() === 'hy';
    const text = ok
      ? hy
        ? 'FC Manager-ը միացված է Google Drive-ին։ Կարող եք փակել այս էջը։'
        : 'FC Manager is connected to Google Drive. You can close this page.'
      : hy
        ? 'Միացումը չհաջողվեց։ Վերադարձեք FC Manager և փորձեք նորից։'
        : 'Connecting failed. Go back to FC Manager and try again.';
    return `<!doctype html><meta charset="utf-8"><title>FC Manager</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;color:#222"><div style="text-align:center"><div style="font-size:42px">${ok ? '✓' : '✕'}</div><p>${text}</p></div>`;
  };

  function connect() {
    if (!configured()) return Promise.reject(new DriveError('GDRIVE_NOT_CONFIGURED'));
    if (pending) {
      pending.reject(new DriveError('CANCELLED'));
      pending.server.close();
      pending = null;
    }
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      const finish = (err, value) => {
        clearTimeout(timer);
        setTimeout(() => server.close(), 500);
        pending = null;
        if (err) reject(err);
        else resolve(value === undefined ? status() : value);
      };
      const timer = setTimeout(() => finish(new DriveError('GDRIVE_TIMEOUT')), 5 * 60 * 1000);
      pending = { server, reject: (e) => finish(e) };
      server.on('request', async (req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/') {
          res.writeHead(404).end();
          return;
        }
        const code = u.searchParams.get('code');
        const ok = code && u.searchParams.get('state') === state;
        try {
          if (!ok) throw new DriveError(u.searchParams.get('error') === 'access_denied' ? 'CANCELLED' : 'GDRIVE_AUTH', u.searchParams.get('error') || 'bad answer');
          const redirect = `http://127.0.0.1:${server.address().port}`;
          const j = await post(endpoints().token, {
            client_id: cfg().clientId,
            client_secret: cfg().clientSecret,
            code,
            code_verifier: verifier,
            redirect_uri: redirect,
            grant_type: 'authorization_code',
          });
          if (!j.refresh_token) throw new DriveError('GDRIVE_AUTH', 'no refresh token');
          access = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
          setCfg({ refresh: encrypt(j.refresh_token), lastError: null, folderId: null });
          let email = null;
          try {
            email = (await api('GET', `${endpoints().api}/about?fields=user(emailAddress)`)).user?.emailAddress || null;
          } catch {
            /* the account name is only for show */
          }
          setCfg({ email });
          await folder();
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(donePage(true));
          finish(null);
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(donePage(false));
          finish(err);
        }
      });
      server.listen(0, '127.0.0.1', () => {
        const redirect = `http://127.0.0.1:${server.address().port}`;
        const url = `${endpoints().auth}?${new URLSearchParams({
          client_id: cfg().clientId,
          redirect_uri: redirect,
          response_type: 'code',
          scope: SCOPE,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent',
          state,
        })}`;
        openUrl(url);
      });
    });
  }

  async function disconnect() {
    const rt = refreshToken();
    if (rt) await fetch(`${endpoints().revoke}?token=${encodeURIComponent(rt)}`, { method: 'POST' }).catch(() => {});
    access = null;
    setCfg({ refresh: null, email: null, folderId: null, enabled: false, lastError: null });
  }

  return { status, connect, disconnect, upload, list: listFiles, download, DriveError };
}

module.exports = { createGDrive };
