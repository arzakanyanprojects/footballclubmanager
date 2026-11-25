// «Հաշվետվություններ»: every report the club exports to Excel, in one window. Picking a report shows
// what it needs (a month, a date range, a group), how many rows it has, and the Export button.
import { useState } from 'react';
import {
  Wallet, AlertTriangle, PieChart, BadgePercent, CalendarCheck, UserPlus, Receipt, Shapes, FileWarning, FolderTree, Users, FileSpreadsheet, ArrowLeft,
} from 'lucide-react';
import { useT, monthName } from '../i18n';
import { useRpc, rpc, todayIso, currentPeriod, addMonths, daysInMonth, fmtDate, money } from '../lib';
import { Button, Field, Modal, Segmented, useAction, useClub } from './ui';
import { chargeLabel } from '../pages/Payments';
import ReportExport from './ReportExport';
import { GroupsExportModal } from './GroupsExport';

// params: 'period' (a month) · 'range' (from – to) · null. open: one of the existing export windows.
const REPORTS = [
  { id: 'payments', icon: Wallet, open: 'payments' },
  { id: 'debts', icon: AlertTriangle },
  { id: 'feesByGroup', icon: PieChart, params: 'period' },
  { id: 'discounts', icon: BadgePercent },
  { id: 'attendance', icon: CalendarCheck, params: 'period' },
  { id: 'joinsLeaves', icon: UserPlus, params: 'range' },
  { id: 'hdmReceipts', icon: Receipt, params: 'range' },
  { id: 'salesAnalysis', icon: FileSpreadsheet, params: 'range' },
  { id: 'groupsSummary', icon: Shapes, params: 'period' },
  { id: 'missingDocs', icon: FileWarning },
  { id: 'groups', icon: FolderTree, open: 'groups' },
  { id: 'allStudents', icon: Users, open: 'allStudents' },
];

const monthRange = (p) => [`${p}-01`, `${p}-${String(daysInMonth(p)).padStart(2, '0')}`];
const pct = (a, b) => (b ? Number(a || 0) / Number(b) : null);

// Columns and rows of each report, ready for the Excel sheet.
function sheetOf(kind, rows, t, club) {
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

function ReportOptions({ report, onBack, onDone }) {
  const t = useT();
  const act = useAction();
  const club = useClub();
  const [period, setPeriod] = useState(currentPeriod());
  const [preset, setPreset] = useState('month');
  const [[from, to], setRange] = useState(() => monthRange(currentPeriod()));
  const [groupId, setGroupId] = useState('');
  const { data: groups } = useRpc('groups.list');
  const params = { kind: report.id, period, from, to, groupId: groupId ? Number(groupId) : null };
  const { data: rows, loading } = useRpc('reports.sheet', params);
  const pickPreset = (p) => {
    setPreset(p);
    const cur = currentPeriod();
    if (p === 'month') setRange(monthRange(cur));
    if (p === 'lastMonth') setRange(monthRange(addMonths(cur, -1)));
    if (p === 'year') setRange([`${cur.slice(0, 4)}-01-01`, todayIso()]);
  };
  const title = t(`reportsx.${report.id}`);
  const groupName = groupId ? (groups || []).find((g) => String(g.id) === groupId)?.name : '';
  const when = report.params === 'period' ? monthName(t, period) : report.params === 'range' ? `${fmtDate(from)} – ${fmtDate(to)}` : fmtDate(todayIso());

  const exportFile = async () => {
    // As ՀԾ exports it, for accounting.
    if (report.id === 'salesAnalysis') {
      const yy = (d) => d.split('-').reverse().map((x, i) => (i === 2 ? x.slice(2) : x)).join('/');
      const res = await act(async () => {
        const r = await window.fc.saveXlsx({
          kind: 'salesAnalysis',
          defaultName: `SalesAnalysis ${from} - ${to}${groupName ? ` ${groupName}` : ''}.xlsx`.replace(/[\\/:*?"<>|]/g, '_'),
          title: `Վաճառքների վերլուծություն ${yy(from)} - ${yy(to)}`,
          rows: rows || [],
        });
        if (!r.ok) throw Object.assign(new Error(r.detail || r.error), { code: r.error, detail: r.detail });
        return r;
      }, t('reports.saved'));
      if (res) onDone();
      return;
    }
    const sheet = sheetOf(report.id, rows || [], t, club);
    const res = await act(async () => {
      const r = await window.fc.saveXlsx({
        kind: 'table',
        defaultName: `${title} ${report.params === 'period' ? period : report.params === 'range' ? `${from} - ${to}` : todayIso()}${groupName ? ` ${groupName}` : ''}.xlsx`.replace(/[\\/:*?"<>|]/g, '_'),
        sheetName: title,
        title: `${club.club_name || 'FC Manager'} — ${title}`,
        subtitle: [when, groupName, t('reportsx.rows', { n: sheet.rows.length })].filter(Boolean).join(' · '),
        columns: sheet.columns,
        rows: sheet.rows,
        totalLabel: t('reports.grandTotal'),
        currencySymbol: money(0, club.currency).replace(/[\d,.\s]/g, '') || club.currency,
      });
      if (!r.ok) throw Object.assign(new Error(r.detail || r.error), { code: r.error, detail: r.detail });
      return r;
    }, t('reports.saved'));
    if (res) onDone();
  };

  return (
    <>
      <div className="stack" style={{ gap: 16 }}>
        <div className="row">
          <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={onBack}>
            {t('reportsx.allReports')}
          </Button>
        </div>
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <report.icon size={22} style={{ color: 'var(--accent-text)', marginTop: 2 }} />
          <div>
            <div className="strong">{title}</div>
            <div className="small muted">{t(`reportsx.${report.id}Hint`)}</div>
          </div>
        </div>
        {report.params === 'period' && (
          <Field label={t('reportsx.month')}>
            <input className="input" type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} style={{ width: 200 }} />
          </Field>
        )}
        {report.params === 'range' && (
          <Field label={t('reports.period')}>
            <div className="stack" style={{ gap: 10 }}>
              <Segmented
                value={preset}
                onChange={pickPreset}
                options={[
                  { value: 'month', label: monthName(t, currentPeriod()) },
                  { value: 'lastMonth', label: monthName(t, addMonths(currentPeriod(), -1)) },
                  { value: 'year', label: t('reports.thisYear') },
                  { value: 'custom', label: t('reports.custom') },
                ]}
              />
              <div className="row">
                <input className="input" type="date" value={from} style={{ width: 180 }} onChange={(e) => (setPreset('custom'), setRange([e.target.value, to]))} />
                <span className="muted">—</span>
                <input className="input" type="date" value={to} style={{ width: 180 }} onChange={(e) => (setPreset('custom'), setRange([from, e.target.value]))} />
              </div>
            </div>
          </Field>
        )}
        <Field label={t('students.group')}>
          <select className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)} style={{ width: 260 }}>
            <option value="">{t('students.allGroups')}</option>
            {(groups || []).filter((g) => !g.archived).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="card card-pad row" style={{ background: 'var(--surface-2)' }}>
          <FileSpreadsheet size={20} style={{ color: 'var(--accent-text)' }} />
          <div className="grow small">{loading && !rows ? '…' : t('reportsx.rowsReady', { n: rows?.length || 0 })}</div>
          <Button variant="primary" icon={FileSpreadsheet} onClick={exportFile} disabled={!rows?.length || (report.params === 'range' && from > to)}>
            {t('reports.exportButton')}
          </Button>
        </div>
      </div>
    </>
  );
}

export function ReportsModal({ onClose }) {
  const t = useT();
  const [picked, setPicked] = useState(null);
  const [open, setOpen] = useState(null); // an existing export window
  const { data: groups } = useRpc('groups.list');
  if (open === 'payments') return <ReportExport onClose={onClose} />;
  if (open === 'groups') return <GroupsExportModal groups={groups || []} onClose={onClose} />;
  if (open === 'allStudents') return <GroupsExportModal flat onClose={onClose} />;
  return (
    <Modal title={t('reportsx.title')} onClose={onClose} width={760}>
      {picked ? (
        <ReportOptions report={picked} onBack={() => setPicked(null)} onDone={onClose} />
      ) : (
        <div className="reports-grid">
          {REPORTS.map((r) => (
            <button key={r.id} className="reports-item" onClick={() => (r.open ? setOpen(r.open) : setPicked(r))}>
              <r.icon size={20} />
              <span>
                <span className="strong">{t(`reportsx.${r.id}`)}</span>
                <span className="small muted">{t(`reportsx.${r.id}Hint`)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
