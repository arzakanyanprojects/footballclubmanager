import { useCallback, useEffect, useRef, useState, createContext, useContext } from 'react';

// ------------------------------------------------------------------ RPC bridge
export class RpcError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const READ_ONLY = /\.(get|list|summary|sheet|month|preview|document|status)$/;

export async function rpc(method, params) {
  const r = await window.fc.rpc(method, params);
  if (!r.ok) {
    // The session ended (signed out elsewhere, user disabled): show the sign-in screen.
    if (r.error === 'AUTH_REQUIRED') window.dispatchEvent(new Event('fc-auth-lost'));
    throw new RpcError(r.error, r.detail);
  }
  // Refresh this window immediately; other PCs pick the change up by polling the host.
  if (!READ_ONLY.test(method) && !method.startsWith('auth.')) window.dispatchEvent(new Event('fc-local-change'));
  return r.result;
}

export const DataVersion = createContext(0);

export function useRpc(method, params, { skip = false } = {}) {
  const key = JSON.stringify(params ?? null);
  const version = useContext(DataVersion);
  const [state, setState] = useState({ data: null, loading: !skip, error: null });
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await rpc(method, JSON.parse(key));
      if (id === seq.current) setState({ data, loading: false, error: null });
    } catch (error) {
      if (id === seq.current) setState((s) => ({ ...s, loading: false, error }));
    }
  }, [method, key]);

  useEffect(() => {
    if (!skip) load();
  }, [load, version, skip]);

  return { ...state, reload: load };
}

// ------------------------------------------------------------------ dates & money
const pad = (n) => String(n).padStart(2, '0');
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const currentPeriod = () => todayIso().slice(0, 7);
export const addMonths = (period, n) => {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
export const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
};
// The 12 months of the football season that contains `period` (August to July).
export function seasonMonths(period = currentPeriod()) {
  const [y, m] = period.split('-').map(Number);
  const start = `${m >= 8 ? y : y - 1}-08`;
  return Array.from({ length: 12 }, (_, i) => addMonths(start, i));
}
export const fmtDate = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
export const fmtDateTime = (s) => (s ? `${fmtDate(s.slice(0, 10))} ${s.slice(11, 16)}` : '—');
export const daysInMonth = (period) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};
export const weekday = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
};

export function age(birth) {
  if (!birth) return null;
  const [y, m, d] = birth.split('-').map(Number);
  const now = new Date();
  let a = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) a--;
  return a;
}

const SYMBOLS = { AMD: '֏', USD: '$', EUR: '€', RUB: '₽', GEL: '₾' };
export function money(n, currency = 'AMD') {
  const v = Number(n || 0).toLocaleString('en-US');
  const sym = SYMBOLS[currency] || currency;
  return currency === 'USD' || currency === 'EUR' ? `${sym}${v}` : `${v} ${sym}`;
}
export function compactMoney(n, currency = 'AMD') {
  const v = Number(n || 0);
  const sym = SYMBOLS[currency] || currency;
  const s = v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}K` : String(v);
  return currency === 'USD' || currency === 'EUR' ? `${sym}${s}` : `${s} ${sym}`;
}

// ------------------------------------------------------------------ misc
const AVATAR_COLORS = ['#2a78d6', '#d0562a', '#138a5e', '#b07d00', '#c2477a', '#5b4bd1', '#2f8f9d', '#8a5a2b'];
export const avatarColor = (seed) => AVATAR_COLORS[Math.abs(hash(String(seed))) % AVATAR_COLORS.length];
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export function toCsv(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM so Excel opens Armenian text correctly.
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

// perm: the user's tick that allows this export (e.g. 'payments.excel').
export async function saveCsv(name, perm, rows) {
  return window.fc.saveFile({ defaultName: name, content: toCsv(rows), filters: [{ name: 'CSV', extensions: ['csv'] }], perm });
}

export function resizeImage(file, size = 320) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const s = Math.min(img.width, img.height);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// A picked file as { name, type, data (base64) } for uploading.
export function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve({ name: file.name, type: file.type, data: String(reader.result).split(',')[1] || '' });
    reader.readAsDataURL(file);
  });
}

export const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Shrinks a picture to fit in max×max, keeping its shape and transparency (club logo).
export function fitImage(file, max = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * k);
        canvas.height = Math.round(img.height * k);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ------------------------------------------------------------------ contract documents
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Tiny markup for templates: "# " title, "## " heading, **bold**, blank line = new paragraph.
export function contractBodyHtml(body) {
  const blocks = String(body || '').replace(/\r/g, '').split(/\n{2,}/);
  return blocks
    .map((block) => {
      const inline = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      const lines = block.split('\n');
      const out = [];
      let para = [];
      const flush = () => {
        if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
        para = [];
      };
      for (const line of lines) {
        if (line.startsWith('# ')) {
          flush();
          out.push(`<h1>${inline(line.slice(2))}</h1>`);
        } else if (line.startsWith('## ')) {
          flush();
          out.push(`<h2>${inline(line.slice(3))}</h2>`);
        } else if (line.trim()) para.push(line);
      }
      flush();
      return out.join('');
    })
    .join('');
}

export function contractDocument(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title || '')}</title>
<style>
  @page { size: A4; margin: 20mm 18mm; }
  body { font-family: 'Segoe UI', Sylfaen, Arial, sans-serif; font-size: 12pt; line-height: 1.55; color: #111; margin: 0; }
  h1 { font-size: 15pt; text-align: center; margin: 0 0 14pt; }
  h2 { font-size: 12.5pt; margin: 14pt 0 5pt; }
  p { margin: 0 0 7pt; }
</style></head><body>${contractBodyHtml(body)}</body></html>`;
}
