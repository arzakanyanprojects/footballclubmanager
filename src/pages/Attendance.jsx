import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, CheckCheck, Plus, Trash2, Users, UserRound, Shapes, Save, CalendarCheck, Printer, FileSpreadsheet, FilterX } from 'lucide-react';
import { useT, monthName } from '../i18n';
import { useAuth, useCan } from '../components/Auth';
import { useRpc, rpc, todayIso, currentPeriod, addMonths, daysInMonth, weekday, fmtDate, fmtDateTime, money } from '../lib';
import { Badge, Button, Empty, Field, Loading, Modal, Money, SearchBox, Segmented, useAction, useClub, useConfirm } from '../components/ui';
import { EditingMark, useEditLock, useLocks } from '../components/Locks';

// Marks that count as attended; anything else recorded counts as absent.
const PRESENT = ['present', 'late'];

export default function Attendance({ route, nav }) {
  return route.groupId ? <GroupSheet groupId={route.groupId} nav={nav} /> : <GroupCards nav={nav} />;
}

// «Ներկայացված» once every training day of the month has saved attendance.
function SubmittedBadge({ filled, total }) {
  const t = useT();
  return total > 0 && filled >= total ? (
    <Badge tone="good">{t('sheet.submitted')}</Badge>
  ) : (
    <Badge tone="warn">{t('sheet.notSubmitted')}</Badge>
  );
}

// The groups page's search and filters, kept while going into a group's sheet and back.
let cardFilters = { q: '', status: 'all', coach: '', year: '' };
const isSubmitted = (g) => g.days_total > 0 && g.days_filled >= g.days_total;
const groupYear = (g) => (String(g.name || '').match(/(19|20)\d{2}/) || [''])[0];

function GroupCards({ nav }) {
  const t = useT();
  const { data, loading } = useRpc('groups.list');
  const groups = (data || []).filter((g) => !g.archived);
  const locks = useLocks();
  const [flt, setFlt] = useState(cardFilters);
  const setF = (k) => (v) => setFlt((f) => (cardFilters = { ...f, [k]: v }));
  const coaches = useMemo(() => [...new Set(groups.map((g) => g.coach).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'hy')), [data]);
  const years = useMemo(() => [...new Set(groups.map(groupYear).filter(Boolean))].sort(), [data]);
  const q = flt.q.trim().toLowerCase();
  const base = groups.filter(
    (g) =>
      (!q || `${g.name} ${g.coach || ''} ${g.assistant || ''}`.toLowerCase().includes(q)) &&
      (!flt.coach || g.coach === flt.coach) &&
      (!flt.year || groupYear(g) === flt.year)
  );
  const shown = base.filter((g) => flt.status === 'all' || (flt.status === 'done') === isSubmitted(g));
  const doneCount = base.filter(isSubmitted).length;
  const filtered = !!(q || flt.coach || flt.year || flt.status !== 'all');

  // Set up this month's training days for every group, so each card can show its count.
  const ids = groups.map((g) => g.id).join(',');
  useEffect(() => {
    const month = currentPeriod();
    for (const g of groups) if (!g.days_total) rpc('training.ensure', { groupId: g.id, month }).catch(() => {});
  }, [ids]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav.attendance')}</h1>
          <div className="sub">{t('sheet.subtitle', { month: monthName(t, currentPeriod()) })}</div>
        </div>
      </div>
      {loading && !data ? (
        <Loading />
      ) : !groups.length ? (
        <div className="card">
          <Empty icon={Shapes} title={t('sheet.noGroups')} />
        </div>
      ) : (
        <>
        <div className="toolbar">
          <SearchBox value={flt.q} onChange={setF('q')} placeholder={t('sheet.searchGroups')} width={260} />
          <Segmented
            value={flt.status}
            onChange={setF('status')}
            options={[
              { value: 'all', label: `${t('sheet.filterAll')} · ${base.length}` },
              { value: 'done', label: `${t('sheet.submitted')} · ${doneCount}` },
              { value: 'todo', label: `${t('sheet.notSubmitted')} · ${base.length - doneCount}` },
            ]}
          />
          {coaches.length > 1 && (
            <select className="select" style={{ maxWidth: 240 }} value={flt.coach} onChange={(e) => setF('coach')(e.target.value)}>
              <option value="">{t('sheet.allCoaches')}</option>
              {coaches.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          {years.length > 1 && (
            <select className="select" value={flt.year} onChange={(e) => setF('year')(e.target.value)}>
              <option value="">{t('sheet.allYears')}</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          )}
          {filtered && (
            <Button variant="ghost" icon={FilterX} onClick={() => setFlt((cardFilters = { q: '', status: 'all', coach: '', year: '' }))}>
              {t('sheet.clearFilters')}
            </Button>
          )}
        </div>
        {!shown.length && (
          <div className="card">
            <Empty icon={Shapes} title={t('sheet.noMatch')} />
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
          {shown.map((g) => (
            <button
              key={g.id}
              className="card group-pick"
              style={{ borderTop: `4px solid ${g.color || 'var(--border-strong)'}` }}
              onClick={() => nav('attendance', { groupId: g.id })}
            >
              <div className="row">
                <h3 className="grow">
                  {g.name}
                  <EditingMark holder={locks[`attendance:${g.id}:${currentPeriod()}`]} />
                </h3>
                <SubmittedBadge filled={g.days_filled} total={g.days_total} />
              </div>
              <div className="row small muted">
                <UserRound size={15} /> {g.coach || t('groups.noCoach')}
              </div>
              <div className="row small muted">
                <Users size={15} /> {t('groups.students', { n: g.student_count })}
              </div>
              <div className="row small">
                <CalendarCheck size={15} className="muted" />
                <span className="muted">{t('sheet.trainingsCount')}</span>
                <span className="strong">
                  {g.days_filled} / {g.days_total}
                </span>
              </div>
            </button>
          ))}
        </div>
        </>
      )}
    </>
  );
}

function GroupSheet({ groupId, nav }) {
  const auth = useAuth();
  const canEdit = auth.can('attendance.mark'); // marks
  const canDays = auth.can('attendance.days'); // add / move training days
  const canRemove = auth.can('attendance.deleteDays'); // remove days, clear the month
  const changesSheet = canEdit || canDays || canRemove;
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const [month, setMonth] = useState(currentPeriod());
  const [readyMonth, setReadyMonth] = useState(null);
  const [draft, setDraft] = useState({}); // "studentId|date" -> 'present' | 'absent', changed but not saved yet
  const [menu, setMenu] = useState(null); // { day?, add?, x, y }
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const { data: groups } = useRpc('groups.list');
  const group = (groups || []).find((g) => g.id === groupId);

  // The first visit to a month creates its standard training days.
  useEffect(() => {
    let alive = true;
    setReadyMonth(null);
    rpc('training.ensure', { groupId, month })
      .catch(() => {})
      .finally(() => alive && setReadyMonth(month));
    return () => {
      alive = false;
    };
  }, [groupId, month]);

  const { data } = useRpc('training.month', { groupId, month }, { skip: readyMonth !== month });
  // One person marks a group's month at a time: taken at the first mark, kept while there are unsaved
  // marks, given back after 5 minutes without changes.
  const draftRef = useRef(0);
  const lock = useEditLock(changesSheet ? `attendance:${groupId}:${month}` : null, {
    lazy: true,
    idleMs: 5 * 60 * 1000,
    keepWhile: () => draftRef.current > 0,
  });

  const saved = useMemo(() => {
    const map = {};
    for (const r of data?.records || [])
      map[`${r.student_id}|${r.date}`] = PRESENT.includes(r.status) ? 'present' : r.status === 'excused' ? 'excused' : 'absent';
    return map;
  }, [data]);
  // Days inside an excused absence (absence application) count as «Հարգելի» when left blank.
  const excusedDay = (key) => {
    const [sid, date] = key.split('|');
    return (data?.absences || []).some((a) => String(a.student_id) === sid && date >= a.date_from && date <= a.date_to);
  };
  const current = (key) => draft[key] || saved[key] || (excusedDay(key) ? 'excused' : null);
  const changes = Object.keys(draft).filter((k) => draft[k] !== saved[k]).length;
  draftRef.current = changes;

  const today = todayIso();
  const days = data?.days || [];
  const students = data?.students || [];

  const toggle = async (key) => {
    if (!canEdit || !(await lock.ensure())) return;
    setDraft((d) => ({ ...d, [key]: current(key) === 'present' ? 'absent' : 'present' }));
  };

  // Leaving or switching month drops unsaved marks, so ask first.
  const leave = async (go) => {
    if (changes && !(await confirm({ text: t('sheet.unsavedConfirm'), confirmLabel: t('sheet.discard') }))) return;
    setDraft({});
    go();
  };

  const save = async () => {
    if (!(await lock.ensure())) return;
    setSaving(true);
    // A blank cell is saved as absent when the training has been held or anyone is marked on that day;
    // a future training nobody has been marked on yet stays blank.
    const used = (date) => date <= today || students.some((s) => current(`${s.id}|${date}`));
    const entries = students.flatMap((s) =>
      days.map((d) => ({ studentId: s.id, date: d.date, status: current(`${s.id}|${d.date}`) || (used(d.date) ? 'absent' : null) }))
    );
    const ok = await act(() => rpc('training.submit', { groupId, month, entries }), t('sheet.savedToast'));
    setSaving(false);
    if (ok) setDraft({});
  };

  const clearDays = async () => {
    if (!(await lock.ensure())) return;
    const ok = await confirm({
      title: t('sheet.clearDays'),
      text: t('sheet.clearDaysConfirm', { month: monthName(t, month), n: days.length }),
      confirmLabel: t('sheet.clearDays'),
    });
    if (ok && (await act(() => rpc('training.clearMonth', { groupId, month }), t('sheet.cleared')))) setDraft({});
  };

  const openMenu = async (e, payload) => {
    if (payload.add ? !canDays : !changesSheet) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (!(await lock.ensure())) return;
    setMenu({ ...payload, x: Math.min(r.left, window.innerWidth - 250), y: r.bottom + 6 });
  };

  return (
    <>
      <div className="page-head" style={{ flexWrap: 'wrap', rowGap: 10 }}>
        <Button variant="ghost" icon={ArrowLeft} onClick={() => leave(() => nav('attendance'))}>
          {t('nav.attendance')}
        </Button>
        <div>
          <h1 className="row" style={{ gap: 10 }}>
            <span className="dot" style={{ width: 12, height: 12, background: group?.color || undefined }} />
            {group?.name || ''}
            {data && <SubmittedBadge filled={data.filled.length} total={days.length} />}
          </h1>
          <div className="sub">
            {t('sheet.trainingsCount')}{' '}
            <span className="strong" style={{ color: 'var(--text)' }}>
              {data ? data.filled.length : 0} / {days.length}
            </span>
          </div>
        </div>
        <div className="spacer" />
        {lock.banner && <div style={{ flexBasis: '100%', order: 10 }}>{lock.banner}</div>}
        {auth.canAny('attendance.print', 'attendance.excel') && (
          <Button icon={Printer} onClick={() => setExporting(true)} disabled={!students.length}>
            {t('sheet.export')}
          </Button>
        )}
        {canRemove && (
          <Button variant="danger" icon={Trash2} onClick={clearDays} disabled={!days.length}>
            {t('sheet.clearDays')}
          </Button>
        )}
        {month !== currentPeriod() && (
          <Button variant="ghost" onClick={() => leave(() => setMonth(currentPeriod()))}>
            {t('sheet.thisMonth')}
          </Button>
        )}
        <div className="row nowrap" style={{ gap: 10 }}>
          <Button icon={ChevronLeft} onClick={() => leave(() => setMonth(addMonths(month, -1)))} />
          <div className="strong" style={{ minWidth: 150, textAlign: 'center', fontSize: 15 }}>
            {monthName(t, month)}
          </div>
          <Button icon={ChevronRight} onClick={() => leave(() => setMonth(addMonths(month, 1)))} />
        </div>
      </div>
      <div className="small muted" style={{ marginBottom: 12 }}>
        {t('sheet.legend')}
      </div>
      {data && !days.length && (
        <div className="small" style={{ marginBottom: 12, color: 'var(--warn)' }}>
          {t('sheet.noDays')}
        </div>
      )}

      {!data ? (
        <Loading />
      ) : !students.length ? (
        <div className="card">
          <Empty icon={Users} title={t('att.noStudents')} />
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table att-sheet">
              <thead>
                <tr>
                  <th className="sticky-col att-idx" rowSpan={2}>
                    #
                  </th>
                  <th className="sticky-col att-name" rowSpan={2}>
                    {t('students.name')}
                  </th>
                  <th colSpan={days.length + 1} className="month-col">
                    {monthName(t, month)}
                  </th>
                  <th rowSpan={2} className="num debt-col">
                    {t('sheet.debt')}
                  </th>
                </tr>
                <tr>
                  {days.map((d) => (
                    <th key={d.id} className="day-col">
                      <button
                        className={`day-btn ${d.date > today ? 'future' : ''} ${d.date === today ? 'today' : ''}`}
                        onClick={(e) => openMenu(e, { day: d })}
                        title={fmtDate(d.date)}
                      >
                        <span className="d">{Number(d.date.slice(8))}</span>
                        <span className="w">{t(`weekdayShort.${weekday(d.date)}`)}</span>
                      </button>
                    </th>
                  ))}
                  {canDays && (
                    <th className="day-col">
                      <button className="day-btn add" onClick={(e) => openMenu(e, { add: true })} title={t('sheet.addDay')}>
                        <Plus size={16} />
                      </button>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {students.map((s, i) => (
                  <tr key={s.id}>
                    <td className="sticky-col att-idx num muted">{i + 1}</td>
                    <td className="sticky-col att-name">
                      <a
                        href="#"
                        className="nowrap"
                        style={{ fontWeight: 500, textDecoration: 'none', color: 'inherit' }}
                        onClick={(e) => (e.preventDefault(), leave(() => nav('students', { id: s.id })))}
                      >
                        {[s.first_name, s.last_name, s.patronymic].filter(Boolean).join(' ')}
                      </a>
                    </td>
                    {days.map((d) => {
                      const key = `${s.id}|${d.date}`;
                      const st = current(key);
                      const edited = !!draft[key] && draft[key] !== saved[key];
                      return (
                        <td key={d.id} className="day-col">
                          <button
                            className={`mark ${st || 'none'} ${edited ? 'edited' : ''}`}
                            onClick={() => toggle(key)}
                            title={`${fmtDate(d.date)} — ${st ? t(`att.${st}`) : t('sheet.notMarked')}`}
                          >
                            {st === 'present' ? t('att.P') : st === 'absent' ? t('att.A') : st === 'excused' ? t('att.E') : ''}
                          </button>
                        </td>
                      );
                    })}
                    <td className="day-col" />
                    {/* Only real debt: amounts past their due date. */}
                    <td className="num debt-col strong" style={{ color: 'var(--bad)' }}>
                      {s.overdue > 0 && <Money value={s.overdue} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="sheet-foot">
            <div className="small muted grow">
              {changes > 0
                ? t('sheet.unsaved', { n: changes })
                : data.submitted.submitted_at
                  ? t('sheet.savedBy', { when: fmtDateTime(data.submitted.submitted_at), who: data.submitted.submitted_by || '—' })
                  : t('sheet.notSavedYet')}
            </div>
            {canEdit && (
              <Button variant="primary" icon={Save} onClick={save} disabled={saving || !days.length}>
                {t('sheet.save')}
              </Button>
            )}
          </div>
        </>
      )}

      {exporting && group && (
        <ExportModal group={group} month={month} students={students} onClose={() => setExporting(false)} />
      )}

      {menu && (
        <DayMenu
          menu={menu}
          month={month}
          groupId={groupId}
          can={{ mark: canEdit, days: canDays, remove: canRemove }}
          onAllPresent={(date) => setDraft((d) => ({ ...d, ...Object.fromEntries(students.map((s) => [`${s.id}|${date}`, 'present'])) }))}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

// Popup for a training day (change date, everyone present, remove) or for adding a day.
// can: { mark, days, remove } — what this user may do here (attendance ticks).
function DayMenu({ menu, month, groupId, can, onAllPresent, onClose }) {
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const ref = useRef(null);
  const [date, setDate] = useState(menu.day?.date || `${month}-01`);
  const range = { min: `${month}-01`, max: `${month}-${String(daysInMonth(month)).padStart(2, '0')}` };

  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && onClose();
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  const run = async (fn) => {
    if (await act(fn)) onClose();
  };

  return (
    <div ref={ref} className="menu day-menu" style={{ position: 'fixed', left: menu.x, top: menu.y }}>
      {can.days && <div className="stack" style={{ gap: 8, padding: 8 }}>
        <label className="small muted">{menu.add ? t('sheet.addDay') : t('sheet.changeDate')}</label>
        <div className="row" style={{ gap: 6 }}>
          <input className="input" type="date" {...range} value={date} onChange={(e) => setDate(e.target.value)} />
          <Button
            size="sm"
            variant="primary"
            disabled={!date || date < range.min || date > range.max || date === menu.day?.date}
            onClick={() =>
              run(() => (menu.add ? rpc('training.addDay', { groupId, date }) : rpc('training.moveDay', { id: menu.day.id, date })))
            }
          >
            {menu.add ? t('sheet.add') : t('common.save')}
          </Button>
        </div>
      </div>}
      {menu.day && (
        <>
          {can.days && (can.mark || can.remove) && <hr />}
          {can.mark && <button
            onClick={() => {
              onAllPresent(menu.day.date);
              onClose();
            }}
          >
            <CheckCheck size={15} />
            {t('att.allPresent')}
          </button>}
          {can.remove && <button
            className="danger"
            onClick={async () => {
              const ok = await confirm({
                text: t('sheet.removeDayConfirm', { date: fmtDate(menu.day.date) }),
                confirmLabel: t('sheet.removeDay'),
              });
              if (ok) run(() => rpc('training.removeDay', { id: menu.day.id }));
            }}
          >
            <Trash2 size={15} />
            {t('sheet.removeDay')}
          </button>}
        </>
      )}
    </div>
  );
}

// The coaches' paper form: empty columns without dates to fill in the date and Ներկա / Բացակա by hand, and
// each student's debt. How many columns is chosen when exporting: 2 by default, 3 for a championship group.
const blankColumnCount = (group) => (group?.championship ? 3 : 2);
const COLUMN_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8];

function ExportModal({ group, month, students, onClose }) {
  const t = useT();
  const canExcel = useCan('attendance.excel');
  const canPrint = useCan('attendance.print');
  const act = useAction();
  const club = useClub();
  const [n, setN] = useState(() => blankColumnCount(group));
  const cols = Array.from({ length: n }, (_, i) => `c${i + 1}`);

  const person = (name, phone) => (name ? `${name}${phone ? ` (${phone})` : ''}` : '—');
  const title = t('sheet.formTitle', { group: group.name });
  const lines = [
    t('sheet.labelValue', { label: t('groups.coach'), value: person(group.coach, group.coach_phone) }),
    t('sheet.labelValue', { label: t('groups.assistant'), value: person(group.assistant, group.assistant_phone) }),
    t('sheet.labelValue', { label: t('sheet.monthLabel'), value: monthName(t, month) }),
  ];
  const rows = students.map((s, i) => ({ no: i + 1, name: [s.first_name, s.last_name, s.patronymic].filter(Boolean).join(' '), debt: s.overdue || 0 }));

  const excel = () =>
    act(async () => {
      const r = await window.fc.saveXlsx({ perm: 'attendance.excel', 
        kind: 'form',
        defaultName: `${group.name} ${monthName(t, month)}.xlsx`.replace(/[\\/:*?"<>|]/g, '_'),
        sheetName: group.name,
        title,
        lines,
        columns: [
          { key: 'no', header: '#', width: 5, type: 'number' },
          { key: 'name', header: t('students.name'), width: 36, type: 'text' },
          ...cols.map((c) => ({ key: c, header: '', width: 18, type: 'blank' })),
          { key: 'debt', header: t('sheet.debt'), width: 14, type: 'money' },
        ],
        rows,
        currencySymbol: money(0, club.currency).replace(/[\d,.\s]/g, '') || club.currency,
      });
      if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error, detail: r.detail });
      return r;
    }, t('reports.saved'));

  const print = () => act(() => window.fc.print({ perm: 'attendance.print', html: formHtml({ title, lines, cols, rows, t, currency: club.currency, logo: club.club_logo }) }));

  return (
    <Modal
      title={t('sheet.exportTitle')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          {canExcel && (
            <Button icon={FileSpreadsheet} onClick={excel}>
              Excel
            </Button>
          )}
          {canPrint && (
            <Button variant="primary" icon={Printer} onClick={print}>
              {t('sheet.print')}
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        {!!group.championship && (
          <div>
            <Badge tone="info">{t('sheet.blankColsComp')}</Badge>
          </div>
        )}
        <Field label={t('sheet.blankColsCount')}>
          <Segmented value={n} onChange={setN} options={COLUMN_CHOICES.map((c) => ({ value: c, label: String(c) }))} />
        </Field>
        <div className="small muted">{t('sheet.blankCols', { n })}</div>
      </div>
    </Modal>
  );
}

// Printable page of the same form (A4; landscape when there are many days). The whole group fits on one
// page: the rows (and their text) get as tall as the page allows — 27 pt at most, smaller for a big group.
function formHtml({ title, lines, cols, rows, t, currency, logo }) {
  const esc = (v) => String(v ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
  const landscape = cols.length > 5;
  const pageH = ((landscape ? 210 : 297) - 24) * (72 / 25.4) - 18; // pt, inside the top and bottom margins, less the print date line
  const headH = (logo ? 66 : 30) + lines.length * 15 + 14 + 26; // title (and logo) + lines + space + the table's header row
  // Each row also has its border line (≈1 pt).
  const rowH = Math.max(5, Math.min(27, Math.floor(((pageH - headH - 12) / Math.max(rows.length, 1) - 1.2) * 10) / 10));
  const font = rowH >= 22 ? 11 : rowH >= 17 ? 10 : rowH >= 14 ? 8.5 : rowH >= 11 ? 7.5 : rowH >= 8 ? 6.5 : 5.5;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 12mm 12mm; }
    body { font-family: 'GHEA Grapalat', Sylfaen, Arial, sans-serif; color: #111; font-size: 11pt; margin: 0; width: ${landscape ? 273 : 186}mm; }
    h1 { font-size: 17pt; margin: 0 0 6pt; }
    .head { display: flex; align-items: flex-start; gap: 14pt; }
    .head img { width: 58pt; height: 58pt; object-fit: contain; }
    .line { margin: 2pt 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 12pt; }
    th, td { border: 1px solid #666; padding: 0 6pt; height: ${rowH}pt; font-size: ${font}pt; line-height: 1; }
    th { height: 24pt; }
    td.no, th.no { width: 22pt; text-align: center; padding: 0 2pt; color: #444; }
    th { background: #0e8a43; color: #fff; font-size: 10.5pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    th.name { text-align: left; }
    td.name { white-space: nowrap; }
    td.date, th.date { width: ${landscape ? 70 : 95}pt; }
    td.debt, th.debt { width: 80pt; text-align: right; white-space: nowrap; }
    td.debt { color: #c42b2b; font-weight: bold; }
    thead { display: table-header-group; }
    .printed { position: fixed; right: 0; bottom: 0; font-size: 9pt; color: #555; }
    tr { page-break-inside: avoid; }
  </style></head><body>
    <div class="head">
      ${logo && /^data:image\//.test(logo) ? `<img src="${logo}">` : ''}
      <div>
        <h1>${esc(title)}</h1>
        ${lines.map((l) => `<div class="line">${esc(l)}</div>`).join('')}
      </div>
    </div>
    <table>
      <thead><tr>
        <th class="no">#</th>
        <th class="name">${esc(t('students.name'))}</th>
        ${cols.map(() => '<th class="date"></th>').join('')}
        <th class="debt">${esc(t('sheet.debt'))}</th>
      </tr></thead>
      <tbody>
        ${rows
          .map(
            (r, i) =>
              `<tr><td class="no">${i + 1}</td><td class="name">${esc(r.name)}</td>${cols.map(() => '<td class="date"></td>').join('')}<td class="debt">${
                r.debt ? esc(money(r.debt, currency)) : ''
              }</td></tr>`
          )
          .join('')}
      </tbody>
    </table>
    <div class="printed">${esc(t('sheet.printedOn', { date: fmtDate(todayIso()) }))}</div>
    <script>
      // One page whatever the group: laid out at the page's width, then shrunk if still taller (or wider) than the
      // page. The app calls it right before making the PDF (when the logo and fonts are in).
      window.fitPage = function () {
        var availH = (${landscape ? 210 : 297} - 24 - 3) * 96 / 25.4 - 24; // above the print date line
        var availW = (${landscape ? 297 : 210} - 24 - 1) * 96 / 25.4;
        var table = document.querySelector('table');
        var z = 1;
        document.body.style.zoom = '1';
        // Measured again after each step (a table doesn't always shrink in proportion).
        for (var i = 0; i < 8; i++) {
          var r = table.getBoundingClientRect();
          var k = Math.min(availH / (r.bottom + 2), availW / Math.max(r.right, document.body.scrollWidth * z));
          if (k >= 1) break;
          z = Math.floor(z * k * 0.99 * 1000) / 1000;
          document.body.style.zoom = String(z);
        }
        return z;
      };
      window.addEventListener('load', window.fitPage);
    </script>
  </body></html>`;
}
