// «Անհատական» (its own menu, after Պայմանագրեր): students who take individual lessons, kept apart from the club's
// groups. Each month a student has a package (a monthly charge at the price of their service, e.g. «Ֆուտբոլ անհ. 4»
// = 4 lessons) and a row of days: a lesson given is marked on its date with its number (1, 2, 3…). A lesson from
// another month can count toward this month's package (e.g. 29.09 for October); it gets its own column.
import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2, UserRound, CalendarPlus, CheckCircle2 } from 'lucide-react';
import { useT, monthName } from '../i18n';
import { useAuth } from '../components/Auth';
import { useRpc, rpc, todayIso, currentPeriod, addMonths, daysInMonth, weekday, fmtDate } from '../lib';
import { Button, Empty, Field, Loading, Modal, Money, RowMenu, SearchBox, useAction, useConfirm } from '../components/ui';
import { PayModal } from './Payments';

// The services an individual student can buy, in the order the form offers them (prices: Settings → Club).
export const INDIVIDUAL_SERVICES = [
  'Ֆուտբոլ անհ. 4', 'Ֆուտբոլ անհ. 8', 'Ֆուտբոլ անհ. 12', 'Ֆուտբոլ անհ. 16',
  'Դարպասապահ 4', 'Դարպասապահ 8', 'Դարպասապահ 12', 'Դարպասապահ 16',
];
// The lessons in a month's package: the number at the end of the service («Ֆուտբոլ անհ. 8» → 8).
export const lessonsIn = (service) => Number(/(\d+)\s*$/.exec(service || '')?.[1]) || 0;

const pad = (n) => String(n).padStart(2, '0');
const shortDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

// Coach names from the groups (coach and assistant), for the form's list and the filter.
function useCoaches() {
  const { data } = useRpc('groups.list');
  return useMemo(
    () => [...new Set((data || []).flatMap((g) => [g.coach, g.assistant]).map((c) => String(c || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'hy')),
    [data]
  );
}

// The month shown, kept while moving to other pages and back.
let shownMonth = null;

export default function Individual({ nav }) {
  const t = useT();
  const auth = useAuth();
  const act = useAction();
  const confirm = useConfirm();
  const [month, setMonthState] = useState(shownMonth || currentPeriod());
  const setMonth = (m) => setMonthState((shownMonth = m));
  const { data, loading } = useRpc('individual.list', { month });
  const coaches = useCoaches();
  const [q, setQ] = useState('');
  const [coach, setCoach] = useState('');
  const [editing, setEditing] = useState(null); // {} = new, or the student
  const [paying, setPaying] = useState(null); // { student, charge }
  const [otherDate, setOtherDate] = useState(null); // the student a lesson on another date is added for

  const canAdd = auth.can('individual.add');
  const canEdit = auth.can('individual.edit');
  const canLessons = auth.can('individual.lessons');
  const canDelete = auth.can('individual.delete');
  const canPay = auth.can('payments.take');
  const seeMoney = auth.can('payments.view');

  const rows = data?.rows || [];
  const needle = q.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (!coach || r.coach === coach) &&
      (!needle ||
        [r.first_name, r.last_name, r.parent_first_name, r.parent_phone, r.coach, r.service].filter(Boolean).join(' ').toLowerCase().includes(needle))
  );

  const today = todayIso();
  const days = Array.from({ length: daysInMonth(month) }, (_, i) => `${month}-${pad(i + 1)}`);
  // Lessons on other months' dates that count toward this month (any row): one column each, in date order.
  const otherDays = [...new Set(rows.flatMap((r) => r.lessons.map((l) => l.date)).filter((d) => d.slice(0, 7) !== month))].sort();
  const columns = [...otherDays.filter((d) => d < `${month}-01`), ...days, ...otherDays.filter((d) => d > `${month}-31`)];

  const toggleLesson = async (r, date, on) => {
    if (!canLessons) return;
    await act(() => rpc('individual.lesson', { studentId: r.id, date, period: month, on }));
  };
  const remove = async (r) => {
    const name = `${r.first_name} ${r.last_name}`;
    if (!(await confirm({ title: t('individual.deleteTitle'), text: t('individual.deleteText', { name }), confirmLabel: t('common.delete'), danger: true }))) return;
    await act(() => rpc('individual.delete', { id: r.id }), t('common.deleted'));
  };
  const pay = (r) => {
    if (!r.package || r.package.status !== 'unpaid' || !canPay) return;
    const student = { id: r.id, first_name: r.first_name, last_name: r.last_name, service: r.service, monthly_fee: r.monthly_fee, individual: 1 };
    setPaying({ student, charge: { ...r.package, student_id: r.id, first_name: r.first_name, last_name: r.last_name, service: r.service, individual: 1 } });
  };

  const totals = shown.reduce(
    (s, r) => {
      const a = Number(r.package?.amount) || 0;
      return { all: s.all + a, paid: s.paid + (r.package?.status === 'paid' ? a : 0) };
    },
    { all: 0, paid: 0 }
  );

  // The page fills the window: the sheet scrolls inside its card and the totals row stays at the bottom.
  return (
    <div className="fill-page">
      <div className="page-head" style={{ flexWrap: 'wrap', rowGap: 10 }}>
        <div>
          <h1>{t('individual.title')}</h1>
          <div className="sub">{t('individual.subtitle')}</div>
        </div>
        <div className="spacer" />
        {month !== currentPeriod() && (
          <Button variant="ghost" onClick={() => setMonth(currentPeriod())}>
            {t('sheet.thisMonth')}
          </Button>
        )}
        <div className="row nowrap" style={{ gap: 10 }}>
          <Button icon={ChevronLeft} onClick={() => setMonth(addMonths(month, -1))} />
          <div className="strong" style={{ minWidth: 150, textAlign: 'center', fontSize: 15 }}>
            {monthName(t, month)}
          </div>
          <Button icon={ChevronRight} onClick={() => setMonth(addMonths(month, 1))} />
        </div>
        {canAdd && (
          <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
            {t('individual.add')}
          </Button>
        )}
      </div>

      {!data && loading ? (
        <Loading />
      ) : !rows.length ? (
        <div className="card">
          <Empty
            icon={UserRound}
            title={t('individual.empty')}
            text={t('individual.emptyText')}
            action={
              canAdd && (
                <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
                  {t('individual.add')}
                </Button>
              )
            }
          />
        </div>
      ) : (
        <>
          <div className="toolbar">
            <SearchBox value={q} onChange={setQ} placeholder={t('individual.search')} width={280} />
            <select className="select" style={{ width: 220 }} value={coach} onChange={(e) => setCoach(e.target.value)}>
              <option value="">{t('individual.allCoaches')}</option>
              {[...new Set([...coaches, ...rows.map((r) => r.coach).filter(Boolean)])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <div className="spacer" />
            <span className="small muted">{t('individual.cellHint')}</span>
          </div>
          <div className="table-wrap">
            <table className="table ind-sheet">
              <thead>
                <tr>
                  <th className="sticky-col ind-idx" rowSpan={2}>
                    {t('individual.no')}
                  </th>
                  <th className="sticky-col ind-name" rowSpan={2}>
                    {t('individual.name')}
                  </th>
                  <th rowSpan={2} className="num">{t('individual.birthYear')}</th>
                  <th rowSpan={2} className="num">{t('individual.lessons')}</th>
                  <th rowSpan={2} className="num ind-wrap">{t('individual.used')}</th>
                  {seeMoney && <th rowSpan={2} className="num">{t('individual.amount')}</th>}
                  <th rowSpan={2}>{t('individual.contact')}</th>
                  <th rowSpan={2}>{t('individual.coach')}</th>
                  <th colSpan={columns.length} className="month-col">
                    {monthName(t, month)}
                  </th>
                  <th rowSpan={2} />
                </tr>
                <tr>
                  {columns.map((d) => {
                    const other = d.slice(0, 7) !== month;
                    const w = weekday(d);
                    return (
                      <th key={d} className={`ind-day ${other ? 'other' : ''} ${d === today ? 'today' : ''} ${w === 0 || w === 6 ? 'weekend' : ''}`} title={fmtDate(d)}>
                        {other ? shortDate(d) : Number(d.slice(8))}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => {
                  const total = lessonsIn(r.service);
                  const used = r.lessons.length;
                  const number = new Map(r.lessons.map((l, n) => [l.date, n + 1]));
                  const pkg = r.package;
                  return (
                    <tr key={r.id} className={r.status === 'inactive' ? 'ind-inactive' : ''}>
                      <td className="sticky-col ind-idx num muted">{i + 1}</td>
                      <td className="sticky-col ind-name">
                        <a
                          href="#"
                          className="nowrap"
                          style={{ fontWeight: 500, textDecoration: 'none', color: 'inherit' }}
                          onClick={(e) => (e.preventDefault(), canEdit && setEditing(r))}
                          title={r.service || ''}
                        >
                          {r.first_name} {r.last_name}
                        </a>
                        {r.status === 'inactive' && <span className="small muted"> · {t('individual.inactive')}</span>}
                      </td>
                      <td className="num">{r.birth_year || ''}</td>
                      <td className="num">{total || ''}</td>
                      <td className="num strong" style={used > total ? { color: 'var(--bad)' } : undefined} title={used > total ? t('individual.over') : ''}>
                        {used}
                      </td>
                      {seeMoney && (
                        <td
                          className={`num ind-amount ${pkg?.status === 'paid' ? 'paid' : pkg?.status === 'unpaid' && pkg.due_date < today ? 'overdue' : ''} ${pkg?.status === 'unpaid' && canPay ? 'clickable' : ''}`}
                          onClick={() => pay(r)}
                          title={
                            !pkg
                              ? t('individual.noPackage')
                              : pkg.status === 'paid'
                                ? `${t('individual.paid')} · ${fmtDate(pkg.paid_at)}${pkg.hdm_receipt ? ` · ՀԴՄ ${pkg.hdm_receipt}` : ''}`
                                : `${t('individual.unpaid')}${canPay ? ` — ${t('individual.pay')}` : ''}`
                          }
                        >
                          {pkg ? <Money value={pkg.amount} /> : <span className="muted">—</span>}
                        </td>
                      )}
                      <td className="nowrap">
                        {r.parent_phone || ''} {r.parent_first_name ? <span className="muted">{r.parent_first_name}</span> : null}
                      </td>
                      <td className="nowrap">{r.coach || ''}</td>
                      {columns.map((d) => {
                        const n = number.get(d);
                        const other = d.slice(0, 7) !== month;
                        return (
                          <td key={d} className={`ind-day ${other ? 'other' : ''}`}>
                            <button
                              className={`ind-cell ${n ? 'on' : ''}`}
                              disabled={!canLessons || (!n && other)}
                              onClick={() => toggleLesson(r, d, !n)}
                              title={fmtDate(d)}
                            >
                              {n || ''}
                            </button>
                          </td>
                        );
                      })}
                      <td>
                        <RowMenu
                          items={[
                            canEdit && { label: t('common.edit'), icon: Pencil, onClick: () => setEditing(r) },
                            canPay && pkg?.status === 'unpaid' && { label: t('individual.pay'), icon: CheckCircle2, onClick: () => pay(r) },
                            canLessons && { label: t('individual.otherDate'), icon: CalendarPlus, onClick: () => setOtherDate(r) },
                            canDelete && '-',
                            canDelete && { label: t('common.delete'), icon: Trash2, danger: true, onClick: () => remove(r) },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
                {/* Takes the free height, so the totals row sits at the bottom of the card even with a few students. */}
                <tr className="ind-filler">
                  <td colSpan={8 + (seeMoney ? 1 : 0) + columns.length} />
                </tr>
              </tbody>
              {seeMoney && (
                <tfoot>
                  <tr>
                    <td className="sticky-col ind-idx" />
                    <td className="sticky-col ind-name strong">{t('individual.total')}</td>
                    <td colSpan={3} />
                    <td className="num strong" title={`${t('individual.paid')}: ${totals.paid}`}>
                      <Money value={totals.all} />
                      <div className="small" style={{ color: 'var(--good)' }}>
                        <Money value={totals.paid} />
                      </div>
                    </td>
                    <td colSpan={columns.length + 3} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}

      {editing && <IndividualModal student={editing} prices={data?.prices || {}} coaches={coaches} onClose={() => setEditing(null)} />}
      {paying && <PayModal charges={[paying.charge]} student={paying.student} onClose={() => setPaying(null)} onDone={() => setPaying(null)} />}
      {otherDate && <OtherDateModal student={otherDate} month={month} onClose={() => setOtherDate(null)} />}
    </div>
  );
}

// «Ավելացնել անհատական» / edit: the student's details, the coach and the service (the monthly package).
function IndividualModal({ student, prices, coaches, onClose }) {
  const t = useT();
  const act = useAction();
  const isNew = !student.id;
  const [f, setF] = useState({
    first_name: '', last_name: '', parent_first_name: '', birth_year: '', parent_phone: '', coach: '', service: INDIVIDUAL_SERVICES[0],
    join_date: todayIso(), status: 'active', ...student,
  });
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  const save = async () => {
    const r = await act(
      () =>
        rpc('individual.save', {
          id: f.id, version: f.version, first_name: f.first_name, last_name: f.last_name, parent_first_name: f.parent_first_name,
          birth_year: f.birth_year, parent_phone: f.parent_phone, coach: f.coach, service: f.service, join_date: f.join_date, status: f.status,
        }),
      t('common.saved')
    );
    if (r) onClose();
  };
  const coachList = f.coach && !coaches.includes(f.coach) ? [f.coach, ...coaches] : coaches;
  return (
    <Modal
      title={isNew ? t('individual.add') : t('individual.edit')}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!f.first_name?.trim() || !f.last_name?.trim() || !f.service}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <Field label={t('students.firstName')}>
          <input className="input" autoFocus value={f.first_name || ''} onChange={set('first_name')} />
        </Field>
        <Field label={t('students.lastName')}>
          <input className="input" value={f.last_name || ''} onChange={set('last_name')} />
        </Field>
        <Field label={t('individual.parentFirstName')}>
          <input className="input" value={f.parent_first_name || ''} onChange={set('parent_first_name')} />
        </Field>
        <Field label={t('individual.phone')}>
          <input className="input" value={f.parent_phone || ''} onChange={set('parent_phone')} />
        </Field>
        <Field label={t('individual.birthYear')}>
          <input className="input" type="number" min="1990" max="2100" placeholder="2015" value={f.birth_year || ''} onChange={set('birth_year')} />
        </Field>
        <Field label={t('individual.group')}>
          {/* Not a real group: every individual student carries this tag. */}
          <select className="select" value="individual" disabled>
            <option value="individual">{t('individual.groupTag')}</option>
          </select>
        </Field>
        <Field label={t('individual.coach')}>
          <select className="select" value={f.coach || ''} onChange={set('coach')}>
            <option value="">{t('individual.noCoach')}</option>
            {coachList.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label={t('individual.service')}>
          <select className="select" value={f.service || ''} onChange={set('service')}>
            {INDIVIDUAL_SERVICES.map((s) => (
              <option key={s} value={s}>
                {s}
                {prices[s] != null ? ` — ${Number(prices[s]).toLocaleString('en-US')}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('individual.startMonth')} hint={isNew ? t('individual.startHint') : ''}>
          <input className="input" type="date" value={f.join_date || ''} onChange={set('join_date')} />
        </Field>
        {!isNew && (
          <Field label={t('individual.status')}>
            <select className="select" value={f.status} onChange={set('status')}>
              <option value="active">{t('individual.active')}</option>
              <option value="inactive">{t('individual.inactive')}</option>
            </select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

// A lesson on a date outside the month shown that counts toward this month's package.
function OtherDateModal({ student, month, onClose }) {
  const t = useT();
  const act = useAction();
  const [date, setDate] = useState(`${addMonths(month, -1)}-${pad(daysInMonth(addMonths(month, -1)))}`);
  const save = async () => {
    if (await act(() => rpc('individual.lesson', { studentId: student.id, date, period: month, on: true }), t('common.saved'))) onClose();
  };
  return (
    <Modal
      title={`${t('individual.otherDate')} — ${student.first_name} ${student.last_name}`}
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!/^\d{4}-\d{2}-\d{2}$/.test(date)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={monthName(t, month)} hint={t('individual.otherDateHint')}>
        <input className="input" type="date" autoFocus value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
    </Modal>
  );
}
