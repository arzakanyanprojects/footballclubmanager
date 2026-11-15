import { useState } from 'react';
import { FileSpreadsheet, Smartphone, CreditCard, ArrowLeftRight, Layers } from 'lucide-react';
import { useT, monthName } from '../i18n';
import { useRpc, todayIso, currentPeriod, addMonths, daysInMonth, fmtDate, money } from '../lib';
import { Button, Field, Modal, Segmented, useAction, useClub } from './ui';
import { chargeLabel, PAYMENT_METHODS } from '../pages/Payments';

// Each report lists the payments received with one payment method, or all of them.
export const REPORTS = [
  { id: 'all', method: null, icon: Layers },
  { id: 'easypay', method: 'easypay', icon: Smartphone },
  { id: 'card', method: 'card', icon: CreditCard },
  { id: 'transfer', method: 'transfer', icon: ArrowLeftRight },
];

const monthRange = (period) => [`${period}-01`, `${period}-${String(daysInMonth(period)).padStart(2, '0')}`];

function presetRange(preset) {
  const period = currentPeriod();
  if (preset === 'lastMonth') return monthRange(addMonths(period, -1));
  if (preset === 'year') return [`${period.slice(0, 4)}-01-01`, todayIso()];
  return monthRange(period);
}

export default function ReportExport({ onClose }) {
  const t = useT();
  const act = useAction();
  const club = useClub();
  const [reportId, setReportId] = useState(REPORTS[0].id);
  const [preset, setPreset] = useState('month');
  const [[from, to], setRange] = useState(() => presetRange('month'));
  const report = REPORTS.find((r) => r.id === reportId);
  const { data: rows } = useRpc('reports.list', { method: report.method, from, to }, { skip: !from || !to });
  const total = (rows || []).reduce((s, r) => s + r.amount, 0);

  const pickPreset = (p) => {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p));
  };
  const setDate = (i) => (e) => {
    setPreset('custom');
    setRange(i === 0 ? [e.target.value, to] : [from, e.target.value]);
  };

  const exportFile = async () => {
    const name = t(`reports.${reportId}`);
    const columns = [
      { key: 'no', header: '№', width: 7, type: 'index' },
      { key: 'paid_at', header: t('payments.paidAt'), width: 16, type: 'date' },
      { key: 'student', header: t('payments.student'), width: 34 },
      { key: 'group_name', header: t('students.group'), width: 15 },
      { key: 'contract_no', header: t('students.contractNo'), width: 18 },
      { key: 'parent', header: t('form.parent'), width: 40 },
      { key: 'description', header: t('payments.description'), width: 34 },
      { key: 'method_name', header: t('reports.type'), width: 15 },
      { key: 'amount', header: t('payments.amount'), width: 17, type: 'money' },
      { key: 'paid_by', header: t('reports.receivedBy'), width: 18 },
    ];
    const data = rows.map((r) => ({
      ...r,
      student: [r.first_name, r.last_name, r.patronymic].filter(Boolean).join(' '),
      parent: [r.parent_name, r.parent_phone].filter(Boolean).join(', '),
      description: chargeLabel(t, r) + (r.note ? ` (${r.note})` : ''),
      paid_by: r.paid_by && r.paid_by !== 'system' ? r.paid_by : '',
      method_name: t(`method.${r.method}`),
    }));
    // A subtotal per payment type, then the grand total.
    const totals = PAYMENT_METHODS.map((m) => ({ label: t('reports.totalFor', { name: t(`method.${m}`) }), key: 'method_name', value: t(`method.${m}`) }));
    const res = await act(async () => {
      const r = await window.fc.saveXlsx({
        defaultName: `${name} ${from} - ${to}.xlsx`.replace(/[\\/:*?"<>|]/g, '_'),
        sheetName: name,
        title: `${club.club_name || 'FC Manager'} — ${report.method ? t('reports.title', { name }) : t('reports.allTitle')}`,
        subtitle: t('reports.subtitle', {
          from: fmtDate(from),
          to: fmtDate(to),
          n: data.length,
          total: money(total, club.currency),
        }),
        columns,
        rows: data,
        totals,
        grandTotalLabel: t('reports.grandTotal'),
        currencySymbol: money(0, club.currency).replace(/[\d,.\s]/g, '') || club.currency,
      });
      if (!r.ok) throw Object.assign(new Error(r.detail || r.error), { code: r.error, detail: r.detail });
      return r;
    }, t('reports.saved'));
    if (res) onClose();
  };

  return (
    <Modal
      title={t('reports.export')}
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={FileSpreadsheet} onClick={exportFile} disabled={!rows?.length || from > to}>
            {t('reports.exportButton')}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 18 }}>
        <Field label={t('reports.which')}>
          <div className="report-cards">
            {REPORTS.map((r) => (
              <button key={r.id} className={`report-card ${reportId === r.id ? 'on' : ''}`} onClick={() => setReportId(r.id)}>
                <r.icon size={20} />
                <span className="strong">{t(`reports.${r.id}`)}</span>
              </button>
            ))}
          </div>
        </Field>

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
              <input className="input" type="date" value={from} onChange={setDate(0)} style={{ width: 180 }} />
              <span className="muted">—</span>
              <input className="input" type="date" value={to} onChange={setDate(1)} style={{ width: 180 }} />
            </div>
          </div>
        </Field>

        <div className="card card-pad row" style={{ background: 'var(--surface-2)' }}>
          <FileSpreadsheet size={20} style={{ color: 'var(--accent-text)' }} />
          <div className="grow">
            {from > to ? (
              <span style={{ color: 'var(--bad)' }}>{t('reports.badRange')}</span>
            ) : rows?.length ? (
              t('reports.found', { n: rows.length })
            ) : (
              <span className="muted">{t('reports.none')}</span>
            )}
          </div>
          {rows?.length > 0 && <span className="strong">{money(total, club.currency)}</span>}
        </div>
      </div>
    </Modal>
  );
}
