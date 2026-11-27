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

async function sendEmail(cfg, { to, subject, text, attachments }) {
  if (!cfg.email.enabled || !cfg.email.host) throw new Error('Email is not set up');
  const from = cfg.email.fromName ? `"${cfg.email.fromName.replace(/"/g, '')}" <${cfg.email.user}>` : cfg.email.user;
  await mailer(cfg).sendMail({ from, to, subject: subject || '', text, ...(attachments?.length ? { attachments } : {}) });
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
 * getAttachment(message): the file an email carries (a report an automation sends) → { filename, content }.
 */
function startWorker({ getConfig, saveState, getService, getAttachment }) {
  let busy = false;

  async function sendPending() {
    const service = getService();
    if (!service || busy) return;
    busy = true;
    try {
      const cfg = getConfig();
      for (const m of service.outbox.pending()) {
        try {
          if (m.channel === 'email') {
            // A report is made now, so it has the data as of sending.
            const attachments = m.attachment && getAttachment ? [await getAttachment(m)] : [];
            await sendEmail(cfg, { to: m.recipient, subject: m.subject, text: m.body, attachments });
          }
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
    try {
      // The scheduled automations (summaries, reminders… are rules now — Settings → Ավտոմատացումներ).
      service.automations.tick(new Date());
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
