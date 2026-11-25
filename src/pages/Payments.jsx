import { Fragment, useEffect, useMemo, useState } from 'react';
import { Plus, Download, Wallet, CheckCircle2, Pencil, Ban, RotateCcw, Trash2, Printer, Package, Receipt, Undo2, FileText } from 'lucide-react';
import { useT, monthName } from '../i18n';
import { feeShares as holidayShares, freeHalves, parseHolidays } from '../holidays';
import { useCan } from '../components/Auth';
import { useColumns } from '../components/Columns';
import { SendRemindersButton } from '../components/Notify';
import { useHdm } from '../components/Hdm';
import { useCustomerReceipt } from '../components/Thermal';
import { useMessenger } from '../components/Messenger';
import { useRpc, rpc, fmtDate, todayIso, currentPeriod, addMonths, saveCsv, money } from '../lib';
import {
  Badge, Button, Empty, Field, Loading, Modal, Money, RowMenu, SearchBox, Segmented, StudentPicker, Tabs,
  useAction, useClub, useConfirm,
} from '../components/ui';
import { useEditLock } from '../components/Locks';
import { openStoredFile } from '../components/Absence';

// Payment methods the club accepts, in the order shown; the first is the default.
export const PAYMENT_METHODS = ['card', 'easypay', 'transfer'];
// Students' «Կարգավիճակ» with a discount, and how much (the war victims' 100% pay nothing, so no receipt).
export const CATEGORY_DISCOUNT = { siblings: 50, half: 50, orphan: 50, staff: 50 };

// The student's group: its full monthly fee and whether it is a championship team.
function useGroupOf() {
  const { data: groups } = useRpc('groups.list');
  return (id) => (groups || []).find((g) => g.id === Number(id)) || null;
}
// A month's full price: the group's full fee (else the student's fee) for that month (holidays, joining late).
const fullMonthPrice = (group, fallbackFee, period, club, joinDate) =>
  studentMonthFee(Number(group?.monthly_fee) > 0 ? group.monthly_fee : fallbackFee, period, club, joinDate);
// The discount % from the full price and what is paid (30 000 → 15 000 = 50%; → 3 000 = 90%).
const pctOff = (full, paid) => (Number(full) > Number(paid) && Number(paid) > 0 ? Math.round(((full - paid) / full) * 10000) / 100 : 0);

// The payment date with «Զեղչով վճարում» on its right: a discounted payment's ՀԴՄ receipt shows the full price
// and «Զեղչ» (shown while the ՀԴՄ is on). The % is counted: the full monthly fee vs the amount paid.
// discount: { on }; lines: [{ full, paid }] of this payment.
function PaidAtField({ value, onChange, discount, onDiscount, lines = [] }) {
  const t = useT();
  const hdm = useHdm();
  const club = useClub();
  const pcts = [...new Set(lines.map((l) => pctOff(l.full, l.paid)))];
  const first = lines.find((l) => pctOff(l.full, l.paid) > 0);
  return (
    <Field label={t('payments.paidAt')}>
      <div className="row nowrap" style={{ gap: 12 }}>
        <input className="input" type="date" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 160 }} />
        {hdm.enabled && (
          <label className="check nowrap" title={t('payments.discountPayHint')}>
            <input type="checkbox" checked={discount.on} onChange={(e) => onDiscount({ ...discount, on: e.target.checked })} />
            {t('payments.discountPay')}
            {discount.on &&
              (first ? (
                <span className="discount-pct" title={`${money(first.full, club.currency)} → ${money(first.paid, club.currency)}`}>
                  {pcts.filter((p) => p > 0).map((p) => `${p}%`).join(' / ')}
                </span>
              ) : (
                <span className="small muted" title={t('payments.discountNoneHint')}>
                  {t('payments.discountNone')}
                </span>
              ))}
          </label>
        )}
      </div>
    </Field>
  );
}

// Each payment method has its own colour (picker buttons, tables, reports).
export const METHOD_COLORS = { card: '#2f6fdb', easypay: '#e07b00', transfer: '#8a4fd8' };

// The payment method as a small coloured label.
export function MethodTag({ method }) {
  const t = useT();
  const m = method || PAYMENT_METHODS[0];
  return (
    <span className="method-tag" style={{ '--m': METHOD_COLORS[m] || 'var(--text-3)' }}>
      {t(`method.${m}`)}
    </span>
  );
}

// excused: not owed because of an absence application («Հարգելի»).
export const chargeStatus = (c) =>
  c.status === 'paid'
    ? 'paid'
    : c.status === 'waived'
      ? c.excused_by
        ? 'excused'
        : 'waived'
      : c.due_date && c.due_date < todayIso()
        ? 'overdue'
        : 'unpaid';

const STATUS_TONE = { paid: 'good', unpaid: 'warn', overdue: 'bad', waived: '', excused: 'info' };

export function chargeLabel(t, c) {
  if (c.kind === 'monthly') return `${t('charge.monthly')} · ${monthName(t, c.period)}`;
  const name = c.description || c.product_name || t(`charge.${c.kind}`);
  return c.quantity > 1 ? `${name} × ${c.quantity}` : name;
}

export default function Payments({ route, nav }) {
  const t = useT();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav.payments')}</h1>
          <div className="sub">{t('payments.subtitle')}</div>
        </div>
      </div>
      <ChargesView preset={route.preset} nav={nav} />
    </>
  );
}

function ChargesView({ preset, nav }) {
  const canEdit = useCan('payments');
  const t = useT();
  const [status, setStatus] = useState(preset || 'all');
  const [kind, setKind] = useState('');
  const [period, setPeriod] = useState(preset === 'paid' ? currentPeriod() : '');
  const [groupId, setGroupId] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const { data: groups } = useRpc('groups.list');
  const { data, loading } = useRpc('charges.list', {
    status: status === 'overdue' || status === 'all' ? null : status,
    overdue: status === 'overdue',
    kind: kind || null,
    period: period || null,
    groupId: groupId ? Number(groupId) : null,
    search,
  });
  const rows = data || [];
  const total = rows.reduce((s, c) => s + c.amount, 0);

  const exportCsv = () =>
    saveCsv(`payments-${todayIso()}.csv`, [
      [t('payments.student'), t('students.group'), t('payments.description'), t('payments.dueDate'), t('payments.amount'),
        t('payments.status'), t('payments.paidAt'), t('payments.method')],
      ...rows.map((c) => [`${c.first_name} ${c.last_name}`, c.group_name, chargeLabel(t, c), fmtDate(c.due_date), c.amount,
        t(`chargeStatus.${chargeStatus(c)}`), c.paid_at ? fmtDate(c.paid_at) : '', c.method ? t(`method.${c.method}`) : '']),
    ]);

  return (
    <>
      <div className="toolbar">
        <Segmented
          value={status}
          onChange={setStatus}
          options={['all', 'unpaid', 'overdue', 'paid', 'waived'].map((v) => ({ value: v, label: t(`chargeStatus.${v}`) }))}
        />
        <div className="grow" />
        {canEdit && status === 'overdue' && rows.length > 0 && <SendRemindersButton />}
        <Button icon={Download} onClick={exportCsv} disabled={!rows.length}>
          {t('common.exportCsv')}
        </Button>
        {canEdit && (
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            {t('payments.newCharge')}
          </Button>
        )}
      </div>
      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder={t('payments.searchPlaceholder')} />
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">{t('payments.allTypes')}</option>
          <option value="monthly">{t('charge.monthly')}</option>
          <option value="product">{t('charge.product')}</option>
          <option value="other">{t('charge.other')}</option>
        </select>
        <select className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">{t('students.allGroups')}</option>
          {(groups || []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={period}
          title={status === 'paid' ? t('payments.monthPaid') : t('payments.monthFor')}
          onChange={(e) => setPeriod(e.target.value)}
        >
          <option value="">{t('payments.allMonths')}</option>
          {Array.from({ length: 25 }, (_, i) => addMonths(currentPeriod(), 1 - i)).map((p) => (
            <option key={p} value={p}>
              {monthName(t, p)}
            </option>
          ))}
        </select>
        <div className="grow" />
        <span className="muted">
          {t('payments.shown', { n: rows.length })} · <span className="strong" style={{ color: 'var(--text)' }}><Money value={total} /></span>
        </span>
      </div>

      {loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="card">
          <Empty icon={Wallet} title={t('payments.empty')} text={t('common.tryFilters')} />
        </div>
      ) : (
        <ChargesTable rows={rows} showStudent selectable onOpenStudent={(id) => nav('students', { id })} />
      )}

      {creating && <ChargeModal onClose={() => setCreating(false)} />}
    </>
  );
}

export function ChargesTable({ rows, showStudent, selectable, onOpenStudent, student, tools }) {
  const canEdit = useCan('payments');
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const club = useClub();
  const [selected, setSelected] = useState(() => new Set());
  const [paying, setPaying] = useState(null);
  const [editing, setEditing] = useState(null);

  // Drop selections that disappeared after a refresh.
  useEffect(() => {
    setSelected((s) => new Set([...s].filter((id) => rows.some((r) => r.id === id && r.status === 'unpaid'))));
  }, [rows]);

  const payable = rows.filter((r) => r.status === 'unpaid');
  const selRows = payable.filter((r) => selected.has(r.id));
  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const dash = <span className="muted">—</span>;
  const { columns, button: columnsButton } = useColumns(showStudent ? 'payments2' : 'studentPayments2', [
    {
      id: 'select',
      label: '',
      fixed: true,
      available: !!selectable && canEdit,
      head: () => (
        <th style={{ width: 36 }}>
          <input
            type="checkbox"
            className="check"
            checked={payable.length > 0 && selRows.length === payable.length}
            onChange={(e) => setSelected(e.target.checked ? new Set(payable.map((r) => r.id)) : new Set())}
          />
        </th>
      ),
      cell: (c) => <td>{c.status === 'unpaid' && <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />}</td>,
    },
    {
      id: 'index',
      label: '#',
      fixed: true,
      head: () => <th className="num" style={{ width: 44 }}>#</th>,
      cell: (c, i) => <td className="num muted">{i + 1}</td>,
    },
    {
      id: 'student',
      label: t('payments.student'),
      available: !!showStudent,
      head: () => <th>{t('payments.student')}</th>,
      cell: (c) => (
        <td>
          <a href="#" onClick={(e) => (e.preventDefault(), onOpenStudent?.(c.student_id))} style={{ fontWeight: 500, textDecoration: 'none' }}>
            {c.first_name} {c.last_name}
          </a>
          <div className="small muted">{c.group_name || ''}</div>
        </td>
      ),
    },
    {
      id: 'paidAt',
      label: t('payments.paidAt'),
      head: () => <th>{t('payments.paidAt')}</th>,
      cell: (c) => (
        <td className="small">
          {c.status === 'paid' ? (
            <>
              {fmtDate(c.paid_at)}
              <div className="muted">
                <MethodTag method={c.method} />
                {c.paid_by && c.paid_by !== 'system' ? ` · ${c.paid_by}` : ''}
              </div>
              {c.hdm_receipt && <div className="hdm-no">{t('hdm.short')} № {c.hdm_receipt}</div>}
            </>
          ) : (
            dash
          )}
        </td>
      ),
    },
    {
      id: 'description',
      label: t('payments.description'),
      head: () => <th>{t('payments.description')}</th>,
      cell: (c) => (
        <td>
          <div>{chargeLabel(t, c)}</div>
          {c.absence_from &&
            (c.absence_file_id ? (
              <button
                type="button"
                className="small app-link link"
                title={t('payments.openApplication')}
                onClick={(e) => {
                  e.stopPropagation();
                  act(() => openStoredFile(c.absence_file_id));
                }}
              >
                <FileText size={13} /> {applicationLabel(t, c.absence_from, c.absence_to)}
              </button>
            ) : (
              <div className="small app-link">{applicationLabel(t, c.absence_from, c.absence_to)}</div>
            ))}
          {c.note && <div className="small muted">{c.note}</div>}
        </td>
      ),
    },
    {
      id: 'dueDate',
      label: t('payments.dueDate'),
      defaultHidden: true,
      head: () => <th>{t('payments.dueDate')}</th>,
      cell: (c) => <td className="nowrap">{fmtDate(c.due_date)}</td>,
    },
    {
      id: 'amount',
      label: t('payments.amount'),
      head: () => <th className="num">{t('payments.amount')}</th>,
      cell: (c) => (
        <td className="num strong">
          <Money value={c.amount} />
        </td>
      ),
    },
    {
      id: 'status',
      label: t('payments.status'),
      head: () => <th>{t('payments.status')}</th>,
      cell: (c) => {
        const st = chargeStatus(c);
        return (
          <td>
            <Badge tone={STATUS_TONE[st]}>{t(`chargeStatus.${st}`)}</Badge>
          </td>
        );
      },
    },
    {
      id: 'method',
      label: t('payments.method'),
      defaultHidden: true,
      head: () => <th>{t('payments.method')}</th>,
      cell: (c) => <td>{c.status === 'paid' ? <MethodTag method={c.method} /> : dash}</td>,
    },
    {
      id: 'paidBy',
      label: t('columns.paidBy'),
      defaultHidden: true,
      head: () => <th>{t('columns.paidBy')}</th>,
      cell: (c) => <td>{c.status === 'paid' && c.paid_by && c.paid_by !== 'system' ? c.paid_by : dash}</td>,
    },
    {
      id: 'receipt',
      label: t('columns.receipt'),
      defaultHidden: true,
      head: () => <th>{t('columns.receipt')}</th>,
      cell: (c) => <td className="nowrap">{c.hdm_receipt || dash}</td>,
    },
    {
      id: 'note',
      label: t('payments.note'),
      defaultHidden: true,
      head: () => <th>{t('payments.note')}</th>,
      cell: (c) => <td className="small">{c.note || dash}</td>,
    },
    {
      id: 'actions',
      label: '',
      fixed: true,
      available: canEdit,
      head: () => <th className="actions" />,
      cell: (c) => (
        <td className="actions">
          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
            {c.status === 'unpaid' && (
              <Button size="sm" icon={CheckCircle2} onClick={() => setPaying([c])}>
                {t('payments.pay')}
              </Button>
            )}
            <Button size="sm" icon={Pencil} onClick={() => setEditing(c)}>
              {t('common.edit')}
            </Button>
            <Button size="sm" variant="ghost" icon={Trash2} title={t('common.delete')} onClick={() => removeCharge(c)} />
          </div>
        </td>
      ),
    },
  ]);

  const removeCharge = async (c) => {
    if (await confirm({ title: t('payments.deleteTitle'), text: t(c.kind === 'monthly' ? 'payments.deleteMonthlyConfirm' : 'payments.deleteConfirm', { what: chargeLabel(t, c) }), confirmLabel: t('common.delete') }))
      act(() => rpc('charges.delete', { id: c.id }), t('common.deleted'));
  };

  const printReceipt = (c) => {
    const name = student ? `${student.first_name} ${student.last_name}` : `${c.first_name} ${c.last_name}`;
    window.fc.print({ html: receiptHtml(t, club, c, name) });
  };

  return (
    <>
      {canEdit && selectable && selRows.length > 0 && (
        <div className="card card-pad row" style={{ marginBottom: 12, padding: '10px 16px', background: 'var(--accent-soft)' }}>
          <span className="strong">{t('payments.selected', { n: selRows.length })}</span>
          <Money value={selRows.reduce((s, r) => s + r.amount, 0)} className="strong" />
          <div className="grow" />
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {t('common.clear')}
          </Button>
          <Button size="sm" variant="primary" icon={CheckCircle2} onClick={() => setPaying(selRows)}>
            {t('payments.markPaid')}
          </Button>
        </div>
      )}
      <div className="table-tools">
        {tools}
        {columnsButton}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {columns.map((col) => (
                <Fragment key={col.id}>{col.head()}</Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={c.id} className={selected.has(c.id) ? 'selected' : ''}>
                {columns.map((col) => (
                  <Fragment key={col.id}>{col.cell(c, i)}</Fragment>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {paying && (
        <PayModal
          charges={paying}
          student={student}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            setSelected(new Set());
          }}
        />
      )}
      {editing && <EditChargeModal charge={{ ...editing, group_id: editing.group_id ?? student?.group_id }} onClose={() => setEditing(null)} onPrint={printReceipt} />}
    </>
  );
}

// «Դիմում՝ 01.10–05.10.2026» — the absence period a payment refers to.
export const applicationLabel = (t, from, to) => t('payments.applicationShort', { from: fmtDate(from).slice(0, 5), to: fmtDate(to) });

// «Դիմում» checkbox; when ticked, the absence period's first and last day.
// value: { from, to } or null; month ("YYYY-MM") gives the starting dates.
function AbsencePicker({ value, onChange, month }) {
  const t = useT();
  const start = () => {
    const m = month || todayIso().slice(0, 7);
    const [y, mo] = m.split('-').map(Number);
    return { from: `${m}-01`, to: `${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}` };
  };
  const bad = value && value.from && value.to && value.to < value.from;
  return (
    <div className="span-full stack" style={{ gap: 8 }}>
      <label className="check">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? start() : null)} />
        <span className="strong">{t('payments.application')}</span>
      </label>
      {value && (
        <div className="grid-2">
          <Field label={t('absence.from')}>
            <input className="input" type="date" value={value.from || ''} onChange={(e) => onChange({ ...value, from: e.target.value })} />
          </Field>
          <Field label={t('absence.to')}>
            <input className="input" type="date" value={value.to || ''} min={value.from || undefined} onChange={(e) => onChange({ ...value, to: e.target.value })} />
          </Field>
          {bad && <div className="small span-2" style={{ color: 'var(--bad)' }}>{t('error.PERIOD_INVALID')}</div>}
        </div>
      )}
    </div>
  );
}
const absenceOk = (v) => !v || (v.from && v.to && v.to >= v.from);

// Holiday months from the club's holidays (date ranges): { "2026-12": 50 } — that month costs 50% of the fee.
export const feeShares = (club) => holidayShares(parseHolidays(club?.holidays));
export const monthFee = (fee, period, shares) => (shares?.[period] != null ? Math.round((Number(fee) * Number(shares[period])) / 100) : Number(fee) || 0);
// The fee of one month for this student: holidays, and joining on the 16th or later (that month costs half).
export function studentMonthFee(fee, period, club, joinDate) {
  const late = /^\d{4}-\d{2}-\d{2}/.test(joinDate || '') && joinDate.slice(0, 7) === period && Number(joinDate.slice(8, 10)) >= 16;
  if (!late) return monthFee(fee, period, feeShares(club));
  const free = new Set([1, ...(freeHalves(parseHolidays(club?.holidays)).get(period) || [])]);
  return Math.round((Number(fee) * (100 - 50 * free.size)) / 100);
}

function MethodPicker({ value, onChange }) {
  const t = useT();
  return (
    <div className="seg method-seg">
      {PAYMENT_METHODS.map((m) => (
        <button key={m} type="button" className={value === m ? 'on' : ''} style={{ '--m': METHOD_COLORS[m] }} onClick={() => onChange(m)}>
          <span className="method-dot" />
          {t(`method.${m}`)}
        </button>
      ))}
    </div>
  );
}

export function PayModal({ charges, student, onClose, onDone }) {
  const t = useT();
  const act = useAction();
  const lock = useEditLock((student ? [student.id] : [...new Set(charges.map((c) => c.student_id))]).filter(Boolean).map((id) => `student:${id}`));
  const hdm = useHdm();
  const customer = useCustomerReceipt();
  const messenger = useMessenger();
  const [method, setMethod] = useState(PAYMENT_METHODS[0]);
  const [paidAt, setPaidAt] = useState(todayIso());
  // «Զեղչով վճարում»: on by itself when every student here has a discount «Կարգավիճակ»; the % is counted
  // from the group's full fee and the amount typed.
  const catOf = (c) => c.category ?? student?.category;
  const [discount, setDiscount] = useState(() => ({ on: charges.length > 0 && charges.every((c) => CATEGORY_DISCOUNT[catOf(c)]) }));
  const club = useClub();
  const groupOf = useGroupOf();
  const groupOfCharge = (c) => groupOf(c.group_id ?? student?.group_id);
  const fullOf = (c) =>
    c.kind === 'monthly'
      ? fullMonthPrice(groupOfCharge(c), c.student_fee ?? student?.monthly_fee ?? c.amount, c.period, club, c.join_date ?? student?.join_date)
      : c.amount;
  const lineOf = (c) => ({ label: chargeLabel(t, c), amount: Number(amounts[c.id]), ...(discount.on ? { fullPrice: fullOf(c) } : {}) });
  // The amount actually received for each charge; starts at the amount due and can be changed.
  const [amounts, setAmounts] = useState(() => Object.fromEntries(charges.map((c) => [c.id, String(c.amount)])));
  const total = charges.reduce((s, c) => s + (Number(amounts[c.id]) || 0), 0);
  const valid = charges.every((c) => Number(amounts[c.id]) > 0);
  const nameOf = (c) => (c.first_name ? `${c.first_name} ${c.last_name}` : student ? `${student.first_name} ${student.last_name}` : '');
  const pay = async () => {
    // Real ՀԴՄ: one receipt per student first; that student's payment is saved only when the ՀԴՄ confirms.
    if (hdm.device) {
      const groups = new Map();
      for (const c of charges) {
        if (!groups.has(c.student_id)) groups.set(c.student_id, []);
        groups.get(c.student_id).push(c);
      }
      let saved = 0;
      for (const list of groups.values()) {
        const pre = await hdm.beforePayment({
          method,
          student: nameOf(list[0]),
          items: list.map(lineOf),
          champ: !!groupOfCharge(list[0])?.championship,
        });
        if (pre === false) break;
        const ok = await act(() => rpc('charges.markPaid', { ids: list.map((c) => c.id), amounts, method, paidAt }), t('payments.paidToast'));
        if (!ok) break;
        if (pre) await rpc('charges.setReceipt', { ids: ok.ids || list.map((c) => c.id), receipt: pre.receiptNo, crn: pre.crn, fiscal: pre.fiscalNo }).catch(() => {});
        saved++;
        messenger?.afterPayment(list[0].student_id, nameOf(list[0]));
        await customer.afterPayment({
          studentId: list[0].student_id,
          items: list.map((c) => ({ id: c.id, label: chargeLabel(t, c), amount: Number(amounts[c.id]) })),
          method,
          paidAt,
          hdm: pre || null,
        });
      }
      if (saved) onDone();
      return;
    }
    const ok = await act(
      () => rpc('charges.markPaid', { ids: charges.map((c) => c.id), amounts, method, paidAt }),
      t('payments.paidToast')
    );
    if (!ok) return;
    onDone();
    // One ՀԴՄ receipt per student.
    const paidIds = new Set(ok.ids || []);
    const byStudent = new Map();
    for (const c of charges.filter((c) => paidIds.has(c.id))) {
      if (!byStudent.has(c.student_id)) byStudent.set(c.student_id, []);
      byStudent.get(c.student_id).push(c);
    }
    for (const list of byStudent.values()) {
      const c0 = list[0];
      const items = list.map((c) => ({ id: c.id, ...lineOf(c) }));
      const r = await hdm.afterPayment({ method, student: nameOf(c0), items, champ: !!groupOfCharge(c0)?.championship });
      messenger?.afterPayment(c0.student_id, nameOf(c0));
      await customer.afterPayment({ studentId: c0.student_id, items, method, paidAt, hdm: r || null });
    }
  };
  return (
    <Modal
      title={t('payments.markPaid')}
      lock={lock}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={CheckCircle2} onClick={pay} disabled={!valid}>
            {t('payments.confirmPaid', { amount: '' })} <Money value={total} />
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="card" style={{ maxHeight: 220, overflow: 'auto' }}>
          <div className="list">
            {charges.map((c) => (
              <div className="list-item" key={c.id} style={{ padding: '8px 14px' }}>
                <div className="grow">
                  {c.first_name && (
                    <div className="small muted">
                      {c.first_name} {c.last_name}
                    </div>
                  )}
                  {chargeLabel(t, c)}
                  {Number(amounts[c.id]) !== c.amount && (
                    <div className="small muted">
                      {t('payments.dueAmount')}: <Money value={c.amount} />
                    </div>
                  )}
                </div>
                <input
                  className="input num"
                  type="number"
                  min="0"
                  step="500"
                  style={{ width: 130, textAlign: 'right', fontWeight: 600 }}
                  value={amounts[c.id]}
                  autoFocus={charges.length === 1}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setAmounts({ ...amounts, [c.id]: e.target.value })}
                  aria-label={t('payments.receivedAmount')}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="grid-2">
          <Field label={t('payments.method')} className="span-2">
            <MethodPicker value={method} onChange={setMethod} />
          </Field>
          <div className="span-2">
            <PaidAtField
              value={paidAt}
              onChange={setPaidAt}
              discount={discount}
              onDiscount={setDiscount}
              lines={charges.map((c) => ({ full: fullOf(c), paid: Number(amounts[c.id]) }))}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function ChargeModal({ studentId: fixedStudent, onClose }) {
  const t = useT();
  const act = useAction();
  const [studentId, setStudentId] = useState(fixedStudent || null);
  const lock = useEditLock(studentId ? `student:${studentId}` : null);
  const [student, setStudent] = useState(null);
  const [kind, setKind] = useState('other');
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [period, setPeriod] = useState(currentPeriod());
  const [dueDate, setDueDate] = useState(todayIso());
  const [paid, setPaid] = useState(true);
  const [method, setMethod] = useState(PAYMENT_METHODS[0]);
  const [note, setNote] = useState('');
  const hdm = useHdm();
  const customer = useCustomerReceipt();
  const messenger = useMessenger();
  const club = useClub();
  const groupOf = useGroupOf();

  useEffect(() => {
    if (fixedStudent) rpc('students.get', { id: fixedStudent }).then((r) => setStudent(r.student)).catch(() => {});
  }, [fixedStudent]);

  useEffect(() => {
    if (!amountTouched && kind === 'monthly' && student) setAmount(studentMonthFee(student.monthly_fee, period, club, student.join_date));
  }, [kind, student, amountTouched, period]);

  const save = async () => {
    const label = kind === 'monthly' ? chargeLabel(t, { kind, period }) : description.trim() || t('charge.other');
    const who = student ? `${student.first_name} ${student.last_name}` : '';
    // Real ՀԴՄ: the receipt (and the card payment) first; nothing is saved if it doesn't go through.
    const champ = !!groupOf(student?.group_id)?.championship;
    const pre = paid ? await hdm.beforePayment({ method, student: who, items: [{ label, amount: Number(amount) }], champ }) : undefined;
    if (pre === false) return;
    const ok = await act(
      () =>
        rpc('charges.create', {
          studentId,
          kind,
          amount,
          description,
          period: kind === 'monthly' ? period : null,
          dueDate: kind === 'monthly' ? null : dueDate,
          paid,
          method,
          note,
        }),
      t('common.saved')
    );
    if (!ok) return;
    onClose();
    if (!paid || !ok.id) return;
    const items = [{ id: ok.id, label, amount: Number(amount) }];
    let r = pre;
    if (pre) await rpc('charges.setReceipt', { ids: [ok.id], receipt: pre.receiptNo, crn: pre.crn, fiscal: pre.fiscalNo }).catch(() => {});
    else r = await hdm.afterPayment({ method, student: who, items, champ });
    messenger?.afterPayment(studentId, who);
    await customer.afterPayment({ studentId, items, method, paidAt: todayIso(), hdm: r || null });
  };

  return (
    <Modal
      title={t('payments.newCharge')}
      lock={lock}
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!studentId || !(Number(amount) > 0)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {!fixedStudent && (
          <Field label={t('payments.student')}>
            <StudentPicker
              autoFocus
              value={studentId}
              onChange={(id, s) => {
                setStudentId(id);
                setStudent(s);
              }}
            />
          </Field>
        )}
        <Field label={t('payments.type')}>
          <Segmented
            value={kind}
            onChange={(k) => {
              setKind(k);
              setAmountTouched(false);
              setAmount('');
            }}
            options={[
              { value: 'other', label: t('charge.other') },
              { value: 'monthly', label: t('charge.monthly') },
            ]}
          />
        </Field>

        {kind === 'monthly' && (
          <Field label={t('payments.month')} hint={t('payments.monthlyHint')}>
            <input className="input" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </Field>
        )}

        {kind !== 'monthly' && (
          <Field label={t('payments.description')}>
            <input
              className="input"
              value={description}
              placeholder={t('payments.descriptionPlaceholder')}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        )}

        <div className="grid-2">
          <Field label={t('payments.amount')}>
            <input
              className="input"
              type="number"
              min="0"
              step="500"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setAmountTouched(true);
              }}
            />
          </Field>
          {kind !== 'monthly' && (
            <Field label={t('payments.dueDate')}>
              <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
          )}
        </div>

        <label className="check">
          <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
          {t('payments.alreadyPaid')}
        </label>
        {paid && <MethodPicker value={method} onChange={setMethod} />}
        <Field label={t('payments.note')}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// «Ավելացնել պարտք»: an amount the student owes for a month, saved unpaid (e.g. «December is 7,000 ֏» that
// was agreed and not entered). A month without its fee yet gets its fee with this amount; a month that has
// one gets this as a separate amount for that month.
export function DebtModal({ student, charges, onClose }) {
  const t = useT();
  const act = useAction();
  const club = useClub();
  const lock = useEditLock(`student:${student.id}`);
  const [period, setPeriod] = useState(currentPeriod());
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const fee = /^\d{4}-\d{2}$/.test(period) ? charges.find((c) => c.kind === 'monthly' && c.period === period) : null;
  const month = /^\d{4}-\d{2}$/.test(period) ? monthName(t, period) : '';
  const save = async () => {
    const ok = await act(
      () =>
        rpc(
          'charges.create',
          fee
            ? { studentId: student.id, kind: 'other', amount, description: `${month} · ${note.trim() || t('debt.extra')}`, forPeriod: period, paid: false }
            : { studentId: student.id, kind: 'monthly', amount, period, paid: false, note }
        ),
      t('common.saved')
    );
    if (ok) onClose();
  };
  return (
    <Modal
      title={t('debt.title')}
      lock={lock}
      onClose={onClose}
      width={500}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!month || !(Number(amount) > 0)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('debt.month')}>
            <input className="input" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </Field>
          <Field label={t('payments.amount')}>
            <input className="input" type="number" min="0" step="500" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </Field>
        </div>
        <Field label={t('debt.note')}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {month && (
          <div className="small muted">
            {fee ? t('debt.extraHint', { month, amount: money(fee.amount, club.currency) }) : t('debt.newFee', { month })}
          </div>
        )}
      </div>
    </Modal>
  );
}

function EditChargeModal({ charge, onClose, onPrint }) {
  const t = useT();
  const act = useAction();
  const hdm = useHdm();
  const groupOf = useGroupOf();
  const receipt = useCustomerReceipt();
  const confirm = useConfirm();
  const monthly = charge.kind === 'monthly';
  const lock = useEditLock(`student:${charge.student_id}`);
  const [f, setF] = useState({
    amount: charge.amount,
    description: charge.description || '',
    note: charge.note || '',
    paidAt: charge.paid_at || '',
    method: charge.method || PAYMENT_METHODS[0],
    period: charge.period || '',
    absence: charge.absence_from ? { from: charge.absence_from, to: charge.absence_to } : null,
  });
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });

  // The student's other monthly fees, so months already paid can't be picked.
  const { data: others } = useRpc('charges.list', { studentId: charge.student_id, kind: 'monthly' }, { skip: !monthly });
  const year = (charge.period || todayIso()).slice(0, 4);
  const periods = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const otherOf = (p) => (others || []).find((c) => c.period === p && c.id !== charge.id);
  const stateOf = (p) => {
    const c = otherOf(p);
    if (!c) return 'none';
    return chargeStatus(c);
  };

  const save = async () => {
    const { absence, ...rest } = f;
    if (await act(() => rpc('charges.update', { id: charge.id, version: charge.version, ...rest, absenceFrom: absence?.from ?? null, absenceTo: absence?.to ?? null }), t('common.saved'))) onClose();
  };
  const run = async (fn, text) => {
    if (await act(fn, text)) onClose();
  };

  return (
    <Modal
      title={chargeLabel(t, charge)}
      lock={lock}
      onClose={onClose}
      width={monthly ? 620 : 520}
      footer={
        <>
          <div className="left row" style={{ gap: 6 }}>
            {charge.status === 'paid' && hdm.enabled && !charge.hdm_receipt && (
              <Button
                icon={Receipt}
                onClick={() => {
                  onClose();
                  hdm.print({
                    champ: !!groupOf(charge.group_id)?.championship,
                    method: charge.method || PAYMENT_METHODS[0],
                    student: `${charge.first_name || ''} ${charge.last_name || ''}`.trim(),
                    items: [{ id: charge.id, label: chargeLabel(t, charge), amount: charge.amount }],
                  });
                }}
              >
                {t('hdm.printNow')}
              </Button>
            )}
            {charge.status === 'paid' && hdm.device && charge.hdm_receipt && (
              <Button
                icon={Undo2}
                onClick={async () => {
                  if (await hdm.returnReceipt(charge)) onClose();
                }}
              >
                {t('hdm.return')}
              </Button>
            )}
            {charge.status === 'paid' && receipt.available && (
              <Button
                icon={Printer}
                onClick={() =>
                  receipt.print({
                    studentId: charge.student_id,
                    items: [{ id: charge.id, label: chargeLabel(t, charge), amount: charge.amount }],
                    method: charge.method,
                    paidAt: charge.paid_at,
                    hdm: charge.hdm_receipt ? { receiptNo: charge.hdm_receipt, fiscalNo: charge.hdm_fiscal } : null,
                  })
                }
              >
                {t('thermal.print')}
              </Button>
            )}
            {charge.status === 'paid' && (
              <Button icon={Printer} onClick={() => onPrint(charge)}>
                {t('payments.printReceipt')}
              </Button>
            )}
            {charge.status === 'paid' && (
              <Button
                icon={RotateCcw}
                onClick={async () =>
                  (await confirm({ text: t('payments.markUnpaidConfirm') })) &&
                  run(() => rpc('charges.markUnpaid', { id: charge.id }), t('common.saved'))
                }
              >
                {t('payments.markUnpaid')}
              </Button>
            )}
            {charge.status === 'unpaid' && (
              <Button icon={Ban} onClick={() => run(() => rpc('charges.waive', { id: charge.id }), t('common.saved'))}>
                {t('payments.waive')}
              </Button>
            )}
            {charge.status === 'waived' && (
              <Button icon={RotateCcw} onClick={() => run(() => rpc('charges.markUnpaid', { id: charge.id }), t('common.saved'))}>
                {t('payments.restore')}
              </Button>
            )}
            <Button
              variant="danger"
              icon={Trash2}
              onClick={async () =>
                (await confirm({
                  title: t('payments.deleteTitle'),
                  text: t(monthly ? 'payments.deleteMonthlyConfirm' : 'payments.deleteConfirm', { what: chargeLabel(t, charge) }),
                  confirmLabel: t('common.delete'),
                })) && run(() => rpc('charges.delete', { id: charge.id }), t('common.deleted'))
              }
            >
              {t('common.delete')}
            </Button>
          </div>
          <div className="row nowrap" style={{ gap: 10, marginLeft: 'auto' }}>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={save} disabled={!(Number(f.amount) > 0) || !absenceOk(f.absence)}>
              {t('common.save')}
            </Button>
          </div>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('payments.amount')}>
            <input className="input" type="number" min="0" value={f.amount} onChange={set('amount')} />
          </Field>
          {charge.status === 'paid' && (
            <Field label={t('payments.paidAt')}>
              <input className="input" type="date" value={f.paidAt} onChange={set('paidAt')} />
            </Field>
          )}
          <AbsencePicker value={f.absence} month={f.period || (charge.due_date || '').slice(0, 7)} onChange={(v) => setF({ ...f, absence: v })} />
          {!monthly && (
            <Field label={t('payments.description')} className="span-2">
              <input className="input" value={f.description} onChange={set('description')} />
            </Field>
          )}
        </div>
        {monthly && (
          <Field label={t('payments.month')} hint={t('payments.moveMonthHint')}>
            <div className="month-grid">
              {periods.map((p, i) => {
                const st = stateOf(p);
                const on = f.period === p;
                return (
                  <button
                    key={p}
                    type="button"
                    className={`month-btn ${on ? '' : st} ${on ? 'on' : ''}`}
                    disabled={!on && st === 'paid'}
                    onClick={() => set('period')(p)}
                  >
                    <span className="m">{t(`month.${i + 1}`)}</span>
                    <span className="s">{on ? '✓' : st === 'none' ? '' : t(`chargeStatus.${st}`)}</span>
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        <div className="grid-2">
          {charge.status === 'paid' && (
            <Field label={t('payments.method')} className="span-2">
              <MethodPicker value={f.method} onChange={set('method')} />
            </Field>
          )}
          <Field label={t('payments.note')} className="span-2">
            <input className="input" value={f.note} onChange={set('note')} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ receipt
function receiptHtml(t, club, c, studentName) {
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A5; margin: 14mm; }
    body { font-family: 'Segoe UI', Sylfaen, Arial, sans-serif; color: #111; font-size: 11pt; }
    h1 { font-size: 15pt; margin: 0; } .muted { color: #666; }
    table { width: 100%; border-collapse: collapse; margin-top: 16pt; }
    td { padding: 6pt 0; border-bottom: 1px solid #ddd; } td:last-child { text-align: right; }
    .total { font-size: 14pt; font-weight: 700; margin-top: 14pt; text-align: right; }
  </style></head><body>
    <h1>${esc(club.club_name)}</h1>
    <div class="muted">${esc([club.club_address, club.club_phone].filter(Boolean).join(' · '))}</div>
    <h2 style="font-size:13pt;margin-top:18pt">${esc(t('receipt.title'))} #${c.id}</h2>
    <table>
      <tr><td>${esc(t('payments.student'))}</td><td>${esc(studentName)}</td></tr>
      <tr><td>${esc(t('payments.description'))}</td><td>${esc(chargeLabel(t, c))}</td></tr>
      <tr><td>${esc(t('payments.paidAt'))}</td><td>${esc(fmtDate(c.paid_at))}</td></tr>
      <tr><td>${esc(t('payments.method'))}</td><td>${esc(t(`method.${c.method || PAYMENT_METHODS[0]}`))}</td></tr>
    </table>
    <div class="total">${esc(money(c.amount, club.currency))}</div>
    <p style="margin-top:40pt">${esc(t('receipt.signature'))}: ____________________</p>
  </body></html>`;
}

// Monthly fee payment from a student's page: click the months of this year being paid.
export function MonthlyPaymentModal({ student, charges, onClose }) {
  const t = useT();
  const act = useAction();
  const lock = useEditLock(`student:${student.id}`);
  const hdm = useHdm();
  const customer = useCustomerReceipt();
  const messenger = useMessenger();
  const year = todayIso().slice(0, 4);
  const periods = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const byPeriod = Object.fromEntries(charges.filter((c) => c.kind === 'monthly').map((c) => [c.period, c]));
  const stateOf = (p) => {
    const c = byPeriod[p];
    if (!c) return 'none';
    return chargeStatus(c);
  };
  const payable = (p) => !['paid', 'waived', 'excused'].includes(stateOf(p));
  // The current month is ticked when it still needs paying.
  const [picked, setPicked] = useState(() => new Set(payable(currentPeriod()) ? [currentPeriod()] : []));
  const [amount, setAmount] = useState(student.monthly_fee || '');
  const [method, setMethod] = useState(PAYMENT_METHODS[0]);
  const [paidAt, setPaidAt] = useState(todayIso());
  const [note, setNote] = useState('');
  const [absence, setAbsence] = useState(null);
  const [discount, setDiscount] = useState(() => ({ on: !!CATEGORY_DISCOUNT[student.category] }));
  const groupOf = useGroupOf();
  const group = groupOf(student.group_id);
  const fullOfMonth = (p) => fullMonthPrice(group, student.monthly_fee, p, club, student.join_date);
  const lineOf = (p) => ({ label: chargeLabel(t, { kind: 'monthly', period: p }), amount: amountOf(p), ...(discount.on ? { fullPrice: fullOfMonth(p) } : {}) });
  const selected = periods.filter((p) => picked.has(p));
  const club = useClub();
  const shares = feeShares(club);
  // A holiday month costs its share of the fee; a month halved by an application costs what that fee says.
  // A month already billed costs its billed amount (application halves, special prices such as the championship
  // groups' August), unless another fee is typed in; other months: the fee, with holidays and late joining.
  const amountOf = (p) =>
    byPeriod[p]?.status === 'unpaid' && (byPeriod[p]?.excused_by || Number(amount) === Number(student.monthly_fee))
      ? Number(byPeriod[p].amount)
      : studentMonthFee(amount, p, club, student.join_date);
  const lateJoin = selected.find((p) => p === student.join_date?.slice(0, 7) && Number(student.join_date.slice(8, 10)) >= 16);
  const total = selected.reduce((n, p) => n + amountOf(p), 0);
  const holidays = selected.filter((p) => shares[p] != null);

  const toggle = (p) =>
    setPicked((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });

  const save = async () => {
    const who = `${student.first_name} ${student.last_name}`;
    // Real ՀԴՄ: the receipt (and the card payment) first; the months are saved only when it confirms.
    const pre = await hdm.beforePayment({
      method,
      student: who,
      items: selected.map(lineOf),
      champ: !!group?.championship,
    });
    if (pre === false) return;
    const ok = await act(
      () => rpc('charges.payMonths', { studentId: student.id, periods: selected, amount, method, paidAt, note, absenceFrom: absence?.from, absenceTo: absence?.to }),
      t('payments.paidToast')
    );
    if (!ok) return;
    onClose();
    if (!ok.ids?.length) return;
    const items = ok.ids.map((id, i) => ({ id, ...lineOf(ok.periods[i]) }));
    let r = pre;
    if (pre) await rpc('charges.setReceipt', { ids: ok.ids, receipt: pre.receiptNo, crn: pre.crn, fiscal: pre.fiscalNo }).catch(() => {});
    else r = await hdm.afterPayment({ method, student: who, items, champ: !!group?.championship });
    messenger?.afterPayment(student.id, who);
    await customer.afterPayment({ studentId: student.id, items, method, paidAt, hdm: r || null });
  };

  return (
    <Modal
      title={`${t('charge.monthly')} — ${student.first_name} ${student.last_name}`}
      lock={lock}
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={CheckCircle2} onClick={save} disabled={!selected.length || !(Number(amount) > 0) || !absenceOk(absence)}>
            {t('payments.confirmPaid')} <Money value={total} />
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('payments.monthsOf', { year })} hint={t('payments.pickMonths')}>
          <div className="month-grid">
            {periods.map((p, i) => {
              const st = stateOf(p);
              const on = picked.has(p);
              return (
                <button
                  key={p}
                  type="button"
                  className={`month-btn ${st} ${on ? 'on' : ''}`}
                  disabled={!payable(p)}
                  onClick={() => toggle(p)}
                >
                  <span className="m">{t(`month.${i + 1}`)}</span>
                  <span className="s">{on ? '✓' : st === 'none' ? '' : t(`chargeStatus.${st}`)}</span>
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid-2">
          <div className="span-2 row" style={{ gap: 16, alignItems: 'flex-start' }}>
            <Field label={t('payments.amountPerMonth')}>
              <input className="input" type="number" min="0" step="500" style={{ width: 150 }} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <PaidAtField
              value={paidAt}
              onChange={setPaidAt}
              discount={discount}
              onDiscount={setDiscount}
              lines={selected.map((p) => ({ full: fullOfMonth(p), paid: amountOf(p) }))}
            />
          </div>
          {lateJoin && (
            <div className="span-full small" style={{ color: 'var(--info)' }}>
              {t('payments.lateJoin', { month: monthName(t, lateJoin), date: fmtDate(student.join_date) })} — {money(amountOf(lateJoin), club.currency)}
            </div>
          )}
          {holidays.length > 0 && (
            <div className="span-full small" style={{ color: 'var(--info)' }}>
              {holidays.map((p) => t('payments.holidayShare', { month: monthName(t, p), n: shares[p] }) + ` — ${money(amountOf(p), club.currency)}`).join(' · ')}
            </div>
          )}
          <AbsencePicker value={absence} month={selected[0]} onChange={setAbsence} />
          <Field label={t('payments.method')} className="span-2">
            <MethodPicker value={method} onChange={setMethod} />
          </Field>
          <Field label={t('payments.note')} className="span-3">
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
