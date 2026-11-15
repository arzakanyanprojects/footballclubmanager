// LAN sharing: the host PC serves the service over HTTP; other PCs call it remotely.
// A UDP broadcast lets client PCs find the host without typing an IP address.
const http = require('http');
const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 47801;
const DISCOVERY_PING = 'FCMANAGER_DISCOVER';
const MAX_BODY = 20 * 1024 * 1024;

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

function broadcastAddresses() {
  const set = new Set(['255.255.255.255']);
  for (const { address, netmask } of localAddresses()) {
    const ip = address.split('.').map(Number);
    const mask = netmask.split('.').map(Number);
    set.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
  }
  return [...set];
}

function startHost({ service, port, getKey, getVersion, getInfo }) {
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/ping') return send(200, { app: 'FCManager', ...getInfo() });
    if (req.headers['x-fc-key'] !== getKey()) return send(401, { ok: false, error: 'ACCESS_DENIED' });
    if (req.method === 'GET' && req.url === '/version') return send(200, { ok: true, version: getVersion() });
    if (req.method !== 'POST' || req.url !== '/rpc') return send(404, { ok: false, error: 'NOT_FOUND' });

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { ok: false, error: 'BAD_REQUEST' });
      }
      const user = msg.user ? `${msg.user}` : `${req.socket.remoteAddress}`;
      send(200, service.call(msg.method, msg.params, { user, token: msg.token || null }));
    });
  });

  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (buf, rinfo) => {
    if (buf.toString() !== DISCOVERY_PING) return;
    const reply = Buffer.from(JSON.stringify({ app: 'FCManager', port, ...getInfo() }));
    udp.send(reply, rinfo.port, rinfo.address);
  });
  udp.on('error', (err) => console.warn('[discovery]', err.message));
  udp.bind(DISCOVERY_PORT);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () =>
      resolve({
        close: () => {
          server.close();
          server.closeAllConnections?.();
          try {
            udp.close();
          } catch {}
        },
      })
    );
  });
}

function discoverHosts(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    sock.on('message', (buf, rinfo) => {
      try {
        const info = JSON.parse(buf.toString());
        if (info.app === 'FCManager') found.set(`${rinfo.address}:${info.port}`, { address: rinfo.address, ...info });
      } catch {}
    });
    sock.on('error', () => {});
    sock.bind(() => {
      sock.setBroadcast(true);
      const ping = Buffer.from(DISCOVERY_PING);
      for (const addr of broadcastAddresses()) sock.send(ping, DISCOVERY_PORT, addr, () => {});
    });
    setTimeout(() => {
      try {
        sock.close();
      } catch {}
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

// Client side: forwards calls to the host and watches it for changes made by other PCs.
function createRemote({ host, port, key, getUser, getToken, onChange, onStatus }) {
  const base = `http://${host}:${port}`;
  let online = null;
  let lastVersion = null;
  let stopped = false;

  const setOnline = (v) => {
    if (v !== online) {
      online = v;
      onStatus?.(v);
    }
  };

  async function request(path, opts = {}) {
    const res = await fetch(base + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'x-fc-key': key, ...(opts.headers || {}) },
      signal: AbortSignal.timeout(opts.timeout || 15000),
    });
    const body = await res.json();
    if (res.status === 401) return { ok: false, error: 'ACCESS_DENIED' };
    return body;
  }

  async function call(method, params) {
    try {
      const r = await request('/rpc', { method: 'POST', body: JSON.stringify({ method, params, user: getUser(), token: getToken?.() || null }) });
      setOnline(true);
      return r;
    } catch {
      setOnline(false);
      return { ok: false, error: 'HOST_UNREACHABLE' };
    }
  }

  async function poll() {
    if (stopped) return;
    try {
      const r = await request('/version', { timeout: 4000 });
      setOnline(r.ok !== false);
      if (r.ok && r.version !== lastVersion) {
        if (lastVersion !== null) onChange?.();
        lastVersion = r.version;
      }
    } catch {
      setOnline(false);
    }
    if (!stopped) timer = setTimeout(poll, 3000);
  }
  let timer = setTimeout(poll, 0);

  return {
    call,
    isOnline: () => online,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

async function testHost({ host, port, key }) {
  try {
    const ping = await fetch(`http://${host}:${port}/ping`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
    if (ping.app !== 'FCManager') return { ok: false, error: 'HOST_UNREACHABLE' };
    const v = await fetch(`http://${host}:${port}/version`, {
      headers: { 'x-fc-key': key },
      signal: AbortSignal.timeout(4000),
    });
    if (v.status === 401) return { ok: false, error: 'ACCESS_DENIED' };
    return { ok: true, result: ping };
  } catch {
    return { ok: false, error: 'HOST_UNREACHABLE' };
  }
}

module.exports = { startHost, discoverHosts, createRemote, testHost, localAddresses };
