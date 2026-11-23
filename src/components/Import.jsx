import { useMemo, useState } from 'react';
import { FileUp, Upload, CheckCircle2, AlertTriangle, Wand2, Files } from 'lucide-react';
import { useT } from '../i18n';
import { rpc } from '../lib';
import { Button, Field, Modal, Segmented, useAction } from './ui';

const CATEGORY_KEYS = ['siblings', 'half', 'war', 'staff', 'orphan'];

// FC Manager fields a file column can be matched to. `alias`: header words that match automatically.
const FIELDS = [
  { id: 'full_name', label: 'import.fullName', alias: ['full name', 'name surname', 'surname name', 'անուն ազգանուն', 'ազգանուն անուն', 'անուն ազգանուն հայրանուն', 'ազգանուն անուն հայրանուն', 'սան', 'սանի անուն', 'ф и о', 'фио'] },
  { id: 'first_name', label: 'students.firstName', alias: ['first name', 'firstname', 'name', 'անուն', 'имя'] },
  { id: 'last_name', label: 'students.lastName', alias: ['last name', 'lastname', 'surname', 'ազգանուն', 'фамилия'] },
  { id: 'patronymic', label: 'students.patronymic', alias: ['patronymic', 'middle name', 'հայրանուն', 'отчество'] },
  { id: 'birth_date', label: 'students.birthDate', type: 'date', alias: ['birth date', 'birthdate', 'date of birth', 'dob', 'ծննդյան ամսաթիվ', 'ծննդյան օր', 'ծնդ օր', 'ծնդ օր ամիս տարի', 'дата рождения'] },
  { id: 'document_no', label: 'students.documentNo', alias: ['birth certificate', 'document', 'ծննդյան վկայական', 'ծնդ վկայական', 'անձնագիր', 'փաստաթուղթ'] },
  { id: 'contract_no', label: 'students.contractNo', alias: ['contract', 'contract no', 'պայմանագրի համար', 'պայմանագիր', 'договор'] },
  { id: 'medical_doc', label: 'students.medicalDoc', type: 'bool', alias: ['medical', 'բժ. թուղթ', 'բժշկական', 'բժ թուղթ', 'справка'] },
  { id: 'parent_full_name', label: 'import.parentFullName', alias: ['parent', 'parent name', 'ծնող', 'ծնողի անուն', 'родитель'] },
  { id: 'parent_first_name', label: 'import.parentFirst', alias: ['parent first name', 'ծնողի անունը'] },
  { id: 'parent_last_name', label: 'import.parentLast', alias: ['parent last name', 'ծնողի ազգանուն'] },
  { id: 'parent_phone', label: 'import.parentPhone', type: 'phone', alias: ['phone', 'parent phone', 'mobile', 'հեռախոս', 'ծնողի հեռախոս', 'телефон'] },
  { id: 'parent_messenger', label: 'import.parentMessenger', type: 'phone', alias: ['viber', 'whatsapp', 'viber whatsapp', 'վայբեր'] },
  { id: 'parent_email', label: 'import.parentEmail', alias: ['email', 'e-mail', 'էլ. փոստ', 'էլ փոստ', 'էլ հասցե', 'почта'] },
  // One cell with everything about the parent's passport: "ն/ք 010715118, տրվել է 22/11/2018, 008-ի կողմից, ՀԾՀ՝ …, հասցե՝ …"
  { id: 'parent_passport_text', label: 'import.parentPassportText', type: 'passport', alias: ['անձնագրի տվյալներ', 'ծնողի անձնագրի տվյալներ', 'passport data'] },
  { id: 'parent_ssn', label: 'import.parentSsn', alias: ['ssn', 'հծհ', 'հանրային ծառայության համարանիշ'] },
  { id: 'parent_doc_no', label: 'import.parentDocNo', alias: ['passport', 'id card', 'ծնողի անձնագիր', 'անձնագրի համար', 'паспорт'] },
  { id: 'parent_doc_issuer', label: 'import.parentDocIssuer', alias: ['issued by', 'ում կողմից'] },
  { id: 'parent_doc_date', label: 'import.parentDocDate', type: 'date', alias: ['issue date', 'տրման ամսաթիվ'] },
  { id: 'parent_address', label: 'import.parentAddress', alias: ['address', 'հասցե', 'адрес'] },
  { id: 'group_name', label: 'students.group', alias: ['group', 'team', 'խումբ', 'թիմ', 'группа'] },
  { id: 'monthly_fee', label: 'students.monthlyFee', type: 'money', alias: ['fee', 'monthly fee', 'ամսավճար', 'վճար', 'оплата'] },
  { id: 'join_date', label: 'students.joinDate', type: 'date', alias: ['join date', 'start date', 'միանալու ամսաթիվ', 'անդամակցության ամսաթիվ'] },
  { id: 'service', label: 'students.service', alias: ['service', 'ծառայություն', 'ծառայություններ'] },
  { id: 'category', label: 'students.category', type: 'category', alias: ['category', 'կարգավիճակ', 'զեղչ', 'ծանուցում'] },
  { id: 'status', label: 'students.status', type: 'status', alias: ['status', 'active', 'ակտիվություն', 'статус'] },
  { id: 'inactive_reason', label: 'students.inactiveReason', alias: ['reason', 'պատճառ'] },
  { id: 'notes', label: 'students.notes', alias: ['notes', 'note', 'comment', 'նշումներ', 'մեկնաբանություն', 'примечание'] },
];
// Fields the combined passport cell fills in (unless the file has separate columns for them).
const PASSPORT_PARTS = ['parent_doc_no', 'parent_doc_date', 'parent_doc_issuer', 'parent_ssn', 'parent_address'];

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Best file column for each field, from the header names: exact names first, then the field
// whose alias is the longest part of the header (so "Ծնողի հեռախոս" beats "հեռախոս").
function guessMapping(headers) {
  const map = {};
  const used = new Set();
  const hs = headers.map(norm);
  for (const f of FIELDS) {
    const i = hs.findIndex((h, idx) => !used.has(idx) && h && f.alias.some((a) => h === norm(a)));
    if (i >= 0) {
      map[f.id] = i;
      used.add(i);
    }
  }
  hs.forEach((h, idx) => {
    if (!h || used.has(idx)) return;
    let best = null;
    for (const f of FIELDS) {
      if (map[f.id] != null) continue;
      for (const a of f.alias.map(norm)) {
        if (a.length > 2 && h.includes(a) && (!best || a.length > best.len)) best = { id: f.id, len: a.length };
      }
    }
    if (best) {
      map[best.id] = idx;
      used.add(idx);
    }
  });
  // A full-name column makes separate first/last name columns unnecessary, and the other way round.
  if (map.first_name != null && map.last_name != null) delete map.full_name;
  return map;
}

// "20.06.2011", "20/06/2011", "15․11․2012" (Armenian full stop), "2011-06-20", Excel day numbers → 2011-06-20
function toDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[./․-](\d{1,2})[./․-](\d{2,4})\s*(թ\.?)?$/u);
  if (m) {
    const y = m[3].length === 2 ? (Number(m[3]) > 40 ? `19${m[3]}` : `20${m[3]}`) : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  // A month written in words: «5 авг 26», «5 авг. 2026», «14 Oct 2026», «3 նոյ 26»
  m = s.toLowerCase().match(/^(\d{1,2})[\s.\-]*([a-zа-яёա-և]{3,})\.?[\s.\-,]*(\d{2}|\d{4})\s*(թ\.?|г\.?)?$/u);
  if (m) {
    const month = MONTH_WORDS.findIndex((words) => words.some((w) => m[2].startsWith(w))) + 1;
    if (month) {
      const y = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${y}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
  }
  return null; // not a date we understand
}
// Month name beginnings: English, Russian, Armenian.
const MONTH_WORDS = [
  ['jan', 'янв', 'հնվ', 'հունվ'], ['feb', 'фев', 'փետ'], ['mar', 'мар', 'մար'], ['apr', 'апр', 'ապր'],
  ['may', 'май', 'мая', 'մայ'], ['jun', 'июн', 'հուն'], ['jul', 'июл', 'հուլ'], ['aug', 'авг', 'օգս'],
  ['sep', 'сен', 'սեպ'], ['oct', 'окт', 'հոկ'], ['nov', 'ноя', 'նոյ'], ['dec', 'дек', 'դեկ'],
];

// Armenian phone numbers in one format: 77167635 / 077167635 / +374 77 16 76 35 → +37477167635
export function formatPhone(v) {
  const raw = clean(v);
  const d = raw.replace(/\D/g, '');
  const local = d.length === 8 ? d : d.length === 9 && d.startsWith('0') ? d.slice(1) : d.length === 11 && d.startsWith('374') ? d.slice(3) : null;
  return local ? `+374${local}` : raw;
}

// The parent's passport cell → number, issue date, issuer, ՀԾՀ (SSN) and address.
function parsePassport(text) {
  const s = clean(text);
  const out = {};
  const doc = s.match(/(?:ն\/ք(?:\s*կամ\s*անձնագիր)?|անձնագիր)\s*[՝:]?\s*([A-ZА-Я0-9]{1,3} ?[A-ZА-Я0-9]{4,9})/u);
  if (doc) out.parent_doc_no = doc[1];
  const date = s.match(/(\d{1,2})[/.․](\d{1,2})[/.․](\d{4})/u);
  if (date) out.parent_doc_date = `${date[3]}-${date[2].padStart(2, '0')}-${date[1].padStart(2, '0')}`;
  // "008-ի կողմից", "37401 -ի կողմից"; never the year of a date ("…/2023, -ի կողմից")
  const issuer = s.match(/(?<![/.․\d])(\d{3,5})\s*,?\s*-?\s*ի\s*կողմից/u);
  if (issuer) out.parent_doc_issuer = issuer[1];
  // «ՀԾՀ՝ 6604750116», «ՀԾՀ՝6604750116», «ՀԾՀ՝, 1712870246», «ՀԾՀ: …» — any marks / spaces before the 10 digits
  const ssn = s.match(/ՀԾՀ[\s՝:`'՛,.;\-–]{0,6}(\d{8,12})(?!\d)/u);
  if (ssn) out.parent_ssn = ssn[1]; // a ՀԾՀ that isn't 10 digits is kept and flagged
  const addr = s.match(/[Հհ]ասցե\s*[՝:`'՛]?\s*(.+)$/u);
  if (addr) out.parent_address = addr[1].replace(/^[\s,:]+/, '').replace(/[\s,]+$/, '').trim();
  return out;
}

const SURNAME = /(յան|յանց|ունց|ենց|ով|ովա|ևա|եվա|ենկո|իձե|շվիլի)$/u;
// "Հակոբյան Աբել" and "Աբել Հակոբյան" both → first Աբել, last Հակոբյան (order 'auto').
function splitName(full, order) {
  const parts = clean(full).split(' ').filter(Boolean);
  const lastFirst = order === 'last-first' || (order === 'auto' && parts.length >= 2 && SURNAME.test(parts[0]) && !SURNAME.test(parts[1]));
  if (lastFirst) return { last_name: parts[0] || '', first_name: parts[1] || '', patronymic: parts.slice(2).join(' ') };
  return { first_name: parts[0] || '', last_name: parts[1] || '', patronymic: parts.slice(2).join(' ') };
}

// A fill colour ("RRGGBB") as 'green' / 'red' / '' — for columns marked by colour instead of text
// (e.g. բժ․ թուղթ: green = provided, red = not provided).
function colourOf(hex) {
  if (!/^[0-9A-F]{6}$/i.test(hex || '')) return '';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  if (g > 120 && g > r + 20 && g > b + 20) return 'green';
  if (r > 150 && r > g + 60 && r > b + 60) return 'red';
  return '';
}

// Կարգավիճակ written in words ("2-րդ երեխա", "միակողմանի ծնողազուրկ", "50%") → its key.
function categoryOf(v, t) {
  const s = norm(v);
  const exact = CATEGORY_KEYS.find((k) => norm(t(`category.${k}`)) === s || k === s);
  if (exact) return exact;
  if (/ծնողազուրկ/u.test(s)) return 'orphan';
  if (/երեխա/u.test(s) && /(^|\s)(2|3|4|երկրորդ|երրորդ|ավել)/u.test(s) && !/աշխատակց/u.test(s)) return 'siblings';
  if (/աշխատակց/u.test(s)) return 'staff';
  if (/պատերազմ|զոհ/u.test(s)) return 'war';
  if (/50/.test(s)) return 'half';
  return null;
}

// The row with the column titles: in some files they are on row 2 under a row of other titles
// (e.g. months on row 1, «Ծանուցում» only on row 1). Picks the row that matches most fields and
// fills its empty titles from the rows above.
function detectHeader(rows) {
  let best = { index: 0, cells: rows[0] || [], score: -1 };
  for (let h = 0; h < Math.min(3, rows.length - 1); h++) {
    // An empty title (or a stray number, e.g. 30000 typed under «Ամսավճար») takes the title above it.
    const cells = (rows[h] || []).map((v, i) => {
      const above = [...rows.slice(0, h)].reverse().map((r) => r[i]).find(Boolean);
      return v && !(above && /^[\d\s.,]+$/.test(v)) ? v : above || v || '';
    });
    const score = Object.keys(guessMapping(cells)).length;
    if (score > best.score) best = { index: h, cells, score };
  }
  return best;
}

// ---------------------------------------------------------------- payments from month columns
// Month titles like «Օգս․ 26», «Հնվ․ 27» (above the column titles), each with sub-columns I and II (halves).
const MONTH_ABBR = { Հնվ: 1, Փետ: 2, Մար: 3, Ապր: 4, Մայ: 5, Հուն: 6, Հուլ: 7, Օգս: 8, Սեպ: 9, Հոկ: 10, Նոյ: 11, Դեկ: 12 };
function periodOf(label) {
  const s = clean(label);
  const m = s.match(/^(Հնվ|Փետ|Մար|Ապր|Մայ|Հուն|Հուլ|Օգս|Սեպ|Հոկ|Նոյ|Դեկ)\S*\s*(\d{2}|\d{4})$/u);
  if (!m) return null;
  const y = m[2].length === 2 ? `20${m[2]}` : m[2];
  return `${y}-${String(MONTH_ABBR[m[1]]).padStart(2, '0')}`;
}
function detectMonthCols(rows, headIndex) {
  const head = rows[headIndex] || [];
  const out = [];
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (let c = 0; c < width; c++) {
    const label = [...rows.slice(0, headIndex)].reverse().map((r) => r[c]).find(Boolean) || head[c];
    const period = periodOf(label);
    if (!period) continue;
    const h = clean(head[c]).toUpperCase();
    out.push({ col: c, period, half: h === 'I' ? 'I' : h === 'II' ? 'II' : '' });
  }
  return out;
}
// The club's colours: orange = Փոխանցում, green = Անկանխիկ, yellow = EasyPay (anything else: not recognised).
function methodOfColour(hex) {
  if (!/^[0-9A-F]{6}$/i.test(hex || '')) return '';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  if (r > 200 && g > 200 && b < 130) return 'easypay';
  if (r > 200 && g >= 100 && g <= 200 && b < 100) return 'transfer';
  if (colourOf(hex) === 'green') return 'card';
  return '';
}
// Grey (any shade from light to dark, not white) = the student wasn't contracted that month.
function isGrey(hex) {
  if (!/^[0-9A-F]{6}$/i.test(hex || '')) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b) <= 16 && (r + g + b) / 3 >= 60 && (r + g + b) / 3 <= 225;
}
const fmt = (iso) => iso.split('-').reverse().join('.');
// One row's months → paid monthly fees: [{ period, paid_at, method, note }]. Grey / empty cells are skipped.
function paymentsOf(cells, fills, monthCols, t) {
  const warn = [];
  const byPeriod = new Map();
  for (const m of monthCols) {
    const v = clean(cells[m.col]);
    const method = methodOfColour(fills?.[m.col]);
    if (!v && !method) continue;
    const date = toDate(v);
    if (!date || !method) {
      warn.push(t('import.warnPayment', { month: fmt(`${m.period}-01`).slice(3), cell: v || '—' }));
      continue;
    }
    if (!byPeriod.has(m.period)) byPeriod.set(m.period, []);
    byPeriod.get(m.period).push({ ...m, date, method });
  }
  const payments = [];
  for (const [period, parts] of byPeriod) {
    const halves = parts.filter((p) => p.half);
    const sameHalfDates = new Set(parts.map((p) => p.date + p.method)).size === 1;
    const last = parts.reduce((a, b) => (b.date > a.date ? b : a));
    let note = null;
    const halvesNamed = new Set(halves.map((h) => h.half));
    const halfOnly = halves.length > 0 && halvesNamed.size === 1;
    if (halfOnly) note = t('import.halfOnly', { half: [...halvesNamed][0] });
    else if (!sameHalfDates) note = parts.map((p) => `${p.half || ''}${p.half ? '՝ ' : ''}${fmt(p.date)} (${t(`method.${p.method}`)})`).join(', ');
    payments.push({ period, paid_at: last.date, method: last.method, note, halfOnly });
  }
  // Join date: grey months = not contracted yet, so the student starts in the first month that isn't grey
  // (or the first paid one, if earlier). If the very first payment falls in that month, its date; otherwise the 1st
  // (August paid on 4 October → 01.08; September paid in advance on 5 August while August is grey → 01.09).
  const all = [...byPeriod.values()].flat();
  const open = monthCols.filter((m) => !isGrey(fills?.[m.col])).map((m) => m.period);
  const periods = [...open, ...all.map((p) => p.period)].sort();
  let start = null;
  if (periods.length) {
    const period = periods[0];
    const firstDate = all.length ? all.reduce((a, b) => (b.date < a.date ? b : a)).date : '';
    start = firstDate.slice(0, 7) === period ? firstDate : `${period}-01`;
  }
  return { payments, warn, start };
}

// A students file made with «Արտահանել տեղափոխման համար»: its hidden sheet lists the field of every column.
const MARKER = '_fcmanager';
const markerMap = (file) => {
  const m = file.sheets.find((s) => s.name === MARKER);
  if (!m) return null;
  return Object.fromEntries((m.rows[0] || []).map((k, i) => [k, i]).filter(([k]) => FIELDS.some((f) => f.id === k)));
};
const CHARGES_MARKER = '_fcmanager_charges';
const dataSheets = (file) => file.sheets.filter((s) => s.name !== MARKER && s.name !== CHARGES_MARKER && s.name !== 'Վճարումներ');
// Payments carried in a moving file, by student key (contract № or name + birth date).
const studentKey = (d) => d.contract_no || `${d.first_name}|${d.last_name}|${d.birth_date || ''}`;
function transferCharges(file) {
  const keys = file.sheets.find((s) => s.name === CHARGES_MARKER)?.rows[0];
  const sheet = file.sheets.find((s) => s.name === 'Վճարումներ');
  if (!keys || !sheet) return null;
  const out = new Map();
  for (const r of sheet.rows.slice(1)) {
    const c = Object.fromEntries(keys.map((k, i) => [k, r[i] ?? '']));
    if (!out.has(c.student_key)) out.set(c.student_key, []);
    out.get(c.student_key).push({
      kind: c.kind, period: c.period || null, description: c.description || null, amount: Number(c.amount) || 0, due_date: c.due_date || null,
      status: c.status, paid_at: c.paid_at || null, method: c.method || null, note: c.note || null,
    });
  }
  return out;
}

// One file row → student fields; problems go to `warn`.
function convertRow(row, map, opts, t, fileGroup, fills) {
  const out = {};
  const warn = [];
  const get = (id) => (map[id] != null ? clean(row[map[id]]) : '');
  for (const f of FIELDS) {
    const v = get(f.id);
    if (!v && f.type === 'bool' && map[f.id] != null && fills) {
      const c = colourOf(fills[map[f.id]]);
      if (c) out[f.id] = c === 'green' ? 1 : 0;
      else if (fills[map[f.id]]) warn.push(t('import.warnColour', { field: t(f.label) }));
      continue;
    }
    if (!v) continue;
    if (f.id === 'full_name') Object.assign(out, Object.fromEntries(Object.entries(splitName(v, opts.order)).filter(([k, x]) => x && !get(k))));
    else if (f.id === 'parent_full_name') {
      const p = splitName(v, opts.parentOrder);
      if (!get('parent_first_name')) out.parent_first_name = p.first_name;
      if (!get('parent_last_name')) out.parent_last_name = [p.last_name, p.patronymic].filter(Boolean).join(' ');
    } else if (f.type === 'passport') {
      const p = parsePassport(v);
      for (const k of PASSPORT_PARTS) if (p[k] && !get(k)) out[k] = p[k];
      if (!p.parent_doc_no) warn.push(t('import.warnPassport'));
      else if (!p.parent_ssn && !get('parent_ssn')) warn.push(t('import.warnNoSsn'));
      if (p.parent_ssn && p.parent_ssn.length !== 10) warn.push(t('import.warnSsnLength', { ssn: p.parent_ssn, n: p.parent_ssn.length }));
    } else if (f.type === 'phone') out[f.id] = formatPhone(v);
    else if (f.type === 'date') {
      const d = toDate(v);
      if (d) out[f.id] = d;
      else warn.push(`${t(f.label)}: “${v}”`);
    } else if (f.type === 'bool') out[f.id] = ['1', 'yes', 'true', 'y', 'այո', 'ներկայացված', 'ներկայացված է', 'առկա', 'կա', 'provided', 'да', '+', '✓'].includes(v.toLowerCase()) ? 1 : 0;
    else if (f.type === 'money') out[f.id] = Number(v.replace(/[^\d.,-]/g, '').replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.')) || 0;
    else if (f.type === 'status') out[f.id] = ['inactive', 'no', '0', 'false', 'ոչ ակտիվ', 'ոչակտիվ', 'դուրս եկած', 'неактивен', 'left'].includes(v.toLowerCase()) ? 'inactive' : 'active';
    else if (f.type === 'category') {
      const key = categoryOf(v, t);
      if (key) out[f.id] = key;
      else warn.push(`${t(f.label)}: “${v}”`);
    } else out[f.id] = v;
  }
  if (opts.fileGroups && fileGroup) out.group_name = fileGroup;
  if (!out.first_name || !out.last_name) warn.push(t('import.noName'));
  // A birth year that doesn't match the group's year ("2013" in group "2012-1") is worth a look.
  const gYear = String(out.group_name || '').match(/(19|20)\d{2}/)?.[0];
  if (gYear && out.birth_date && !out.birth_date.startsWith(gYear)) warn.push(t('import.warnYear', { year: out.birth_date.slice(0, 4), group: out.group_name }));
  return { data: out, warn };
}

const baseName = (n) => String(n || '').replace(/\.[^.]+$/, '').trim();

export function ImportModal({ onClose }) {
  const t = useT();
  const act = useAction();
  const [files, setFiles] = useState(null); // [{ fileName, sheets }]
  const [sheet, setSheet] = useState(0);
  const [header, setHeader] = useState(true);
  const [map, setMap] = useState({});
  const [opts, setOpts] = useState({ order: 'auto', parentOrder: 'auto', mode: 'skip', createGroups: true, fileGroups: false, payments: true });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState(null); // a full transfer zip from another FC Manager

  // Rows of every chosen file (same layout), each remembering its file for the group.
  const sources = (files || []).map((f) => {
    const sh = dataSheets(f)[files.length > 1 ? 0 : sheet] || { rows: [] };
    return { group: baseName(f.fileName), rows: sh.rows || [], fills: sh.fills || null };
  });
  const first = sources[0]?.rows || [];
  const head = useMemo(() => detectHeader(first), [files, sheet]);
  const width = first.reduce((w, r) => Math.max(w, r.length), 0);
  const headers = header ? head.cells.map((h, i) => h || `${t('import.column')} ${i + 1}`) : Array.from({ length: width }, (_, i) => `${t('import.column')} ${i + 1}`);
  const skip = header ? head.index + 1 : 0;
  const monthCols = useMemo(() => (header ? detectMonthCols(first, head.index) : []), [files, sheet, header]);
  const carried = useMemo(() => (files ? transferCharges(files[0]) : null), [files]);
  const body = useMemo(
    () => sources.flatMap((s) => s.rows.slice(skip).map((cells, i) => ({ cells, fills: s.fills?.[i + skip] || null, group: s.group, line: i + skip + 1 }))),
    [files, sheet, header, skip]
  );

  const pick = async () => {
    const r = await act(async () => {
      const res = await window.fc.importRead();
      if (!res.ok) throw Object.assign(new Error(res.error), { code: res.error, detail: res.detail });
      return res.result;
    });
    if (!r) return;
    if (r.transfer) {
      setTransfer({ ...r.transfer, fileName: r.fileName });
      setFiles(null);
      setResult(null);
      return;
    }
    setTransfer(null);
    const list = (r.files || [r]).filter((f) => f.sheets.length);
    if (!list.length) return act(() => Promise.reject(Object.assign(new Error(), { code: 'IMPORT_EMPTY' })));
    // A file from «Արտահանել տեղափոխման համար» carries its own column list; others are matched by their titles.
    const marked = markerMap(list[0]);
    const m = marked || guessMapping(detectHeader(dataSheets(list[0])[0]?.rows || []).cells);
    setFiles(list);
    setSheet(0);
    setResult(null);
    setMap(m);
    // Several files, or no group column: each file's name is its group ("2012-1.xlsx" → 2012-1).
    setOpts((o) => ({ ...o, fileGroups: list.length > 1 || m.group_name == null }));
  };

  const converted = useMemo(() => {
    const list = body.map((r) => {
      const c = { ...convertRow(r.cells, map, opts, t, r.group, r.fills), group: r.group, line: r.line };
      if (opts.payments && monthCols.length) {
        const p = paymentsOf(r.cells, r.fills, monthCols, t);
        // Amounts from the student's monthly fee (half of it when only one half was paid); 0 when there is no fee.
        const fee = Number(c.data.monthly_fee) || 0;
        c.data.payments = p.payments.map(({ halfOnly, ...x }) => ({ ...x, amount: halfOnly ? Math.round(fee / 2) : fee }));
        if (!c.data.join_date && p.start) c.data.join_date = p.start;
        c.warn.push(...p.warn);
      }
      if (opts.payments && carried) c.data.charges = carried.get(studentKey(c.data)) || [];
      return c;
    });
    // The same parent on several rows (siblings, or a copy-paste mistake) — shown, not changed.
    const byParent = new Map();
    list.forEach((c, i) => {
      const key = c.data.parent_ssn || c.data.parent_doc_no;
      if (!key) return;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(i);
    });
    for (const idx of byParent.values())
      if (idx.length > 1)
        for (const i of idx)
          list[i].warn.push(t('import.warnSameParent', { names: idx.filter((j) => j !== i).map((j) => `${list[j].data.first_name} ${list[j].data.last_name}`).join(', ') }));
    return list;
  }, [body, map, opts, t]);
  const valid = converted.filter((c) => c.data.first_name && c.data.last_name);
  const withWarnings = converted.filter((c) => c.warn.length);
  const mappedCount = Object.values(map).filter((v) => v != null).length;
  const groups = [...new Set(converted.map((c) => c.data.group_name).filter(Boolean))];
  const paymentCount = converted.reduce((n, c) => n + (c.data.payments?.length || 0) + (c.data.charges?.length || 0), 0);

  const run = async () => {
    setBusy(true);
    // Safety copy first (on the main computer; elsewhere the main computer's daily backup covers it).
    await window.fc.backup?.create?.().catch?.(() => {});
    const r = await act(() => rpc('students.import', { rows: valid.map((c) => c.data), mode: opts.mode, createGroups: opts.createGroups }));
    setBusy(false);
    if (r) setResult(r);
  };

  const runTransfer = async (mode) => {
    setBusy(true);
    await window.fc.backup?.create?.().catch?.(() => {});
    const r = await act(() => rpc('students.importFull', { data: transfer, mode }));
    setBusy(false);
    if (r) setResult(r);
  };
  if (transfer && !result) return <TransferImport data={transfer} busy={busy} onRun={runTransfer} onPick={pick} onClose={onClose} />;

  if (result)
    return (
      <Modal
        title={t('import.title')}
        onClose={onClose}
        width={520}
        footer={
          <Button variant="primary" onClick={onClose}>
            {t('hdm.done')}
          </Button>
        }
      >
        <div className="stack">
          <div className="row strong" style={{ color: 'var(--good)' }}>
            <CheckCircle2 size={18} /> {t('import.finished')}
          </div>
          <div className="import-stats">
            <div><b>{result.created}</b>{t('import.created')}</div>
            <div><b>{result.updated}</b>{t('import.updated')}</div>
            <div><b>{result.skipped}</b>{t('import.skipped')}</div>
            <div><b>{result.groupsCreated}</b>{t('import.groupsCreated')}</div>
          </div>
          {result.payments > 0 && <div className="small strong">{t('import.paymentsDone', { n: result.payments })}</div>}
          {result.attendance != null && (
            <div className="small">
              {t('transfer.doneExtra', { attendance: result.attendance, files: result.files, contracts: result.contracts, absences: result.absences })}
            </div>
          )}
          {(result.errors || []).length > 0 && (
            <div className="small" style={{ color: 'var(--bad)' }}>
              {result.errors.slice(0, 10).map((e) => (
                <div key={e.row}>
                  {t('import.row', { n: e.row })}: {t(`error.${e.error}`)}
                </div>
              ))}
            </div>
          )}
          <div className="small muted">{t(result.attendance != null ? 'transfer.afterHint' : 'import.afterHint')}</div>
        </div>
      </Modal>
    );

  return (
    <Modal
      title={t('import.title')}
      onClose={onClose}
      width={files ? 1100 : 560}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          {files && (
            <Button variant="primary" icon={Upload} onClick={run} disabled={busy || !valid.length}>
              {t('import.run', { n: valid.length })}
            </Button>
          )}
        </>
      }
    >
      {!files ? (
        <div className="stack" style={{ alignItems: 'flex-start' }}>
          <div className="small muted">{t('import.intro')}</div>
          <div className="small muted">{t('import.introMany')}</div>
          <Button variant="primary" icon={FileUp} onClick={pick}>
            {t('import.pick')}
          </Button>
        </div>
      ) : (
        <div className="stack">
          <div className="row wrap" style={{ gap: 14 }}>
            {files.length > 1 ? (
              <span className="row strong" style={{ gap: 6 }} title={files.map((f) => f.fileName).join('\n')}>
                <Files size={16} /> {t('import.filesChosen', { n: files.length })}
              </span>
            ) : (
              <span className="strong">{files[0].fileName}</span>
            )}
            {files.length === 1 && dataSheets(files[0]).length > 1 && (
              <select
                className="select"
                style={{ width: 'auto' }}
                value={sheet}
                onChange={(e) => {
                  setSheet(Number(e.target.value));
                  setMap(guessMapping(detectHeader(dataSheets(files[0])[Number(e.target.value)].rows).cells));
                }}
              >
                {dataSheets(files[0]).map((s, i) => (
                  <option key={i} value={i}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
            <label className="check small">
              <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
              {t('import.hasHeader')}
            </label>
            <span className="small muted">{t('import.rowsFound', { n: body.length })}</span>
            <div className="grow" />
            <Button size="sm" onClick={pick}>
              {t('import.otherFile')}
            </Button>
          </div>

          <div className="import-grid">
            <div>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="strong grow">{t('import.mapping')}</span>
                <Button size="sm" variant="ghost" icon={Wand2} onClick={() => setMap(guessMapping(header ? head.cells : []))}>
                  {t('import.autoMatch')}
                </Button>
              </div>
              <div className="small muted" style={{ marginBottom: 8 }}>{t('import.mappingHint', { n: mappedCount })}</div>
              <div className="import-map">
                {FIELDS.map((f) => {
                  const col = map[f.id];
                  const sample = col != null ? body.find((r) => r.cells[col])?.cells[col] : '';
                  return (
                    <div key={f.id} className={`import-map-row ${col != null ? 'on' : ''}`}>
                      <span className="import-field">{t(f.label)}</span>
                      <select
                        className="select"
                        value={col ?? ''}
                        onChange={(e) => setMap({ ...map, [f.id]: e.target.value === '' ? null : Number(e.target.value) })}
                      >
                        <option value="">— {t('import.skip')} —</option>
                        {headers.map((h, i) => (
                          <option key={i} value={i}>
                            {h}
                          </option>
                        ))}
                      </select>
                      <span className="small muted import-sample" title={sample}>{sample || ''}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="stack" style={{ gap: 14 }}>
              <label className="check small">
                <input type="checkbox" checked={opts.fileGroups} onChange={(e) => setOpts({ ...opts, fileGroups: e.target.checked })} />
                <span>
                  <span className="strong">{t('import.fileGroups')}</span>
                  <div className="muted">{groups.length ? groups.join(', ') : t('import.fileGroupsHint')}</div>
                </span>
              </label>
              {[
                ['order', 'import.nameOrder'],
                ['parentOrder', 'import.parentOrder'],
              ].map(([k, label]) => (
                <Field key={k} label={t(label)}>
                  <Segmented
                    value={opts[k]}
                    onChange={(v) => setOpts({ ...opts, [k]: v })}
                    options={[
                      { value: 'auto', label: t('import.orderAuto') },
                      { value: 'first-last', label: t('import.firstLast') },
                      { value: 'last-first', label: t('import.lastFirst') },
                    ]}
                  />
                </Field>
              ))}
              <Field label={t('import.existing')} hint={t('import.existingHint')}>
                <Segmented
                  value={opts.mode}
                  onChange={(mode) => setOpts({ ...opts, mode })}
                  options={[
                    { value: 'skip', label: t('import.modeSkip') },
                    { value: 'update', label: t('import.modeUpdate') },
                  ]}
                />
              </Field>
              <label className="check small">
                <input type="checkbox" checked={opts.createGroups} onChange={(e) => setOpts({ ...opts, createGroups: e.target.checked })} />
                {t('import.createGroups')}
              </label>
              {(monthCols.length > 0 || carried) && (
                <label className="check small">
                  <input type="checkbox" checked={opts.payments} onChange={(e) => setOpts({ ...opts, payments: e.target.checked })} />
                  <span>
                    <span className="strong">{t(carried ? 'import.paymentsCarried' : 'import.paymentsFromMonths')}</span>
                    <div className="muted">{opts.payments ? t(carried ? 'import.paymentsCarriedHint' : 'import.paymentsHint', { n: paymentCount }) : ''}</div>
                  </span>
                </label>
              )}
              <div className="small">
                <div className="strong">{t('import.ready', { n: valid.length, total: body.length })}</div>
                {withWarnings.length > 0 && (
                  <div className="row" style={{ color: 'var(--warn)', marginTop: 6, gap: 6 }}>
                    <AlertTriangle size={14} /> {t('import.warnRows', { n: withWarnings.length })}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div>
            <div className="strong small" style={{ marginBottom: 6 }}>{t('import.review')}</div>
            <div className="table-wrap" style={{ maxHeight: 330 }}>
              <table className="table import-review">
                <thead>
                  <tr>
                    {['import.row', 'students.group', 'students.name', 'students.birthDate', 'students.documentNo', 'import.parentFullName', 'import.parentPhone', 'import.parentMessenger', 'import.parentDocNo', 'import.parentSsn', 'students.contractNo', 'students.medicalDoc', 'students.category', 'students.joinDate', 'students.monthlyFee', 'nav.payments'].map((k) => (
                      <th key={k}>{t(k, { n: '' }).trim()}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {converted.map((c, i) => {
                    const d = c.data;
                    return (
                      <tr key={i} className={c.warn.length ? 'warn' : ''} title={c.warn.join('\n')}>
                        <td className="muted nowrap">
                          {c.warn.length > 0 && <AlertTriangle size={13} style={{ color: 'var(--warn)', marginRight: 4, verticalAlign: '-2px' }} />}
                          {files.length > 1 ? `${c.group} · ${c.line}` : c.line}
                        </td>
                        <td className="nowrap">{d.group_name || ''}</td>
                        <td className="nowrap">
                          {d.first_name || <span className="bad-text">?</span>} {d.last_name || <span className="bad-text">?</span>} {d.patronymic || ''}
                        </td>
                        <td className="nowrap">{d.birth_date || ''}</td>
                        <td className="nowrap">{d.document_no || ''}</td>
                        <td className="nowrap">{[d.parent_first_name, d.parent_last_name].filter(Boolean).join(' ')}</td>
                        <td className="nowrap">{d.parent_phone || ''}</td>
                        <td className="nowrap">{d.parent_messenger || ''}</td>
                        <td className="nowrap" title={[d.parent_doc_date, d.parent_doc_issuer, d.parent_address].filter(Boolean).join(' · ')}>
                          {d.parent_doc_no || ''}
                        </td>
                        <td className="nowrap">{d.parent_ssn || <span className="muted">—</span>}</td>
                        <td className="nowrap">{d.contract_no || ''}</td>
                        <td className="nowrap">
                          {d.medical_doc === 1 ? (
                            <span style={{ color: 'var(--good)' }}>{t('medicalDoc.provided')}</span>
                          ) : (
                            <span style={{ color: 'var(--warn)' }}>{t('medicalDoc.missing')}</span>
                          )}
                        </td>
                        <td className="nowrap">{d.category ? t(`category.${d.category}`) : ''}</td>
                        <td className="nowrap">{d.join_date ? fmt(d.join_date) : <span className="muted">{t('import.joinToday')}</span>}</td>
                        <td className="nowrap num">{d.monthly_fee ? Number(d.monthly_fee).toLocaleString('en-US') : ''}</td>
                        <td
                          className="nowrap"
                          title={(d.payments || []).map((p) => `${fmt(`${p.period}-01`).slice(3)} · ${fmt(p.paid_at)} · ${t(`method.${p.method}`)} · ${Number(p.amount || 0).toLocaleString('en-US')}${p.note ? ` · ${p.note}` : ''}`).join('\n')}
                        >
                          {(d.payments?.length || 0) + (d.charges?.length || 0) || ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {withWarnings.length > 0 && (
              <ul className="import-warn small" style={{ color: 'var(--warn)' }}>
                {withWarnings.slice(0, 12).map((c, i) => (
                  <li key={i}>
                    <b>
                      {files.length > 1 ? `${c.group} · ` : ''}
                      {t('import.row', { n: c.line })} ({c.data.first_name} {c.data.last_name})
                    </b>
                    : {c.warn.join('; ')}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// A transfer zip from «Արտահանել տեղափոխման համար»: what it holds, and bringing it all in.
function TransferImport({ data, busy, onRun, onPick, onClose }) {
  const t = useT();
  const [mode, setMode] = useState('skip');
  const st = data.students || [];
  const count = (k) => st.reduce((n, s) => n + (s[k]?.length || 0), 0);
  const groups = [...new Set(st.map((s) => s.group).filter(Boolean))];
  return (
    <Modal
      title={t('import.title')}
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button onClick={onPick}>{t('import.otherFile')}</Button>
          <div className="spacer" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={Upload} onClick={() => onRun(mode)} disabled={busy || !st.length}>
            {t('import.run', { n: st.length })}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          {data.fileName} · {t('transfer.exportedAt', { at: new Date(data.exportedAt).toLocaleString('en-GB') })}
        </div>
        <div className="import-stats">
          <div><b>{st.length}</b>{t('transfer.statStudents')}</div>
          <div><b>{count('charges')}</b>{t('transfer.statPayments')}</div>
          <div><b>{count('attendance')}</b>{t('transfer.statAttendance')}</div>
          <div><b>{count('files')}</b>{t('transfer.statFiles')}</div>
          <div><b>{count('contracts')}</b>{t('transfer.statContracts')}</div>
          <div><b>{count('absences')}</b>{t('transfer.statAbsences')}</div>
        </div>
        {groups.length > 0 && (
          <div className="small">
            <span className="strong">{t('nav.groups')}:</span> {groups.join(', ')}
          </div>
        )}
        <div className="field">
          <label>{t('transfer.existing')}</label>
          <label className="check">
            <input type="radio" checked={mode === 'skip'} onChange={() => setMode('skip')} /> {t('transfer.modeSkip')}
          </label>
          <label className="check">
            <input type="radio" checked={mode === 'update'} onChange={() => setMode('update')} /> {t('transfer.modeUpdate')}
          </label>
        </div>
        <div className="table-wrap" style={{ maxHeight: 260 }}>
          <table className="table">
            <tbody>
              {st.map((s, i) => (
                <tr key={i}>
                  <td className="nowrap">{[s.student.first_name, s.student.last_name, s.student.patronymic].filter(Boolean).join(' ')}</td>
                  <td className="nowrap muted">{s.group || '—'}</td>
                  <td className="nowrap small muted">
                    {t('transfer.rowCounts', { p: s.charges?.length || 0, a: s.attendance?.length || 0, f: s.files?.length || 0, c: s.contracts?.length || 0 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="small muted">{t('transfer.importHint')}</div>
      </div>
    </Modal>
  );
}
