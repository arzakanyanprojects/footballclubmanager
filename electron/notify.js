// Sends queued email / Telegram messages and runs the scheduled ones (daily and monthly summaries,
// automatic payment reminders). Runs on the host PC only; settings are per host (config.notify).
const nodemailer = require('nodemailer');

const DEFAULTS = {
  email: { enabled: false, host: '', port: 465, secure: true, user: '', password: '', fromName: '' },
  telegram: { enabled: false, token: '', chats: [] }, // chats: [{ id, name, on }]
  receipts: false, // email the parent after each payment
  paymentAlerts: false, // Telegram message to the staff for each payment
  reminders: { auto: false, day: 20 }, // overdue reminders on this day of the month
  daily: { enabled: false, time: '20:00' },
  monthly: { enabled: false }, // on the 1st, for the previous month
  summaryEmails: '',
  templates: {},
  state: {}, // what the scheduler already did: { daily: '2026-11-15', monthly: '2026-10', reminders: '2026-11' }
};

const MAX_ATTEMPTS = 5;
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

let transport = null;
let transportKey = '';
function mailer(cfg) {
  const e = cfg.email;
  const key = JSON.stringify([e.host, e.port, e.secure, e.user, e.password]);
  if (!transport || key !== transportKey) {
    transport = nodemailer.createTransport({
      host: e.host,
      port: Number(e.port) || 465,
      secure: !!e.secure,
      auth: e.user ? { user: e.user, pass: e.password } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
    });
    transportKey = key;
  }
  return transport;
}

async function sendEmail(cfg, { to, subject, text }) {
  if (!cfg.email.enabled || !cfg.email.host) throw new Error('Email is not set up');
  const from = cfg.email.fromName ? `"${cfg.email.fromName.replace(/"/g, '')}" <${cfg.email.user}>` : cfg.email.user;
  await mailer(cfg).sendMail({ from, to, subject: subject || '', text });
}

async function telegram(cfg, method, body) {
  const token = cfg.telegram.token;
  if (!token) throw new Error('Telegram bot token is not set');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `Telegram error ${res.status}`);
  return data.result;
}

const sendTelegram = (cfg, { chatId, text }) => {
  if (!cfg.telegram.enabled) throw new Error('Telegram is not set up');
  return telegram(cfg, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
};

// Chats that wrote to the bot recently (staff press "Start" in Telegram, then click "Find chats").
async function findChats(cfg) {
  const updates = await telegram(cfg, 'getUpdates', { limit: 100 });
  const chats = new Map();
  for (const u of updates) {
    const c = (u.message || u.my_chat_member || u.channel_post || {}).chat;
    if (c) chats.set(String(c.id), { id: String(c.id), name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id) });
  }
  return [...chats.values()];
}

/**
 * getConfig(): the merged notify settings; saveState(patch): stores scheduler progress.
 * getService(): the host's service (null while it restarts).
 */
function startWorker({ getConfig, saveState, getService }) {
  let busy = false;

  async function sendPending() {
    const service = getService();
    if (!service || busy) return;
    busy = true;
    try {
      const cfg = getConfig();
      for (const m of service.outbox.pending()) {
        try {
          if (m.channel === 'email') await sendEmail(cfg, { to: m.recipient, subject: m.subject, text: m.body });
          else await sendTelegram(cfg, { chatId: m.recipient, text: m.body });
          service.outbox.sent(m.id);
        } catch (err) {
          service.outbox.failed(m.id, err.message, m.attempts + 1 >= MAX_ATTEMPTS);
        }
      }
    } catch (err) {
      console.error('[notify] send failed:', err.message);
    } finally {
      busy = false;
    }
  }

  function schedule() {
    const service = getService();
    if (!service) return;
    const cfg = getConfig();
    const now = new Date();
    const today = localDay(now);
    const month = today.slice(0, 7);
    const st = cfg.state || {};
    try {
      // Daily summary at the chosen time (or later the same day if the PC was off).
      const [hh, mm] = String(cfg.daily.time || '20:00').split(':').map(Number);
      if (cfg.daily.enabled && st.daily !== today && now.getHours() * 60 + now.getMinutes() >= hh * 60 + (mm || 0)) {
        service.outbox.summary('daily', today);
        saveState({ daily: today });
      }
      // Monthly summary for the previous month, from the 1st.
      if (cfg.monthly.enabled && st.monthly !== month) {
        const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        service.outbox.summary('monthly', `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}`);
        saveState({ monthly: month });
      }
      // Automatic reminders, once a month from the chosen day.
      if (cfg.reminders.auto && st.reminders !== month && now.getDate() >= Number(cfg.reminders.day || 20)) {
        service.outbox.autoReminders();
        saveState({ reminders: month });
      }
    } catch (err) {
      console.error('[notify] schedule failed:', err.message);
    }
    sendPending();
  }

  const sendTimer = setInterval(sendPending, 20 * 1000);
  const scheduleTimer = setInterval(schedule, 60 * 1000);
  setTimeout(schedule, 10 * 1000);
  return {
    sendNow: sendPending,
    stop: () => {
      clearInterval(sendTimer);
      clearInterval(scheduleTimer);
    },
  };
}

module.exports = { DEFAULTS, merge, startWorker, sendEmail, sendTelegram, findChats };
