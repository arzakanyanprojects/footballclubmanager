// Armenian demo data for trying the app out. Dates are relative to today so the
// dashboard, overdue fees and attendance always look current.

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (s, n) => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};
const addMonths = (period, n) => {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};

// Deterministic random numbers, so every load gives the same data.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GROUPS = [
  { name: 'U8 (2018)', coach: 'Արմեն Սարգսյան', coach_phone: '+374 91 22 33 44', assistant: 'Գոռ Հովսեփյան', assistant_phone: '+374 93 55 66 77', schedule: 'Երք, Հնգ 16:00–17:00', fee: 15000, color: '#2a78d6', year: 2018, days: [2, 4] },
  { name: 'U10 (2016)', coach: 'Դավիթ Գրիգորյան', coach_phone: '+374 94 10 20 30', assistant: 'Էդգար Սաֆարյան', assistant_phone: '+374 99 40 50 60', schedule: 'Երկ, Չրք, Ուրբ 17:00–18:30', fee: 18000, color: '#1baf7a', year: 2016, days: [1, 3, 5] },
  { name: 'U12 (2014)', coach: 'Հայկ Մկրտչյան', coach_phone: '+374 77 12 34 56', assistant: null, assistant_phone: null, schedule: 'Երկ, Չրք, Ուրբ 18:30–20:00', fee: 20000, color: '#eda100', year: 2014, days: [1, 3, 5] },
  { name: 'U15 (2011)', coach: 'Վարդան Մինասյան', coach_phone: '+374 55 98 76 54', assistant: 'Ռոման Բերեզովսկի', assistant_phone: '+374 98 11 22 33', schedule: 'Երկ–Ուրբ 19:00–20:30', fee: 22000, color: '#eb6834', year: 2011, days: [1, 2, 3, 4, 5] },
];

// [first name, last name, gender, group index]
const STUDENTS = [
  ['Դավիթ', 'Սահակյան', 'male', 0], ['Էրիկ', 'Ղազարյան', 'male', 0], ['Սամվել', 'Վարդանյան', 'male', 0],
  ['Մհեր', 'Հարությունյան', 'male', 0], ['Ալեն', 'Մելքոնյան', 'male', 0], ['Ռոբերտ', 'Ասատրյան', 'male', 0],
  ['Անի', 'Պետրոսյան', 'female', 0], ['Միքայել', 'Թադևոսյան', 'male', 0],
  ['Արամ', 'Պետրոսյան', 'male', 1], ['Նարեկ', 'Հովհաննիսյան', 'male', 1], ['Տիգրան', 'Ավետիսյան', 'male', 1],
  ['Լևոն', 'Կարապետյան', 'male', 1], ['Գոռ', 'Մարտիրոսյան', 'male', 1], ['Էդգար', 'Բաբայան', 'male', 1],
  ['Վահրամ', 'Խաչատրյան', 'male', 1], ['Մարի', 'Գևորգյան', 'female', 1], ['Արսեն', 'Զաքարյան', 'male', 1],
  ['Աշոտ', 'Մանուկյան', 'male', 2], ['Սարգիս', 'Աղաջանյան', 'male', 2], ['Հովհաննես', 'Դանիելյան', 'male', 2],
  ['Գագիկ', 'Մովսիսյան', 'male', 2], ['Ռուբեն', 'Եղիազարյան', 'male', 2], ['Կարեն', 'Ստեփանյան', 'male', 2],
  ['Արտյոմ', 'Ներսիսյան', 'male', 2], ['Սերոբ', 'Համբարձումյան', 'male', 2],
  ['Արթուր', 'Գալստյան', 'male', 3], ['Հրաչ', 'Պողոսյան', 'male', 3], ['Վահե', 'Սիմոնյան', 'male', 3],
  ['Արման', 'Աբրահամյան', 'male', 3], ['Էրիկ', 'Մուրադյան', 'male', 3], ['Նորայր', 'Բաղդասարյան', 'male', 3],
  ['Գարիկ', 'Հակոբյան', 'male', 3],
];

const MOTHERS = ['Լիլիթ', 'Անահիտ', 'Մարիամ', 'Գայանե', 'Նարինե', 'Կարինե', 'Արմինե', 'Հասմիկ', 'Սուսաննա', 'Տաթևիկ', 'Սոնա', 'Նունե', 'Ռուզաննա', 'Աննա', 'Սիրանուշ', 'Լուսինե', 'Աստղիկ', 'Զարուհի'];
const FATHERS = ['Արսեն', 'Գևորգ', 'Վարդան', 'Սուրեն', 'Արմեն', 'Հայկ', 'Տիգրան', 'Ներսես', 'Կարեն', 'Սամվել'];
const STREETS = ['Կոմիտասի', 'Բաղրամյան', 'Աբովյան', 'Մաշտոցի', 'Վ. Սարգսյանի', 'Արշակունյաց', 'Թումանյան', 'Տիգրան Մեծի', 'Բաբաջանյան', 'Հալաբյան', 'Շիրազի', 'Ծովակալ Իսակովի'];
const PREFIXES = ['91', '93', '94', '95', '96', '98', '99', '77', '55', '41'];

const PRODUCTS = [
  ['Մարզահագուստ', 12000], ['Խաղային մարզաշապիկ', 9000], ['Գնդակ (չափ 4)', 8000],
  ['Սպորտային պայուսակ', 7500], ['Սրունքապաշտպաններ', 4000], ['Բութսեր', 18000],
];

const CLUB = {
  club_name: '«Արարատ» ֆուտբոլային ակադեմիա',
  club_address: 'ք. Երևան, Տիգրան Մեծի 48',
  club_phone: '+374 10 55 12 34',
  director_name: 'Գևորգ Հակոբյան',
};

function load({ methods, one, all, run, settings, ctx }) {
  const rand = rng(20261103);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const today = iso(new Date());
  const period = today.slice(0, 7);
  const call = (m, p) => methods[m](p, ctx);

  // Remember what we change so "Remove demo data" can put it back.
  const before = settings();
  const prev = { billing_start: before.billing_start };
  const setSetting = (key, value) =>
    run('INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key, value });
  if (!before.club_name || before.club_name === 'Football Club') {
    for (const [k, v] of Object.entries(CLUB)) {
      prev[k] = before[k] || '';
      setSetting(k, v);
    }
  }
  const billingStart = addMonths(period, -5);
  setSetting('billing_start', billingStart);
  setSetting('demo_prev', JSON.stringify(prev));

  const groupIds = GROUPS.map((g) => call('groups.save', { name: g.name, coach: g.coach, coach_phone: g.coach_phone, assistant: g.assistant, assistant_phone: g.assistant_phone, color: g.color }).id);
  const productIds = PRODUCTS.map(([name, price]) => call('products.save', { name, price }).id);

  const students = STUDENTS.map(([first, last, gender, gi], i) => {
    const g = GROUPS[gi];
    // Most joined at the start of billing; a few joined later or this month.
    const join = i % 9 === 4 ? `${addMonths(period, -1)}-${pad(between(3, 20))}` : i % 11 === 7 ? `${period}-01` : `${billingStart}-${pad(between(1, 15))}`;
    let fee = g.fee;
    let notes = null;
    if (i === 6 || i === 8) {
      fee = 10000;
      notes = 'Զեղչ՝ եղբայր/քույր ակումբում';
    }
    if (i === 19) {
      fee = 0;
      notes = 'Անվճար՝ մարզչի որոշմամբ (տաղանդավոր սան)';
    }
    if (i === 26) notes = 'Ալերգիա՝ ծաղկափոշի։ Մարզումից առաջ զանգահարել ծնողին։';
    const useMother = rand() < 0.75;
    const parentFirst = useMother ? pick(MOTHERS) : pick(FATHERS);
    const phone = () => `+374 ${pick(PREFIXES)} ${between(10, 99)} ${between(10, 99)} ${between(10, 99)}`;
    const born = `${g.year}-${pad(between(1, 12))}-${pad(between(1, 28))}`;
    const id = call('students.save', {
      first_name: first,
      last_name: last,
      gender,
      birth_date: born,
      group_id: groupIds[gi],
      monthly_fee: fee,
      join_date: join,
      parent_first_name: parentFirst,
      parent_last_name: last,
      parent_doc_no: rand() < 0.6 ? `AN${between(1000000, 9999999)}` : `00${between(1000000, 9999999)}`,
      parent_doc_issuer: `0${between(10, 99)}`,
      parent_doc_date: `${between(2015, 2024)}-${pad(between(1, 12))}-${pad(between(1, 28))}`,
      parent_ssn: `${between(1000000000, 9999999999)}`,
      parent_email: rand() < 0.5 ? `${['ani', 'lilit', 'mariam', 'arsen', 'gevorg', 'karen'][between(0, 5)]}${between(10, 99)}@mail.am` : null,
      patronymic: `${useMother ? pick(FATHERS) : parentFirst}ի`,
      parent_phone: phone(),
      phone: gi === 3 ? phone() : null,
      parent_address: `ք. Երևան, ${pick(STREETS)} ${between(1, 120)}, բն. ${between(1, 90)}`,
      document_no: gi === 3 && i % 2 ? `AN${between(1000000, 9999999)}` : `ԾՎ ${between(100000, 999999)}`,
      notes,
      medical_doc: rand() < 0.75 ? 1 : 0,
      category: i === 6 || i === 8 ? 'siblings' : i === 14 ? 'war' : i === 21 ? 'staff' : i === 25 ? 'half' : null,
    }).id;
    return { id, gi, join, fee, first, last };
  });

  // Monthly fees: most are paid in the first days of the month; a few families are behind.
  const debtors = new Set([students[3].id, students[11].id, students[22].id, students[27].id]);
  const methodsList = ['easypay', 'easypay', 'easypay', 'card', 'card', 'transfer'];
  const todayDay = Number(today.slice(8));
  for (const c of all(`SELECT id, student_id, period FROM charges WHERE kind = 'monthly' AND status = 'unpaid'`)) {
    const late = debtors.has(c.student_id) && c.period >= addMonths(period, -2);
    const current = c.period === period;
    if (late || (current && (todayDay < 3 || rand() < 0.4)) || (!current && rand() < 0.015)) continue;
    const day = current ? between(1, Math.max(1, Math.min(todayDay, 9))) : between(1, 12);
    call('charges.markPaid', { ids: [c.id], method: pick(methodsList), paidAt: `${c.period}-${pad(day)}` });
  }

  // Kit purchases.
  for (let k = 0; k < 16; k++) {
    const s = pick(students);
    const pi = k < 6 ? 0 : between(0, productIds.length - 1);
    const date = addDays(today, -between(0, 120));
    const paid = rand() < 0.8;
    call('charges.create', {
      studentId: s.id,
      kind: 'product',
      productId: productIds[pi],
      quantity: pi === 4 && rand() < 0.3 ? 2 : 1,
      dueDate: date < s.join ? s.join : date,
      paid,
      method: pick(methodsList),
      paidAt: date < s.join ? s.join : date,
    });
  }

  // Other one-off payments: summer camp and a tournament fee for U12.
  for (const s of students.filter((x) => x.gi === 1).slice(0, 4)) {
    call('charges.create', {
      studentId: s.id, kind: 'other', description: 'Ամառային ճամբար (Ծաղկաձոր)', amount: 45000,
      dueDate: addDays(today, 20), paid: rand() < 0.5, method: 'transfer',
    });
  }
  for (const s of students.filter((x) => x.gi === 2)) {
    call('charges.create', {
      studentId: s.id, kind: 'other', description: 'Մրցաշարի մասնակցության վճար', amount: 5000,
      dueDate: addDays(today, 7), paid: rand() < 0.4, method: 'easypay',
    });
  }

  // Attendance for the last six weeks on each group's training days.
  for (let back = 42; back >= 0; back--) {
    const date = addDays(today, -back);
    const wd = parse(date).getDay();
    GROUPS.forEach((g, gi) => {
      if (!g.days.includes(wd)) return;
      const entries = students
        .filter((s) => s.gi === gi && s.join <= date)
        .map((s) => {
          const r = rand();
          const status = r < 0.82 ? 'present' : r < 0.88 ? 'late' : r < 0.96 ? 'absent' : 'excused';
          return { studentId: s.id, status };
        });
      if (entries.length) call('attendance.save', { date, groupId: groupIds[gi], entries });
    });
  }

  // Contracts from the club's Word template; each gets a contract number on the student's page first.
  const tpl = one('SELECT id FROM doc_templates ORDER BY id LIMIT 1')?.id;
  if (tpl) {
    students.slice(0, 18).forEach((s, k) => {
      const start = s.join;
      run('UPDATE students SET contract_no = :no WHERE id = :id', {
        id: s.id,
        no: `${start.slice(2, 4)}-${start.slice(5, 7)}-${String(k + 1).padStart(2, '0')}`,
      });
      const { id } = call('contracts.create', { studentId: s.id, docTemplateId: tpl, contractDate: start, startDate: start });
      const c = one('SELECT * FROM contracts WHERE id = :id', { id });
      if (k % 6 !== 3) call('contracts.save', { ...c, status: 'signed', signed_date: start });
    });
  }

  // One student who left the club.
  const left = students[students.length - 1];
  const full = one('SELECT * FROM students WHERE id = :id', { id: left.id });
  call('students.save', { ...full, status: 'inactive' });

  // Keep the activity log readable: one line instead of hundreds.
  run('DELETE FROM activity_log');
  run('INSERT INTO activity_log (user, action, details) VALUES (:user, :action, :details)', {
    user: ctx.user || null,
    action: 'demo.loaded',
    details: `${students.length}`,
  });
  setSetting('demo_loaded', '1');
  return { students: students.length };
}

function clear({ run, settings, ctx }) {
  for (const table of ['contracts', 'attendance', 'charges', 'students', 'groups', 'products', 'activity_log']) {
    run(`DELETE FROM ${table}`);
  }
  let prev = {};
  try {
    prev = JSON.parse(settings().demo_prev || '{}');
  } catch {}
  for (const [key, value] of Object.entries(prev)) {
    run('UPDATE settings SET value = :value WHERE key = :key', { key, value });
  }
  run(`DELETE FROM settings WHERE key IN ('demo_loaded', 'demo_prev')`);
  run('INSERT INTO activity_log (user, action) VALUES (:user, :action)', { user: ctx.user || null, action: 'demo.cleared' });
  return true;
}

module.exports = { load, clear };
