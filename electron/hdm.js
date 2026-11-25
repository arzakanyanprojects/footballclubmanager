// The ՀԴՄ (fiscal cash register) connection, set per computer.
// 'test' mode simulates the device so the flow can be tried without printing real fiscal receipts.
// 'device' mode talks to the real ՀԴՄ (Ameriabank's Newland terminal) over the network with the State
// Revenue Committee's integration protocol («ՀՍԿԻՉ-ԴՐԱՄԱՐԿՂԱՅԻՆ ՄԵՔԵՆԱՅԻ ԻՆՏԵԳՐՈՒՄԸ ԱՐՏԱՔԻՆ ԾՐԱԳՐԵՐԻ ՀԵՏ», v0.7.3):
//   TCP → 12-byte header + JSON body encrypted with 3DES-ECB/PKCS7. The login uses a key made from the
//   ՀԴՄ password (first 24 bytes of its SHA-256); the device answers with a session key for the rest.
//   Every session request carries an increasing `seq`.
// Each action here is one short session: connect → operator login → the operation → logout → close.

const net = require('net');
const crypto = require('crypto');

const DEFAULTS = {
  enabled: false,
  mode: 'test', // 'test' | 'device'
  host: '',
  port: '',
  hdmPassword: '', // «ՀԴՄ գաղտնաբառ» (integration password set on the device)
  dep: '', // «ՀԴՄ բաժին» — department of the simple receipt
  cashier: '', // «ՀԴՄ օպերատոր» — operator ID
  password: '', // «ՀԴՄ օպերատորի գաղտնաբառ» — operator PIN
  devicePos: true, // card payments go through the ՀԴՄ's own POS terminal
  // The receipt line, as on the club's existing receipts: «Ուսումնամարզական ծառայություն», Դաս. 85.51, Ն/Կ 1.7.6, 1 ամիս.
  productName: 'Ուսումնամարզական ծառայություն',
  adgCode: '85.51',
  productCode: '1.7.6',
  unit: 'ամիս',
  methods: ['card'], // payment methods that need a receipt
  // «Զեղչով վճարում»: how the discount shows on the receipt — 'percent' (Զեղչ 50%) or 'amount' (Զեղչ 15,000)
  discountFormat: 'percent',
  testCounter: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- protocol
const MAGIC = Buffer.from([0xd5, 0x80, 0xd4, 0xb4, 0xd5, 0x84]); // "ՀԴՄ" in UTF-8
const VERSION = Buffer.from([0x00, 0x05]);
const OP = { list: 1, login: 2, logout: 3, receipt: 4, lastCopy: 5, returnReceipt: 6, report: 9, sample: 13 };

const passwordKey = (pw) => crypto.createHash('sha256').update(String(pw), 'utf8').digest().subarray(0, 24);
function encrypt(key, obj) {
  const c = crypto.createCipheriv('des-ede3', key, null);
  return Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
}
function decrypt(key, buf) {
  const d = crypto.createDecipheriv('des-ede3', key, null);
  return JSON.parse(Buffer.concat([d.update(buf), d.final()]).toString('utf8'));
}

// What the device's response codes mean (§4.10), for the error shown to the user.
const CODES = {
  101: 'HDM_BAD_PASSWORD', 102: 'HDM_SESSION', 103: 'HDM_PROTOCOL', 104: 'HDM_PROTOCOL', 105: 'HDM_PROTOCOL',
  400: 'HDM_PROTOCOL', 402: 'HDM_PROTOCOL', 404: 'HDM_PROTOCOL', 403: 'HDM_IP_NOT_ALLOWED', 500: 'HDM_DEVICE_ERROR',
  111: 'HDM_BAD_OPERATOR', 112: 'HDM_BAD_OPERATOR', 113: 'HDM_BAD_OPERATOR', 121: 'HDM_BAD_OPERATOR',
  141: 'HDM_NO_LAST_RECEIPT', 176: 'HDM_NO_LAST_RECEIPT', 142: 'HDM_NO_LAST_RECEIPT',
  143: 'HDM_PRINTER', 144: 'HDM_PRINTER', 145: 'HDM_NO_PAPER',
  151: 'HDM_BAD_DEP', 153: 'HDM_LIMIT', 155: 'HDM_SYNC', 156: 'HDM_SYNC', 185: 'HDM_SYNC',
  164: 'HDM_CARD_FAILED', 190: 'HDM_CARD_FAILED',
  157: 'HDM_RETURN_FAILED', 158: 'HDM_ALREADY_RETURNED', 174: 'HDM_RETURN_FAILED', 175: 'HDM_RETURN_FAILED',
  177: 'HDM_RETURN_FAILED', 178: 'HDM_RETURN_FAILED', 180: 'HDM_RETURN_FAILED',
};
class HdmError extends Error {
  constructor(code, detail, uncertain = false) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.uncertain = uncertain; // the request went out but no answer came back: the outcome is unknown
  }
}

// One TCP connection with a queue of reads.
class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.closed = false;
    socket.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.pump();
    });
    const end = (err) => {
      this.closed = true;
      this.error = err;
      this.pump();
    };
    socket.on('close', () => end());
    socket.on('error', (err) => end(err));
  }
  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (this.buf.length >= w.n) {
        this.waiters.shift();
        clearTimeout(w.timer);
        const out = this.buf.subarray(0, w.n);
        this.buf = this.buf.subarray(w.n);
        w.resolve(out);
      } else if (this.closed) {
        this.waiters.shift();
        clearTimeout(w.timer);
        w.reject(new HdmError('HDM_NO_ANSWER', this.error?.message || 'connection closed'));
      } else break;
    }
  }
  read(n, ms) {
    return new Promise((resolve, reject) => {
      const w = { n, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new HdmError('HDM_NO_ANSWER', `no answer in ${Math.round(ms / 1000)} s`));
      }, ms);
      this.waiters.push(w);
      this.pump();
    });
  }
  write(buf) {
    return new Promise((resolve, reject) => this.socket.write(buf, (err) => (err ? reject(new HdmError('HDM_NO_ANSWER', err.message)) : resolve())));
  }
  close() {
    this.socket.destroy();
  }
}

function connect(host, port, ms = 8000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(port) });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new HdmError('HDM_UNREACHABLE', `${host}:${port}`));
    }, ms);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(new Conn(socket));
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new HdmError('HDM_UNREACHABLE', err.message));
    });
  });
}

// Sends one operation and returns the decrypted JSON answer ({} when the device sends no body).
// `waitMs` is how long the device may take (a card payment waits for the customer).
async function call(conn, op, key, body, waitMs = 30000) {
  const payload = encrypt(key, body);
  const header = Buffer.concat([MAGIC, VERSION, Buffer.from([op, 0]), Buffer.from([payload.length >> 8, payload.length & 0xff])]);
  await conn.write(Buffer.concat([header, payload]));
  // Response header: protocol version (2), software version (3), code (2), length (2), reserved (2).
  const h = await conn.read(11, waitMs);
  const code = h.readUInt16BE(5);
  const len = h.readUInt16BE(7);
  const data = len ? await conn.read(len, 10000) : Buffer.alloc(0);
  if (code !== 200) throw new HdmError(CODES[code] || 'HDM_DEVICE_ERROR', `ՀԴՄ code ${code}`);
  if (!data.length) return {};
  try {
    return decrypt(key, data);
  } catch (err) {
    throw new HdmError('HDM_SESSION', err.message);
  }
}

// Sequence numbers only need to grow; milliseconds since 2024 keep growing across sessions and restarts.
let lastSeq = 0;
const nextSeq = () => (lastSeq = Math.max(lastSeq + 1, Date.now() - 1704067200000));

function check(s) {
  if (!s.host || !s.port) throw new HdmError('HDM_NOT_CONFIGURED', 'address');
  if (!s.hdmPassword) throw new HdmError('HDM_NOT_CONFIGURED', 'password');
}

// connect → login → fn(session) → logout → close
async function session(s, fn) {
  check(s);
  if (!s.cashier || !s.password) throw new HdmError('HDM_NOT_CONFIGURED', 'operator');
  const conn = await connect(s.host, s.port);
  try {
    const login = await call(conn, OP.login, passwordKey(s.hdmPassword), { password: s.hdmPassword, cashier: Number(s.cashier), pin: String(s.password) });
    if (!login.key) throw new HdmError('HDM_SESSION', 'no session key');
    const key = Buffer.from(login.key, 'base64');
    const op = (code, body = {}, waitMs) => call(conn, code, key, { seq: nextSeq(), ...body }, waitMs);
    try {
      return await fn(op);
    } finally {
      await op(OP.logout).catch(() => {});
    }
  } finally {
    conn.close();
  }
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const asResult = (r) => ({
  test: false,
  receiptNo: String(r.rseq ?? ''),
  fiscalNo: r.fiscal != null ? String(r.fiscal) : '',
  crn: r.crn != null ? String(r.crn) : '',
  total: r.total,
  printedAt: r.time ? new Date(Number(r.time)).toISOString() : new Date().toISOString(),
});
const fail = (err) => ({ ok: false, error: err.code || 'HDM_DEVICE_ERROR', detail: err.detail || err.message, uncertain: !!err.uncertain });

// ---------------------------------------------------------------- actions

/**
 * receipt: { items: [{ label, amount, discountPct? }], total, method, student, cashier }
 * discountPct (a discounted student's payment): the line goes at the full price with the discount, so the
 * receipt shows «Զեղչ» (protocol v0.7.3: discount + discountType 1 = percent, 4 = an amount off the line;
 * the fields are left out when there is no discount). What is paid stays `amount`.
 * nextTestNo: returns the next simulated receipt number (test mode)
 * In device mode the receipt is an itemised fiscal receipt (mode 2): one line per payment (a month's fee)
 * with the configured service name and codes, quantity 1. Card payments go through the ՀԴՄ's own POS
 * terminal (the customer pays on the device).
 */
async function printReceipt(settings, receipt, nextTestNo) {
  if (!settings.enabled) return { ok: false, error: 'HDM_DISABLED' };
  if (!receipt?.items?.length || !(receipt.total > 0)) return { ok: false, error: 'AMOUNT_REQUIRED' };
  if (settings.mode !== 'device') {
    await sleep(1300); // roughly how long a real device takes to answer
    return {
      ok: true,
      result: {
        test: true,
        receiptNo: `T-${String(nextTestNo()).padStart(6, '0')}`,
        fiscalNo: String(Math.floor(10000000 + Math.random() * 89999999)),
        printedAt: new Date().toISOString(),
      },
    };
  }
  const total = round2(receipt.total);
  const card = receipt.method !== 'cash';
  // «Անկանխիկ» (card) is paid on the ՀԴՄ's own terminal; other cashless methods were paid elsewhere.
  const onDevicePos = card && receipt.method === 'card' && settings.devicePos !== false && !receipt.paidElsewhere;
  let sent = false;
  try {
    const r = await session(settings, async (op) => {
      if (!settings.dep) throw new HdmError('HDM_NOT_CONFIGURED', 'dep');
      const dep = Number(settings.dep);
      const item = (i) => ({
        dep,
        qty: 1,
        ...discounted(i, settings.discountFormat),
        productCode: String(settings.productCode || DEFAULTS.productCode).slice(0, 50),
        productName: String(settings.productName || DEFAULTS.productName).slice(0, 50),
        adgCode: String(settings.adgCode || DEFAULTS.adgCode),
        unit: String(settings.unit || DEFAULTS.unit).slice(0, 50),
      });
      const body = {
        mode: 2,
        paidAmount: card ? 0 : total,
        paidAmountCard: card ? total : 0,
        partialAmount: 0,
        prePaymentAmount: 0,
        partnerTin: null,
        useExtPOS: card && !onDevicePos,
        eMarks: [],
        items: receipt.items.filter((i) => Number(i.amount) > 0).map(item),
      };
      sent = true;
      // A card payment waits for the customer at the terminal.
      return op(OP.receipt, body, Number(process.env.FC_HDM_WAIT_MS) || (onDevicePos ? 180000 : 60000));
    });
    return { ok: true, result: asResult(r) };
  } catch (err) {
    // Sent, but the answer never came: the receipt may or may not have been printed.
    if (sent && err.code === 'HDM_NO_ANSWER') err.uncertain = true;
    return fail(err);
  }
}

// One receipt line's price and discount. amount: what is paid for it; pct: the student's discount (0 < pct < 100).
// percent: price = the full price, discount = pct (type 1) — used only when the device's own sum (rounded up to
// 0.01) gives exactly the amount paid; otherwise (and for format 'amount') the discount is the amount off (type 4).
const ceil2 = (v) => Math.ceil(Math.round(v * 1000) / 10) / 100;
function discounted(i, format) {
  const amount = round2(i.amount);
  const pct = Number(i.discountPct);
  if (!(pct > 0 && pct < 100)) return { price: amount };
  const full = round2((amount * 100) / (100 - pct));
  if (format !== 'amount' && ceil2(full - (full * pct) / 100) === amount) return { price: full, discount: pct, discountType: 1 };
  return { price: full, discount: round2(full - amount), discountType: 4 };
}

// «Ստուգել կապը»: the device's operators and departments (password only), then an operator login.
async function testConnection(settings) {
  try {
    check(settings);
    const conn = await connect(settings.host, settings.port);
    let list;
    try {
      list = await call(conn, OP.list, passwordKey(settings.hdmPassword), { password: settings.hdmPassword });
    } finally {
      conn.close();
    }
    const l = list.list || list;
    const out = {
      operators: (l.c || []).map((c) => ({ id: c.id, name: c.name, deps: c.deps || [] })),
      deps: (l.d || []).map((d) => ({ id: d.id, name: d.name, type: d.type })),
      login: null,
    };
    if (settings.cashier && settings.password) {
      try {
        await session(settings, async () => true);
        out.login = 'ok';
      } catch (err) {
        out.login = err.code || 'HDM_DEVICE_ERROR';
      }
    }
    return { ok: true, result: out };
  } catch (err) {
    return fail(err);
  }
}

// Other device actions: a receipt sample (not fiscal), a copy of the last receipt, X / Z reports,
// and a full return of a receipt (by its receipt number and the device's registration number).
async function action(settings, { kind, receiptNo, crn }) {
  if (settings.mode !== 'device') return { ok: false, error: 'HDM_NOT_CONFIGURED' };
  try {
    const r = await session(settings, async (op) => {
      if (kind === 'sample') return op(OP.sample);
      if (kind === 'lastCopy') return op(OP.lastCopy);
      if (kind === 'x' || kind === 'z') {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        return op(OP.report, { reportType: kind === 'x' ? 1 : 2, startDate: start.getTime(), endDate: Date.now() }, 60000);
      }
      if (kind === 'return') {
        if (!receiptNo || !crn) throw new HdmError('HDM_RETURN_FAILED', 'no receipt');
        return op(OP.returnReceipt, { crn: String(crn), returnTicketId: Number(receiptNo) }, 180000);
      }
      throw new HdmError('HDM_PROTOCOL', kind);
    });
    return { ok: true, result: kind === 'return' ? asResult(r) : r };
  } catch (err) {
    return fail(err);
  }
}

module.exports = {
  discounted, DEFAULTS, printReceipt, testConnection, action, _protocol: { passwordKey, encrypt, decrypt, MAGIC, VERSION } };
