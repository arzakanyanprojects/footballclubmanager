// Direct printing to a receipt printer over the network (ESC/POS on TCP 9100), bypassing the Windows
// driver: many POS-80 drivers print blank paper from apps, while the printer itself always prints raster
// images sent as GS v 0. The receipt is drawn as a 1-bit picture as wide as the print head.
const net = require('net');
const { execFile } = require('child_process');

// Print-head width in dots (203 dpi): 80 mm roll → 576, 58 mm roll → 384.
const headDots = (widthMm) => (Number(widthMm) >= 80 ? 576 : 384);

// bits: Uint8Array, one byte per pixel, 1 = black. Width is padded to whole bytes.
function rasterJob({ width, height, bits }, { cut = true } = {}) {
  const bytesPerRow = Math.ceil(width / 8);
  const parts = [Buffer.from([0x1b, 0x40])]; // ESC @ — reset
  const BAND = 128; // rows per GS v 0 block (small blocks suit every printer's buffer)
  for (let y0 = 0; y0 < height; y0 += BAND) {
    const rows = Math.min(BAND, height - y0);
    const head = Buffer.from([0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8]);
    const data = Buffer.alloc(bytesPerRow * rows);
    for (let y = 0; y < rows; y++) {
      const src = (y0 + y) * width;
      for (let x = 0; x < width; x++) if (bits[src + x]) data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
    parts.push(head, data);
  }
  parts.push(Buffer.from([0x1b, 0x64, 0x04])); // ESC d 4 — feed 4 lines
  if (cut) parts.push(Buffer.from([0x1d, 0x56, 0x42, 0x00])); // GS V B 0 — feed to the cutter and cut
  return Buffer.concat(parts);
}

// Sends the bytes to host:port and waits until the printer has taken them.
function sendRaw(host, port, data, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: Number(port) || 9100 });
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    sock.setTimeout(timeoutMs, () => finish(Object.assign(new Error(`${host}:${port || 9100}`), { code: 'THERMAL_NET' })));
    sock.on('error', (e) => finish(Object.assign(new Error(`${host}:${port || 9100} — ${e.code || e.message}`), { code: 'THERMAL_NET' })));
    sock.on('connect', () => sock.end(data, () => setTimeout(() => finish(), 300)));
  });
}

// The network address of a printer installed in Windows (its Standard TCP/IP port), or null.
function printerAddress(name) {
  if (process.platform !== 'win32' || !name) return Promise.resolve(null);
  const script =
    "$p = Get-Printer -Name $env:FC_PRN -ErrorAction Stop; $pp = Get-PrinterPort -Name $p.PortName -ErrorAction SilentlyContinue; " +
    '[pscustomobject]@{ port = $p.PortName; host = $pp.PrinterHostAddress; number = $pp.PortNumber } | ConvertTo-Json -Compress';
  return new Promise((resolve) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, FC_PRN: name }, windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const r = JSON.parse(String(stdout).trim());
          // A port named like an address (IP_10.10.10.25) when the port has no host field.
          const host = r.host || (String(r.port).match(/(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1] || null;
          resolve(host ? { host, port: Number(r.number) || 9100 } : null);
        } catch {
          resolve(null);
        }
      }
    )
  );
}

module.exports = { headDots, rasterJob, sendRaw, printerAddress };
