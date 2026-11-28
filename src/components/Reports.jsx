// «Հաշվետվություններ»: every report the club exports to Excel, in one window. Picking a report shows
// what it needs (a month, a date range, a group), how many rows it has, and the Export button.
import { useState } from 'react';
import {
  Wallet, AlertTriangle, PieChart, BadgePercent, CalendarCheck, UserPlus, Receipt, Shapes, FileWarning, FolderTree, Users, FileSpreadsheet, ArrowLeft,
  BarChart3, UserCheck,
} from 'lucide-react';
import { statsSheets, individualSheets } from './ReportBooks.mjs';
import { useT, monthName } from '../i18n';
import { useRpc, rpc, todayIso, currentPeriod, addMonths, daysInMonth, fmtDate, money } from '../lib';
import { Button, Field, Modal, Segmented, useAction, useClub } from './ui';
import { sheetOf } from '../../electron/reportSheets.mjs';
import ReportExport from './ReportExport';
import { GroupsExportModal } from './GroupsExport';
import { useAuth } from './Auth';

// params: 'period' (a month) · 'range' (from – to) · null. open: one of the existing export windows.
// book: a workbook of several sheets, from its own call (src/components/ReportBooks.js).
const REPORTS = [
  { id: 'stats', icon: BarChart3, params: 'range', book: { rpc: 'stats.sheet', sheets: statsSheets } },
  { id: 'individualReport', icon: UserCheck, params: 'range', perm: 'individual.view', book: { rpc: 'individual.sheet', sheets: individualSheets } },
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

function ReportOptions({ report, onBack, onDone }) {
  const t = useT();
  const canExport = useAuth().can('reports.excel');
  const act = useAction();
  const club = useClub();
  const [period, setPeriod] = useState(currentPeriod());
  const [preset, setPreset] = useState('month');
  const [[from, to], setRange] = useState(() => monthRange(currentPeriod()));
  const [groupId, setGroupId] = useState('');
  const { data: groups } = useRpc('groups.list');
  const params = { kind: report.id, period, from, to, groupId: groupId ? Number(groupId) : null };
  const { data: sheetRows, loading: sheetLoading } = useRpc('reports.sheet', params, { skip: !!report.book });
  const { data: book, loading: bookLoading } = useRpc(report.book?.rpc || 'stats.sheet', { from, to }, { skip: !report.book || from > to });
  // A workbook report counts its months (and, for «Անհատական», the students in them).
  const rows = report.book ? book?.months || null : sheetRows;
  const loading = report.book ? bookLoading : sheetLoading;
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
    if (report.book) {
      const range = `${fmtDate(from)} – ${fmtDate(to)}`;
      const res = await act(async () => {
        const r = await window.fc.saveXlsx({
          perm: 'reports.excel',
          kind: 'workbook',
          defaultName: `${title} ${from} - ${to}.xlsx`.replace(/[\\/:*?"<>|]/g, '_'),
          sheets: report.book.sheets(book, t, { title: `${club.club_name || 'FC Manager'} — ${title}`, subtitle: range }),
          currencySymbol: money(0, club.currency).replace(/[\d,.\s]/g, '') || club.currency,
        });
        if (!r.ok) throw Object.assign(new Error(r.detail || r.error), { code: r.error, detail: r.detail });
        return r;
      }, t('reports.saved'));
      if (res) onDone();
      return;
    }
    // As ՀԾ exports it, for accounting.
    if (report.id === 'salesAnalysis') {
      const yy = (d) => d.split('-').reverse().map((x, i) => (i === 2 ? x.slice(2) : x)).join('/');
      const res = await act(async () => {
        const r = await window.fc.saveXlsx({ perm: 'reports.excel', 
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
    const sheet = sheetOf(report.id, rows || [], t);
    const res = await act(async () => {
      const r = await window.fc.saveXlsx({ perm: 'reports.excel', 
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
        {!report.book && (
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
        )}
        <div className="card card-pad row" style={{ background: 'var(--surface-2)' }}>
          <FileSpreadsheet size={20} style={{ color: 'var(--accent-text)' }} />
          <div className="grow small">
            {loading && !rows ? '…' : report.book ? t('reportsx.monthsReady', { n: rows?.length || 0 }) : t('reportsx.rowsReady', { n: rows?.length || 0 })}
          </div>
          <Button variant="primary" icon={FileSpreadsheet} onClick={exportFile} disabled={!canExport || !rows?.length || (report.params === 'range' && from > to)}>
            {t('reports.exportButton')}
          </Button>
        </div>
      </div>
    </>
  );
}

export function ReportsModal({ onClose }) {
  const t = useT();
  const auth = useAuth();
  const [picked, setPicked] = useState(null);
  const [open, setOpen] = useState(null); // an existing export window
  const { data: groups } = useRpc('groups.list');
  if (open === 'payments') return <ReportExport onClose={onClose} />;
  if (open === 'groups') return <GroupsExportModal groups={groups || []} perm="reports.excel" onClose={onClose} />;
  if (open === 'allStudents') return <GroupsExportModal flat perm="reports.excel" onClose={onClose} />;
  return (
    <Modal title={t('reportsx.title')} onClose={onClose} width={760}>
      {picked ? (
        <ReportOptions report={picked} onBack={() => setPicked(null)} onDone={onClose} />
      ) : (
        <div className="reports-grid">
          {REPORTS.filter((r) => (r.id !== 'salesAnalysis' || auth.can('reports.sales')) && (!r.perm || auth.can(r.perm))).map((r) => (
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
