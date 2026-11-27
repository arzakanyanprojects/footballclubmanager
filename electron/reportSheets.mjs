// The Excel sheet of each «Հաշվետվություններ» report (columns and rows), shared by the Reports window and the
// main process (automations email a report as a file). Pure: t is the translator (see translator()).

// The report kinds made by sheetOf (the others open their own export windows).
export const REPORT_KINDS = ['debts', 'feesByGroup', 'discounts', 'attendance', 'joinsLeaves', 'hdmReceipts', 'groupsSummary', 'missingDocs'];

// t(key, vars) over the app's dictionaries (electron/locales.mjs), as the screens' useT() does it.
export function translator(dictionaries, lang = 'hy') {
  const t = (key, vars) => {
    let s = dictionaries[lang]?.[key] ?? dictionaries.en[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
    return s;
  };
  t.lang = lang;
  return t;
}

// As src/i18n.jsx and src/pages/Payments.jsx show a month and a charge.
const monthName = (t, period) => {
  if (!period) return '';
  const [y, m] = period.split('-');
  return `${t(`month.${Number(m)}`)} ${y}`;
};
const chargeLabel = (t, c) => {
  if (c.kind === 'monthly') return `${t('charge.monthly')} · ${monthName(t, c.period)}`;
  const name = c.description || c.product_name || t(`charge.${c.kind}`);
  return c.quantity > 1 ? `${name} × ${c.quantity}` : name;
};

const pct = (a, b) => (b ? Number(a || 0) / Number(b) : null);

// Columns and rows of each report, ready for the Excel sheet.
export function sheetOf(kind, rows, t) {
  const months = (s) => String(s || '').split(',').filter(Boolean).sort().map((p) => monthName(t, p)).join(', ');
  const cat = (r) => (r.category ? t(`category.${r.category}`) : Number(r.monthly_fee) === 0 ? t('reportsx.free') : '');
  const idx = { key: 'no', header: '№', width: 6, type: 'index' };
  const name = { key: 'student', header: t('payments.student'), width: 32 };
  const group = { key: 'group_name', header: t('students.group'), width: 13 };
  switch (kind) {
    case 'debts':
      return {
        columns: [idx, name, group, { key: 'contract_no', header: t('students.contractNo'), width: 14 }, { key: 'parent_name', header: t('students.parent'), width: 24 },
          { key: 'parent_phone', header: t('parent.phone'), width: 15 }, { key: 'months_text', header: t('reportsx.unpaidMonths'), width: 34, wrap: true },
          { key: 'months', header: t('reportsx.monthsCount'), width: 9, type: 'number', sum: true }, { key: 'oldest', header: t('reportsx.oldest'), width: 13, type: 'date' },
          { key: 'debt', header: t('reportsx.debt'), width: 15, type: 'money', sum: true }],
        rows: rows.map((r) => ({ ...r, months_text: months(r.periods) })),
      };
    case 'feesByGroup':
      return {
        columns: [idx, group, { key: 'coach', header: t('students.coach'), width: 26 }, { key: 'students', header: t('reportsx.students'), width: 10, type: 'number', sum: true },
          { key: 'paid_count', header: t('reportsx.paidCount'), width: 11, type: 'number', sum: true }, { key: 'expected', header: t('reportsx.expected'), width: 15, type: 'money', sum: true },
          { key: 'paid', header: t('reportsx.paid'), width: 15, type: 'money', sum: true }, { key: 'unpaid', header: t('reportsx.unpaid'), width: 15, type: 'money', sum: true },
          { key: 'rate', header: t('reportsx.collected'), width: 11, type: 'percent' }],
        rows: rows.map((r) => ({ ...r, rate: pct(r.paid, r.expected) })),
      };
    case 'discounts':
      return {
        columns: [idx, name, group, { key: 'cat', header: t('students.category'), width: 28 }, { key: 'discount', header: t('reportsx.discount'), width: 11 },
          { key: 'monthly_fee', header: t('students.monthlyFee'), width: 14, type: 'money' }, { key: 'paid_total', header: t('reportsx.paidTotal'), width: 15, type: 'money', sum: true },
          { key: 'status_text', header: t('students.status'), width: 12 }, { key: 'notes', header: t('students.notes'), width: 36, wrap: true }],
        rows: rows.map((r) => ({ ...r, cat: cat(r), discount: Number(r.monthly_fee) === 0 ? '100%' : ['siblings', 'orphan', 'half'].includes(r.category) ? '50%' : '', status_text: t(`status.${r.status}`) })),
      };
    case 'attendance':
      return {
        columns: [idx, name, group, { key: 'days', header: t('reportsx.trainings'), width: 11, type: 'number' }, { key: 'present', header: t('reportsx.present'), width: 11, type: 'number', sum: true },
          { key: 'absent', header: t('reportsx.absent'), width: 11, type: 'number', sum: true }, { key: 'excused', header: t('reportsx.excused'), width: 11, type: 'number', sum: true },
          { key: 'rate', header: t('reportsx.attendanceRate'), width: 12, type: 'percent' }],
        rows: rows.map((r) => ({ ...r, present: r.present || 0, absent: r.absent || 0, excused: r.excused || 0, rate: pct(r.present, r.days) })),
      };
    case 'joinsLeaves':
      return {
        columns: [idx, { key: 'change_text', header: t('reportsx.change'), width: 14 }, { key: 'date', header: t('reportsx.date'), width: 13, type: 'date' }, name, group,
          { key: 'monthly_fee', header: t('students.monthlyFee'), width: 14, type: 'money' }, { key: 'contract_no', header: t('students.contractNo'), width: 14 },
          { key: 'parent_phone', header: t('parent.phone'), width: 15 }, { key: 'reason', header: t('students.inactiveReason'), width: 30, wrap: true }],
        rows: rows.map((r) => ({ ...r, change_text: t(r.change === 'joined' ? 'reportsx.joined' : 'reportsx.left') })),
      };
    case 'hdmReceipts':
      return {
        columns: [idx, { key: 'paid_at', header: t('payments.paidAt'), width: 13, type: 'date' }, name, group, { key: 'what', header: t('payments.description'), width: 28 },
          { key: 'method_text', header: t('reports.type'), width: 14 }, { key: 'amount', header: t('payments.amount'), width: 15, type: 'money', sum: true },
          { key: 'receipt', header: t('thermal.hdmReceipt'), width: 13 }, { key: 'hdm_fiscal', header: t('thermal.fiscalNo'), width: 16 }],
        rows: rows.map((r) => ({ ...r, what: chargeLabel(t, r), method_text: r.method ? t(`method.${r.method}`) : '', receipt: r.hdm_receipt || t('reportsx.noReceipt') })),
      };
    case 'groupsSummary':
      return {
        columns: [idx, group, { key: 'coach', header: t('students.coach'), width: 24 }, { key: 'assistant', header: t('groups.assistant'), width: 22 },
          { key: 'students', header: t('reportsx.students'), width: 10, type: 'number', sum: true }, { key: 'joined', header: t('reportsx.joinedCount'), width: 10, type: 'number', sum: true },
          { key: 'left_count', header: t('reportsx.leftCount'), width: 11, type: 'number', sum: true }, { key: 'days', header: t('reportsx.trainings'), width: 10, type: 'number' },
          { key: 'rate', header: t('reportsx.attendanceRate'), width: 12, type: 'percent' }, { key: 'paid', header: t('reportsx.paidMonth'), width: 15, type: 'money', sum: true },
          { key: 'debt', header: t('reportsx.debt'), width: 15, type: 'money', sum: true }],
        rows: rows.map((r) => ({ ...r, rate: pct(r.present_marks, r.all_marks) })),
      };
    case 'missingDocs': {
      const checks = [
        ['medical_doc', (r) => !Number(r.medical_doc), 'students.medicalDoc'],
        ['contract_no', (r) => !r.contract_no, 'students.contractNo'],
        ['document_no', (r) => !r.document_no, 'students.documentNo'],
        ['birth_date', (r) => !r.birth_date, 'students.birthDate'],
        ['parent_doc_no', (r) => !r.parent_doc_no, 'parent.docNo'],
        ['parent_ssn', (r) => !r.parent_ssn, 'parent.ssn'],
        ['parent_phone', (r) => !r.parent_phone, 'parent.phone'],
      ];
      return {
        columns: [idx, name, group, { key: 'parent_name', header: t('students.parent'), width: 24 }, { key: 'parent_phone', header: t('parent.phone'), width: 15 },
          { key: 'missing', header: t('reportsx.missing'), width: 50, wrap: true }, { key: 'count', header: t('reportsx.missingCount'), width: 10, type: 'number', sum: true }],
        rows: rows.map((r) => {
          const miss = checks.filter(([, f]) => f(r)).map(([, , label]) => t(label));
          return { ...r, missing: miss.join(', '), count: miss.length };
        }),
      };
    }
    default:
      return { columns: [], rows: [] };
  }
}

// What each report is asked for: a month ('period'), a date range ('range'), or nothing (as of today).
export const REPORT_PARAMS = { feesByGroup: 'period', attendance: 'period', groupsSummary: 'period', joinsLeaves: 'range', hdmReceipts: 'range' };

const dmy = (iso) => String(iso || '').split('-').reverse().join('/');
// The report's title and the time it covers, e.g. «Պարտքեր», «Հոկտեմբեր 2026» — for the file name and the email.
export function reportLabel(spec, t, today) {
  const title = t(`reportsx.${spec.report}`);
  const kind = REPORT_PARAMS[spec.report];
  const when = kind === 'period' ? monthName(t, spec.period) : kind === 'range' ? (spec.from === spec.to ? dmy(spec.from) : `${dmy(spec.from)} – ${dmy(spec.to)}`) : dmy(today);
  return { title, when };
}
