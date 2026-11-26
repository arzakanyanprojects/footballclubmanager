import { Fragment, useMemo, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Copy, Printer, FileSpreadsheet, CalendarPlus, MapPin, AlertTriangle, RotateCcw, Trash2, CalendarRange, Users, Pencil,
} from 'lucide-react';
import { useT } from '../i18n';
import { useAuth, useCan } from '../components/Auth';
import { useRpc, rpc, todayIso, weekday, fmtDate } from '../lib';
import { Button, Empty, Field, Loading, Modal, Segmented, useAction, useClub, useConfirm, useToast } from '../components/ui';
import { useEditLock } from '../components/Locks';

// Monday-first week; weekday numbers are JS ones (0 = Sunday).
const WEEK = [1, 2, 3, 4, 5, 6, 0];
// Soft fills for the birth-year blocks (screen and print), like the club's Excel.
const BLOCK_FILLS = ['#dbe8f7', '#fde4d2', '#e2f0d9', '#fff2cc', '#e6e0f5', '#d6f0ec', '#fadde3', '#ececec', '#e9f3c9', '#f5e0f0'];

const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};
const mondayOf = (iso) => addDays(iso, -((weekday(iso) + 6) % 7));
const loadPref = (k, def) => {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return v ?? def;
  } catch {
    return def;
  }
};
const savePref = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* per-PC convenience only */
  }
};

// Groups in blocks by the birth year in their name ("2013-2", "U10 (2016)"); others last.
function blocksOf(groups) {
  const map = new Map();
  for (const g of groups) {
    const y = (String(g.name).match(/(19|20)\d{2}/) || [])[0] || '';
    if (!map.has(y)) map.set(y, []);
    map.get(y).push(g);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a && b ? a.localeCompare(b) : a ? -1 : 1))
    .map(([year, list], i) => ({ year, groups: list, fill: BLOCK_FILLS[i % BLOCK_FILLS.length] }));
}

const overlap = (a, b) => a.start < b.end && b.start < a.end;
// Who coaches a session: a stand-in set for that date, otherwise the group's own coach / assistant.
const coachesOf = (g, s) => ({ coach: s?.coach || g.coach || '', assistant: s?.assistant || g.assistant || '' });
const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
// The same person written as «ՍԵՐԳԵՅ ՄԿՐՏՉՅԱՆ» or «ՄԿՐՏՉՅԱՆ ՍԵՐԳԵՅ».
const personKey = (s) => norm(s).replace(/[.․]/g, '').split(' ').filter(Boolean).sort().join(' ');

export default function Schedule() {
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const club = useClub();
  const auth = useAuth();
  const [mode, setMode] = useState('week'); // week | base
  // A cell: one date's change («schedule.day»), or the usual week («schedule.base»).
  const canEdit = auth.can(mode === 'base' ? 'schedule.base' : 'schedule.day');
  const canBase = auth.can('schedule.base');
  const [monday, setMonday] = useState(() => mondayOf(todayIso()));
  const [days, setDays] = useState(() => loadPref('fc.schedule.days', [6, 0]));
  const [editing, setEditing] = useState(null);
  const [coachesFor, setCoachesFor] = useState(null);
  const [pitchesOpen, setPitchesOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);

  const dates = WEEK.filter((w) => days.includes(w)).map((w) => addDays(monday, WEEK.indexOf(w)));
  const { data, loading } = useRpc('schedule.get', { dates });
  const blocks = useMemo(() => blocksOf(data?.groups || []), [data]);

  const toggleDay = (w) => {
    const next = days.includes(w) ? days.filter((x) => x !== w) : [...days, w];
    if (!next.length) return;
    setDays(next);
    savePref('fc.schedule.days', next);
  };

  // The training of a group on a date: that date's change if any, otherwise the usual weekly slot.
  const baseOf = (gid, wd) => (data?.base || []).find((b) => b.group_id === gid && b.weekday === wd) || null;
  const sessionOf = (gid, date) => {
    const d = (data?.days || []).find((x) => x.group_id === gid && x.date === date);
    if (d) return d.cancelled ? { cancelled: true, changed: true } : { ...d, changed: true };
    const b = baseOf(gid, weekday(date));
    return b ? { ...b, changed: false } : null;
  };

  // Clashes: the same coach at overlapping times on the same date. (Pitches are shared by several groups.)
  const clashes = useMemo(() => {
    const out = {};
    if (!data) return out;
    for (const date of dates) {
      const list = data.groups
        .map((g) => ({ g, s: sessionOf(g.id, date) }))
        .filter((x) => x.s && !x.s.cancelled && x.s.start);
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (!overlap(a.s, b.s)) continue;
          const reasons = [];
          const ca = coachesOf(a.g, a.s);
          const cb = coachesOf(b.g, b.s);
          const keysA = [ca.coach, ca.assistant].filter(Boolean).map(personKey);
          for (const c of [cb.coach, cb.assistant].filter(Boolean)) {
            if (keysA.includes(personKey(c))) reasons.push(t('schedule.clashCoach', { coach: c }));
          }
          for (const r of reasons) {
            (out[`${a.g.id}|${date}`] ||= []).push(`${r} — ${b.g.name}`);
            (out[`${b.g.id}|${date}`] ||= []).push(`${r} — ${a.g.name}`);
          }
        }
    }
    return out;
  }, [data, dates.join()]);
  const clashCount = Object.keys(clashes).length;

  const columns = mode === 'base' ? WEEK.filter((w) => days.includes(w)).map((w) => ({ key: `w${w}`, weekday: w })) : dates.map((d) => ({ key: d, date: d }));

  const copyWeek = async () => {
    if (!(await confirm({ title: t('schedule.copyTitle'), text: t('schedule.copyText'), confirmLabel: t('schedule.copy'), danger: false }))) return;
    const r = await act(() => rpc('schedule.copyWeek', { dates }));
    if (r) toast.success(t('schedule.copied', { n: r.copied }));
  };
  const toAttendance = async () => {
    const sessions = [];
    for (const g of data.groups) for (const date of dates) if (sessionOf(g.id, date)?.start) sessions.push({ groupId: g.id, date });
    if (!(await confirm({ title: t('schedule.toAttendanceTitle'), text: t('schedule.toAttendanceText', { n: sessions.length }), confirmLabel: t('schedule.add'), danger: false })))
      return;
    const r = await act(() => rpc('schedule.toAttendance', { sessions }));
    if (r) toast.success(t('schedule.toAttendanceDone', { n: r.added }));
  };

  const view = { blocks, dates, sessionOf, club, t };

  return (
    <>
      <div className="sticky-head">
        <div className="page-head" style={{ marginBottom: 12 }}>
          <div>
            <h1>{t('nav.schedule')}</h1>
            <div className="sub">{t(mode === 'base' ? 'schedule.baseSub' : 'schedule.weekSub')}</div>
          </div>
          <div className="spacer" />
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'week', label: t('schedule.modeWeek') },
              { value: 'base', label: t('schedule.modeBase') },
            ]}
          />
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          {mode === 'week' && (
            <div className="row nowrap" style={{ gap: 6 }}>
              <Button icon={ChevronLeft} onClick={() => setMonday(addDays(monday, -7))} />
              <div className="strong" style={{ minWidth: 150, textAlign: 'center' }}>
                {fmtDate(monday).slice(0, 5)} – {fmtDate(addDays(monday, 6))}
              </div>
              <Button icon={ChevronRight} onClick={() => setMonday(addDays(monday, 7))} />
            </div>
          )}
          {(
            <>
              <div className="day-chips">
                {WEEK.map((w) => (
                  <button key={w} className={days.includes(w) ? 'on' : ''} onClick={() => toggleDay(w)} title={t(`weekday.${w}`)}>
                    {t(`weekdayShort.${w}`)}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="grow" />
          {clashCount > 0 && mode === 'week' && (
            <span className="row small" style={{ color: 'var(--bad)', gap: 6 }}>
              <AlertTriangle size={15} /> {t('schedule.clashes', { n: clashCount })}
            </span>
          )}
          {canBase && !auth.groups && (
            <Button icon={MapPin} onClick={() => setPitchesOpen(true)}>
              {t('schedule.pitches')}
            </Button>
          )}
          {mode === 'week' && auth.can('schedule.copy') && (
            <Button icon={Copy} onClick={copyWeek} disabled={!data?.prevDays} title={data?.prevDays ? '' : t('schedule.copyNone')}>
              {t('schedule.copy')}
            </Button>
          )}
          {mode === 'week' && (
            <>
              {auth.can('attendance.days') && (
                <Button icon={CalendarPlus} onClick={toAttendance} disabled={!data}>
                  {t('schedule.toAttendance')}
                </Button>
              )}
              {auth.canAny('schedule.print', 'schedule.excel') && (
                <Button variant="primary" icon={Printer} onClick={() => setPrintOpen(true)} disabled={!data}>
                  {t('schedule.print')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {loading && !data ? (
        <Loading />
      ) : !data.groups.length ? (
        <div className="card">
          <Empty icon={CalendarRange} title={t('schedule.noGroups')} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table sched">
            <thead>
              <tr>
                <th className="sched-coach">{t('schedule.coach')}</th>
                <th className="sched-group">{t('schedule.group')}</th>
                {columns.map((c) => (
                  <th key={c.key} className="sched-col">
                    {c.date ? (
                      <>
                        {t(`weekday.${weekday(c.date)}`)}
                        <div className="sched-date">{fmtDate(c.date)}</div>
                      </>
                    ) : (
                      t(`weekday.${c.weekday}`)
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <Fragment key={b.year || 'other'}>
                  <tr className="sched-block" style={{ '--b': b.fill }}>
                    <td colSpan={2 + columns.length}>{b.year || t('schedule.otherGroups')}</td>
                  </tr>
                  {b.groups.map((g) => (
                    <tr key={g.id} style={{ '--b': b.fill }}>
                      <td className="sched-coach">
                        <button className="sched-coach-btn" disabled={!canBase} title={canBase ? t('schedule.editCoaches') : ''} onClick={() => setCoachesFor(g)}>
                          <span className="strong">{g.coach || <span className="muted">{t('groups.noCoach')}</span>}</span>
                          <span className="small muted">{g.assistant || '—'}</span>
                          {canBase && <Pencil size={13} className="sched-coach-edit" />}
                        </button>
                      </td>
                      <td className="sched-group">
                        <span className="row nowrap" style={{ gap: 7 }}>
                          <span className="dot" style={{ background: g.color || undefined }} />
                          <span className="strong">{g.name}</span>
                        </span>
                      </td>
                      {columns.map((c) => {
                        const s = c.date ? sessionOf(g.id, c.date) : baseOf(g.id, c.weekday);
                        const key = `${g.id}|${c.date}`;
                        const clash = c.date && clashes[key];
                        return (
                          <td key={c.key} className="sched-cell-td">
                            <button
                              className={`sched-cell ${s?.changed ? 'changed' : ''} ${s?.cancelled ? 'cancelled' : ''} ${clash ? 'clash' : ''} ${!s ? 'empty' : ''}`}
                              disabled={!canEdit}
                              title={clash ? clash.join('\n') : s?.changed ? t('schedule.changedHint') : ''}
                              onClick={() => setEditing({ group: g, date: c.date, weekday: c.date ? weekday(c.date) : c.weekday, session: s, base: c.date ? baseOf(g.id, weekday(c.date)) : s })}
                            >
                              {s?.cancelled ? (
                                <span className="sched-off">{t('schedule.noTraining')}</span>
                              ) : s ? (
                                <>
                                  <span className="sched-time">
                                    {s.start}–{s.end}
                                  </span>
                                  <span className="sched-place">
                                    {s.pitch || ''}
                                    {s.note ? <em> · {s.note}</em> : ''}
                                  </span>
                                  {(s.coach || s.assistant) && (
                                    <span className="sched-standin">
                                      {t('schedule.standInShort')}: {[s.coach, s.assistant].filter(Boolean).join(', ')}
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className="sched-add">+</span>
                              )}
                              {clash && <AlertTriangle size={13} className="sched-clash-icon" />}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="small muted" style={{ marginTop: 10 }}>
        {t(mode === 'base' ? 'schedule.baseHint' : 'schedule.weekHint')}
      </div>

      {editing && <CellModal edit={editing} mode={mode} pitches={data.pitches} people={peopleOf(data.groups)} onClose={() => setEditing(null)} />}
      {coachesFor && <CoachesModal group={coachesFor} people={peopleOf(data.groups)} onClose={() => setCoachesFor(null)} />}
      {pitchesOpen && <PitchesModal pitches={data?.pitches || []} onClose={() => setPitchesOpen(false)} />}
      {printOpen && <PrintModal view={view} onClose={() => setPrintOpen(false)} />}
    </>
  );
}

// Every coach / assistant name in use, for suggestions.
const peopleOf = (groups) =>
  [...new Set(groups.flatMap((g) => [g.coach, g.assistant]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'hy'));

function CellModal({ edit, mode, pitches, people, onClose }) {
  const t = useT();
  const canBase = useCan('schedule.base'); // «every week» changes the usual week
  const act = useAction();
  const { group, date, weekday: wd, session, base } = edit;
  const lock = useEditLock(mode === 'base' ? 'schedule:base' : date ? `schedule:week:${mondayOf(date)}` : null);
  const src = session && !session.cancelled ? session : base || {};
  const [f, setF] = useState({
    start: src.start || '',
    end: src.end || '',
    pitch: src.pitch || '',
    note: src.note || '',
    cancelled: !!session?.cancelled,
    permanent: false,
    coach: (!session?.cancelled && session?.coach) || '',
    assistant: (!session?.cancelled && session?.assistant) || '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const isBase = mode === 'base';
  const valid = f.cancelled || (f.start && f.end && f.end > f.start);

  const save = async () => {
    const ok = await act(async () => {
      if (isBase || f.permanent) {
        await rpc('schedule.saveBase', { groupId: group.id, weekday: wd, start: f.start, end: f.end, pitch: f.pitch, note: f.note });
        if (!isBase) {
          // A stand-in stays a change for this date only.
          if (f.coach.trim() || f.assistant.trim()) await rpc('schedule.setDay', { groupId: group.id, date, ...f, cancelled: false });
          else await rpc('schedule.resetDay', { groupId: group.id, date });
        }
      } else {
        await rpc('schedule.setDay', { groupId: group.id, date, ...f });
      }
    }, t('common.saved'));
    if (ok) onClose();
  };

  return (
    <Modal
      title={`${group.name} — ${t(`weekday.${wd}`)}${date ? ` ${fmtDate(date)}` : ''}`}
      lock={lock}
      onClose={onClose}
      width={520}
      footer={
        <>
          {!isBase && session?.changed && (
            <Button className="left" icon={RotateCcw} onClick={async () => (await act(() => rpc('schedule.resetDay', { groupId: group.id, date }), t('common.saved'))) && onClose()}>
              {t('schedule.resetDay')}
            </Button>
          )}
          {isBase && session && (
            <Button className="left" variant="danger" icon={Trash2} onClick={async () => (await act(() => rpc('schedule.saveBase', { groupId: group.id, weekday: wd, start: '' }), t('common.saved'))) && onClose()}>
              {t('schedule.removeSlot')}
            </Button>
          )}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!valid}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {!isBase && (
          <div className="small muted">
            {base ? t('schedule.usual', { time: `${base.start}–${base.end}`, pitch: base.pitch || '—' }) : t('schedule.noUsual')}
          </div>
        )}
        {!isBase && (
          <label className="check">
            <input type="checkbox" checked={f.cancelled} onChange={set('cancelled')} />
            {t('schedule.cancelDay')}
          </label>
        )}
        {!f.cancelled && (
          <>
            <div className="grid-2">
              <Field label={t('schedule.start')}>
                <input className="input" type="time" value={f.start} onChange={set('start')} autoFocus />
              </Field>
              <Field label={t('schedule.end')}>
                <input className="input" type="time" value={f.end} onChange={set('end')} />
              </Field>
              <Field label={t('schedule.pitch')}>
                <input className="input" list="fc-pitches" value={f.pitch} onChange={set('pitch')} placeholder="№ 3" />
                <datalist id="fc-pitches">
                  {pitches.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </Field>
              <Field label={t('schedule.note')}>
                <input className="input" value={f.note} onChange={set('note')} placeholder={t('schedule.notePlaceholder')} />
              </Field>
            </div>
            {f.start && f.end && f.end <= f.start && <div className="small" style={{ color: 'var(--bad)' }}>{t('error.TIME_INVALID')}</div>}
            {!isBase && (
              <div className="standin-box">
                <div className="small strong">{t('schedule.standIn')}</div>
                <div className="small muted">{t('schedule.standInHint')}</div>
                <div className="grid-2">
                  <Field label={t('groups.coach')}>
                    <input className="input" list="fc-people" value={f.coach} onChange={set('coach')} placeholder={group.coach || ''} />
                  </Field>
                  <Field label={t('groups.assistant')}>
                    <input className="input" list="fc-people" value={f.assistant} onChange={set('assistant')} placeholder={group.assistant || ''} />
                  </Field>
                </div>
                <datalist id="fc-people">
                  {people.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </div>
            )}
            {!isBase && canBase && (
              <label className="check small">
                <input type="checkbox" checked={f.permanent} onChange={set('permanent')} />
                {t('schedule.permanent', { day: t(`weekday.${wd}`) })}
              </label>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// The group's own coach and assistant, edited from the timetable (same as in Groups).
function CoachesModal({ group, people, onClose }) {
  const t = useT();
  const act = useAction();
  const lock = useEditLock(`group:${group.id}`);
  const [f, setF] = useState({
    coach: group.coach || '',
    coach_phone: group.coach_phone || '',
    assistant: group.assistant || '',
    assistant_phone: group.assistant_phone || '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    if (await act(() => rpc('schedule.setCoaches', { groupId: group.id, ...f }), t('common.saved'))) onClose();
  };
  return (
    <Modal
      title={`${t('schedule.editCoaches')} — ${group.name}`}
      lock={lock}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">{t('schedule.editCoachesHint')}</div>
        <div className="grid-2">
          <Field label={t('groups.coach')}>
            <input className="input" list="fc-people-g" value={f.coach} onChange={set('coach')} autoFocus />
          </Field>
          <Field label={t('groups.coachPhone')}>
            <input className="input" value={f.coach_phone} onChange={set('coach_phone')} />
          </Field>
          <Field label={t('groups.assistant')}>
            <input className="input" list="fc-people-g" value={f.assistant} onChange={set('assistant')} />
          </Field>
          <Field label={t('groups.assistantPhone')}>
            <input className="input" value={f.assistant_phone} onChange={set('assistant_phone')} />
          </Field>
        </div>
        <datalist id="fc-people-g">
          {people.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>
    </Modal>
  );
}

function PitchesModal({ pitches, onClose }) {
  const t = useT();
  const act = useAction();
  const lock = useEditLock('schedule:pitches');
  const [text, setText] = useState(pitches.join('\n'));
  const save = async () => {
    if (await act(() => rpc('schedule.savePitches', { names: text.split('\n') }), t('common.saved'))) onClose();
  };
  return (
    <Modal
      title={t('schedule.pitches')}
      lock={lock}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('schedule.pitchesLabel')} hint={t('schedule.pitchesHint')}>
        <textarea className="textarea" rows={10} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- print / Excel
function PrintModal({ view, onClose }) {
  const t = useT();
  const canExcel = useCan('schedule.excel');
  const canPrint = useCan('schedule.print');
  const act = useAction();
  const [kind, setKind] = useState('grid');
  const { blocks, dates, sessionOf, club } = view;
  const title = `${club.club_name || 'FC Manager'} — ${t('nav.schedule')}`;
  const dateLabel = (d) => `${fmtDate(d)} ${t(`weekdayShort.${weekday(d)}`)}`;

  const gridBlocks = blocks.map((b) => ({
    label: b.year || t('schedule.otherGroups'),
    fill: b.fill,
    groups: b.groups.map((g) => ({
      coach: g.coach || '',
      assistant: g.assistant || '',
      name: g.name,
      cells: dates.map((d) => {
        const s = sessionOf(g.id, d);
        if (!s) return { time: '', place: '' };
        if (s.cancelled) return { time: t('schedule.noTraining'), place: '' };
        const standIn = [s.coach, s.assistant].filter(Boolean).join(', ');
        return { time: `${s.start}-${s.end}`, place: [s.pitch, s.note, standIn && `(${t('schedule.standInShort')}: ${standIn})`].filter(Boolean).join(' ') };
      }),
    })),
  }));

  // One page per coach: their sessions on the chosen dates.
  const byCoach = () => {
    const map = new Map();
    for (const b of blocks)
      for (const g of b.groups)
        for (const d of dates) {
          const s = sessionOf(g.id, d);
          if (!s || s.cancelled || !s.start) continue;
          const who = coachesOf(g, s);
          for (const [name, role] of [
            [who.coach, t('groups.coach')],
            [who.assistant, t('groups.assistant')],
          ]) {
            if (!name) continue;
            const k = personKey(name);
            if (!map.has(k)) map.set(k, { name, rows: [] });
            map.get(k).rows.push({ date: d, time: `${s.start}-${s.end}`, group: g.name, place: [s.pitch, s.note].filter(Boolean).join(' '), role });
          }
        }
    return [...map.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'hy'))
      .map((c) => ({ ...c, rows: c.rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)) }));
  };

  const print = () =>
    act(() => window.fc.print({ perm: 'schedule.print', html: kind === 'grid' ? gridHtml({ title, dates: dates.map(dateLabel), blocks: gridBlocks, t }) : coachHtml({ title, coaches: byCoach(), dateLabel, t }) }));
  const excel = () =>
    act(() =>
      window.fc.saveXlsx({ perm: 'schedule.excel', 
        kind: 'schedule',
        defaultName: `schedule-${dates[0] || todayIso()}.xlsx`,
        title,
        dates: dates.map(dateLabel),
        blocks: gridBlocks,
        headers: { coach: t('schedule.coach').toUpperCase(), group: t('schedule.group').toUpperCase() },
      })
    );

  return (
    <Modal
      title={t('schedule.printTitle')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          {canExcel && kind === 'grid' && (
            <Button icon={FileSpreadsheet} onClick={excel}>
              Excel
            </Button>
          )}
          <Button variant="primary" icon={Printer} onClick={print} disabled={!canPrint}>
            {t('schedule.print')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">{t('schedule.printDates', { dates: dates.map(dateLabel).join(', ') })}</div>
        <div className="report-cards" style={{ gridTemplateColumns: '1fr 1fr' }}>
          {[
            ['grid', CalendarRange, 'schedule.printGrid', 'schedule.printGridHint'],
            ['coaches', Users, 'schedule.printCoaches', 'schedule.printCoachesHint'],
          ].map(([k, Icon, label, hint]) => (
            <button key={k} className={`card report-card ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
              <Icon size={20} />
              <span className="strong">{t(label)}</span>
              <span className="small muted">{t(hint)}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function gridHtml({ title, dates, blocks, t }) {
  const head = (fill) =>
    `<tr class="h" style="background:${fill}"><th>${esc(t('schedule.coach').toUpperCase())}</th><th>${esc(t('schedule.group').toUpperCase())}</th>${dates
      .map((d) => `<th>${esc(d)}</th>`)
      .join('')}</tr>`;
  const body = blocks
    .map(
      (b) =>
        head(b.fill) +
        b.groups
          .map(
            (g) =>
              `<tr style="background:${b.fill}"><td class="c">${esc(g.coach)}</td><td class="g" rowspan="2">${esc(g.name)}</td>${g.cells
                .map((c) => `<td class="t">${esc(c.time)}</td>`)
                .join('')}</tr>` +
              `<tr class="second" style="background:${b.fill}"><td class="c">${esc(g.assistant)}</td>${g.cells.map((c) => `<td class="p">${esc(c.place)}</td>`).join('')}</tr>`
          )
          .join('')
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { size: A4 ${dates.length > 3 ? 'landscape' : 'portrait'}; margin: 10mm; }
    body { font-family: 'GHEA Grapalat', Sylfaen, Arial, sans-serif; color: #111; font-size: 9.5pt; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    h1 { font-size: 13pt; margin: 0 0 6pt; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #555; padding: 2pt 5pt; text-align: center; }
    tr.h th { font-weight: bold; font-size: 9pt; }
    table { table-layout: fixed; }
    col.c { width: 30%; } col.g { width: 12%; }
    td.c { text-align: left; overflow-wrap: anywhere; }
    td.g { font-weight: bold; }
    td.t { font-weight: bold; }
    tr { page-break-inside: avoid; }
  </style></head><body><h1>${esc(title)}</h1><table><colgroup><col class="c"><col class="g">${dates.map(() => '<col>').join('')}</colgroup>${body}</table></body></html>`;
}

function coachHtml({ title, coaches, dateLabel, t }) {
  const pages = coaches
    .map(
      (c) => `<section><h1>${esc(c.name)}</h1><div class="sub">${esc(title)}</div><table>
        <tr><th>${esc(t('schedule.date'))}</th><th>${esc(t('schedule.time'))}</th><th>${esc(t('schedule.group'))}</th><th>${esc(t('schedule.pitch'))}</th><th>${esc(t('schedule.role'))}</th></tr>
        ${c.rows.map((r) => `<tr><td>${esc(dateLabel(r.date))}</td><td><b>${esc(r.time)}</b></td><td><b>${esc(r.group)}</b></td><td>${esc(r.place)}</td><td>${esc(r.role)}</td></tr>`).join('')}
      </table></section>`
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { size: A4 portrait; margin: 14mm; }
    body { font-family: 'GHEA Grapalat', Sylfaen, Arial, sans-serif; color: #111; font-size: 11pt; margin: 0; }
    section { page-break-after: always; }
    section:last-child { page-break-after: auto; }
    h1 { font-size: 16pt; margin: 0; }
    .sub { color: #555; margin: 2pt 0 10pt; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #777; padding: 5pt 7pt; text-align: left; }
    th { background: #0e8a43; color: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  </style></head><body>${pages || `<p>${esc(t('schedule.nothing'))}</p>`}</body></html>`;
}
