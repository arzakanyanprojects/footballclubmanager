// The two workbook reports of «Հաշվետվություններ» (several sheets in one Excel file): «Վիճակագրություն» (the whole
// club month by month) and «Անհատականների հաշվետվություն». Pure: data from the service (stats.sheet / individual.sheet)
// and t → the sheets for window.fc.saveXlsx({ kind: 'workbook', sheets }) (electron/xlsx.js → buildWorkbook).

const monthName = (t, period) => `${t(`month.${Number(period.slice(5))}`)} ${period.slice(0, 4)}`;
const shortMonth = (t, period) => `${t(`month.${Number(period.slice(5))}`).slice(0, 3)} ${period.slice(2, 4)}`;
const share = (a, b) => (Number(b) ? Number(a || 0) / Number(b) : null);
const sum = (list, key) => list.reduce((n, x) => n + (Number(x[key]) || 0), 0);
// The lessons in a package: the number at the end of its service («Ֆուտբոլ անհ. 8» → 8).
const lessonsIn = (service) => Number(/(\d+)\s*$/.exec(service || '')?.[1]) || 0;
const pad = (n) => String(n).padStart(2, '0');
const daysIn = (period) => new Date(Number(period.slice(0, 4)), Number(period.slice(5)), 0).getDate();

// ------------------------------------------------------------------ «Վիճակագրություն»
export function statsSheets(data, t, { title, subtitle }) {
  const months = data.months || [];
  // agg: how a row's total is counted — 'sum' (default), 'last' (a count at the month's end), or a share of two figures.
  const row = (label, key, type = 'number', agg = 'sum') => ({
    label,
    type,
    values: months.map((m) => m[key]),
    total: agg === 'last' ? months[months.length - 1]?.[key] : sum(months, key),
  });
  const pctRow = (label, num, den) => ({
    label,
    type: 'percent',
    values: months.map((m) => share(typeof num === 'function' ? num(m) : m[num], typeof den === 'function' ? den(m) : m[den])),
    total: share(
      months.reduce((n, m) => n + Number(typeof num === 'function' ? num(m) : m[num] || 0), 0),
      months.reduce((n, m) => n + Number(typeof den === 'function' ? den(m) : m[den] || 0), 0)
    ),
  });
  const summary = {
    type: 'matrix',
    sheetName: t('stats.summary'),
    title,
    subtitle,
    labelHeader: '',
    totalHeader: t('stats.total'),
    columns: months.map((m) => shortMonth(t, m.period)),
    rows: [
      { section: t('stats.secStudents') },
      row(t('stats.active'), 'active', 'number', 'last'),
      row(t('stats.joined'), 'joined'),
      row(t('stats.left'), 'left'),
      { section: t('stats.secMoney') },
      row(t('stats.billed'), 'billed', 'money'),
      row(t('stats.feesPaid'), 'fees_paid', 'money'),
      row(t('stats.feesUnpaid'), 'fees_unpaid', 'money'),
      pctRow(t('stats.collectedPct'), 'fees_paid', 'billed'),
      row(t('stats.waived'), 'waived'),
      row(t('stats.collected'), 'collected', 'money'),
      row(`  ${t('method.card')}`, 'card', 'money'),
      row(`  ${t('method.easypay')}`, 'easypay', 'money'),
      row(`  ${t('method.transfer')}`, 'transfer', 'money'),
      row(t('stats.products'), 'products', 'money'),
      row(t('stats.payments'), 'payments'),
      row(t('stats.hdmCount'), 'hdm_count'),
      row(t('stats.hdmAmount'), 'hdm_amount', 'money'),
      { section: t('stats.secAttendance') },
      row(t('stats.present'), 'present'),
      row(t('stats.absent'), 'absent'),
      row(t('stats.excused'), 'excused'),
      pctRow(t('stats.attendancePct'), 'present', 'marked'),
      { section: t('stats.secIndividual') },
      row(t('stats.indActive'), 'ind_active', 'number', 'last'),
      row(t('stats.joined'), 'ind_joined'),
      row(t('stats.indPackages'), 'ind_packages'),
      row(t('stats.indBilled'), 'ind_billed', 'money'),
      row(t('stats.indPaid'), 'ind_paid', 'money'),
      row(t('stats.indBought'), 'ind_bought'),
      row(t('stats.indLessons'), 'ind_lessons'),
      row(t('stats.indUnused'), 'ind_unused'),
    ],
  };
  const table = (sheetName, columns, rows) => ({ type: 'table', sheetName, title: `${title} — ${sheetName}`, subtitle, columns, rows, totalLabel: t('stats.total') });
  return [
    summary,
    table(
      t('stats.byGroup'),
      [
        { key: 'name', header: t('students.group'), width: 22 },
        { key: 'coach', header: t('individual.coach'), width: 22 },
        { key: 'active', header: t('stats.activeNow'), type: 'number', width: 11, sum: true },
        { key: 'joined', header: t('stats.joined'), type: 'number', width: 11, sum: true },
        { key: 'left_count', header: t('stats.left'), type: 'number', width: 11, sum: true },
        { key: 'billed', header: t('stats.billed'), type: 'money', width: 15, sum: true },
        { key: 'paid', header: t('stats.feesPaid'), type: 'money', width: 15, sum: true },
        { key: 'unpaid', header: t('stats.feesUnpaid'), type: 'money', width: 15, sum: true },
        { key: 'collected', header: t('stats.collected'), type: 'money', width: 15, sum: true },
        { key: 'att', header: t('stats.attendancePct'), type: 'percent', width: 12 },
      ],
      (data.groups || []).map((g) => ({ ...g, att: share(g.present, g.marked) }))
    ),
    table(
      t('stats.byYear'),
      [
        { key: 'year', header: t('stats.year'), width: 14 },
        { key: 'active', header: t('stats.activeNow'), type: 'number', width: 12, sum: true },
        { key: 'fees', header: t('stats.fees'), type: 'money', width: 16, sum: true },
      ],
      (data.years || []).map((y) => ({ ...y, year: y.year || '—' }))
    ),
    table(
      t('stats.byCategory'),
      [
        { key: 'label', header: t('students.category'), width: 30 },
        { key: 'active', header: t('stats.activeNow'), type: 'number', width: 12, sum: true },
        { key: 'fees', header: t('stats.fees'), type: 'money', width: 16, sum: true },
      ],
      (data.categories || []).map((c) => ({ ...c, label: t(`category.${c.category || 'none'}`) }))
    ),
    table(
      t('stats.byService'),
      [
        { key: 'service', header: t('individual.service'), width: 26 },
        { key: 'active', header: t('stats.activeNow'), type: 'number', width: 12, sum: true },
        { key: 'individual', header: t('nav.individual'), type: 'number', width: 12, sum: true },
        { key: 'collected', header: t('stats.collected'), type: 'money', width: 16, sum: true },
      ],
      (data.services || []).map((s) => ({ ...s, service: s.service || '—' }))
    ),
    table(
      t('stats.byCoach'),
      [
        { key: 'coach', header: t('individual.coach'), width: 24 },
        { key: 'groups', header: t('stats.groups'), type: 'number', width: 10, sum: true },
        { key: 'active', header: t('stats.activeNow'), type: 'number', width: 12, sum: true },
        { key: 'att', header: t('stats.attendancePct'), type: 'percent', width: 12 },
        { key: 'ind_active', header: t('stats.indActive'), type: 'number', width: 14, sum: true },
        { key: 'ind_lessons', header: t('stats.indLessons'), type: 'number', width: 14, sum: true },
        { key: 'ind_paid', header: t('stats.indPaid'), type: 'money', width: 16, sum: true },
      ],
      (data.coaches || []).map((c) => ({ ...c, att: share(c.present, c.marked) }))
    ),
  ];
}

// ------------------------------------------------------------------ «Անհատականների հաշվետվություն»
export function individualSheets(data, t, { title, subtitle }) {
  const months = data.months || [];
  const seeMoney = months.some((m) => m.rows.some((r) => r.package && r.package.amount != null));
  const name = (r) => `${r.first_name} ${r.last_name}`;
  const sheets = [];
  // One row per student and month: what was bought, given and paid.
  const lines = [];
  for (const m of months) {
    for (const r of m.rows) {
      const bought = r.package ? lessonsIn(r.package.description || r.service) : 0;
      const given = r.lessons.length;
      const amount = Number(r.package?.amount) || 0;
      lines.push({
        period: m.period, month: monthName(t, m.period), id: r.id, student: name(r), coach: r.coach || '', service: r.package?.description || r.service || '',
        packages: r.package ? 1 : 0, bought, given, unused: Math.max(bought - given, 0), billed: amount,
        paid: r.package?.status === 'paid' ? amount : 0, unpaid: r.package?.status === 'unpaid' ? amount : 0,
      });
    }
  }
  const table = (sheetName, columns, rows) => ({ type: 'table', sheetName, title: `${title} — ${sheetName}`, subtitle, columns, rows, totalLabel: t('stats.total') });
  const money = (cols) => (seeMoney ? cols : cols.filter((c) => c.type !== 'money'));
  const groupBy = (key, extra) => {
    const map = new Map();
    for (const l of lines) {
      const k = key(l);
      const g = map.get(k) || { ...extra(l), students: new Set(), packages: 0, bought: 0, given: 0, unused: 0, billed: 0, paid: 0, unpaid: 0 };
      g.students.add(l.id);
      for (const f of ['packages', 'bought', 'given', 'unused', 'billed', 'paid', 'unpaid']) g[f] += l[f];
      map.set(k, g);
    }
    return [...map.values()].map((g) => ({ ...g, students: g.students.size }));
  };
  const figures = [
    { key: 'packages', header: t('stats.indPackages'), type: 'number', width: 11, sum: true },
    { key: 'bought', header: t('stats.indBought'), type: 'number', width: 12, sum: true },
    { key: 'given', header: t('stats.indLessons'), type: 'number', width: 12, sum: true },
    { key: 'unused', header: t('stats.indUnused'), type: 'number', width: 12, sum: true },
    { key: 'billed', header: t('stats.indBilled'), type: 'money', width: 15, sum: true },
    { key: 'paid', header: t('stats.indPaid'), type: 'money', width: 15, sum: true },
    { key: 'unpaid', header: t('stats.feesUnpaid'), type: 'money', width: 15, sum: true },
  ];
  // The month sheets, as the club keeps them in Excel.
  for (const m of months) {
    const otherDays = [...new Set(m.rows.flatMap((r) => r.lessons.map((l) => l.date)).filter((d) => d.slice(0, 7) !== m.period))].sort();
    const days = Array.from({ length: daysIn(m.period) }, (_, i) => `${m.period}-${pad(i + 1)}`);
    const dayCols = [...otherDays.filter((d) => d < `${m.period}-01`), ...days, ...otherDays.filter((d) => d > `${m.period}-31`)].map((d) => ({
      key: d,
      header: d.slice(0, 7) === m.period ? String(Number(d.slice(8))) : `${d.slice(8, 10)}.${d.slice(5, 7)}`,
    }));
    sheets.push({
      type: 'lessonGrid',
      sheetName: monthName(t, m.period),
      title: `${t('individual.title')} — ${monthName(t, m.period)}`,
      subtitle,
      columns: money([
        { key: 'no', header: t('individual.no'), type: 'index', width: 5 },
        { key: 'name', header: t('individual.name'), width: 26 },
        { key: 'birth_year', header: t('individual.birthYear'), type: 'number', width: 8 },
        { key: 'total', header: t('individual.lessons'), type: 'number', width: 8 },
        { key: 'used', header: t('individual.used'), type: 'number', width: 12 },
        { key: 'amount', header: t('individual.amount'), type: 'money', width: 12 },
        { key: 'contact', header: t('individual.contact'), width: 24 },
        { key: 'coach', header: t('individual.coach'), width: 22 },
      ]),
      days: dayCols,
      rows: m.rows.map((r) => ({
        name: name(r),
        birth_year: r.birth_year || '',
        total: r.package ? lessonsIn(r.package.description || r.service) : lessonsIn(r.service),
        used: r.lessons.length,
        amount: r.package?.amount ?? '',
        paid: r.package?.status === 'paid',
        contact: [r.parent_phone, r.parent_first_name].filter(Boolean).join(' '),
        coach: r.coach || '',
        lessons: Object.fromEntries(r.lessons.map((l, i) => [l.date, i + 1])),
      })),
    });
  }
  sheets.push(
    table(
      t('stats.byCoach'),
      money([{ key: 'coach', header: t('individual.coach'), width: 24 }, { key: 'students', header: t('stats.students'), type: 'number', width: 10, sum: true }, ...figures]),
      groupBy((l) => l.coach || '—', (l) => ({ coach: l.coach || '—' })).sort((a, b) => a.coach.localeCompare(b.coach, 'hy'))
    ),
    table(
      t('stats.byStudent'),
      money([
        { key: 'no', header: t('individual.no'), type: 'index', width: 5 },
        { key: 'student', header: t('individual.name'), width: 26 },
        { key: 'coach', header: t('individual.coach'), width: 22 },
        { key: 'service', header: t('individual.service'), width: 18 },
        ...figures,
      ]),
      groupBy((l) => l.id, (l) => ({ student: l.student, coach: l.coach, service: l.service }))
    ),
    table(
      t('stats.unused'),
      money([
        { key: 'month', header: t('reportsx.month'), width: 16 },
        { key: 'student', header: t('individual.name'), width: 26 },
        { key: 'coach', header: t('individual.coach'), width: 22 },
        { key: 'service', header: t('individual.service'), width: 18 },
        { key: 'bought', header: t('stats.indBought'), type: 'number', width: 12, sum: true },
        { key: 'given', header: t('stats.indLessons'), type: 'number', width: 12, sum: true },
        { key: 'unused', header: t('stats.indUnused'), type: 'number', width: 12, sum: true },
        { key: 'billed', header: t('individual.amount'), type: 'money', width: 14, sum: true },
      ]),
      lines.filter((l) => l.unused > 0)
    )
  );
  return sheets;
}
