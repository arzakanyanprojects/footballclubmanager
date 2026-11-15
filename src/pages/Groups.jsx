import { useState } from 'react';
import { Plus, Shapes, Users, Pencil, Trash2, LayoutGrid, List, CalendarCheck } from 'lucide-react';
import { useT } from '../i18n';
import { useCan } from '../components/Auth';
import { useRpc, rpc } from '../lib';
import { Badge, Button, Empty, Field, Loading, Modal, Money, RowMenu, SearchBox, useAction, useConfirm, useToast } from '../components/ui';

const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

export default function Groups({ nav }) {
  const canEdit = useCan('groups');
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const { data, loading } = useRpc('groups.list');
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState('');
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem('fc.groups.view') || 'cards';
    } catch {
      return 'cards';
    }
  });
  const changeView = (v) => {
    setView(v);
    try {
      localStorage.setItem('fc.groups.view', v);
    } catch {
      /* per-PC convenience only */
    }
  };

  const q = search.trim().toLowerCase();
  const rows = (data || []).filter(
    (g) => !q || [g.name, g.coach, g.assistant].some((v) => String(v || '').toLowerCase().includes(q))
  );
  const active = (data || []).filter((g) => !g.archived);
  const totalStudents = active.reduce((s, g) => s + g.student_count, 0);

  const menu = (g) =>
    canEdit && (
      <RowMenu
        items={[
          { label: t('common.edit'), icon: Pencil, onClick: () => setEditing(g) },
          {
            label: t('common.delete'),
            icon: Trash2,
            danger: true,
            onClick: async () =>
              (await confirm({ text: t('groups.deleteConfirm', { name: g.name }), confirmLabel: t('common.delete') })) &&
              act(() => rpc('groups.delete', { id: g.id }), t('common.deleted')),
          },
        ]}
      />
    );
  const copyPhone = (phone) => {
    navigator.clipboard?.writeText(phone).then(() => toast.success(t('groups.phoneCopied', { phone })));
  };
  const open = {
    students: (g) => nav('students', { groupId: g.id }),
    attendance: (g) => nav('attendance', { groupId: g.id }),
  };

  return (
    <>
      <div className="sticky-head">
      <div className="page-head" style={{ marginBottom: data?.length ? 14 : 0 }}>
        <div>
          <h1>{t('nav.groups')}</h1>
          <div className="sub">
            {data ? t('groups.summary', { groups: active.length, students: totalStudents }) : t('groups.subtitle')}
          </div>
        </div>
        <div className="spacer" />
        {canEdit && (
          <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
            {t('groups.add')}
          </Button>
        )}
      </div>

      {data?.length > 0 && (
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <SearchBox value={search} onChange={setSearch} placeholder={t('groups.search')} />
          <div className="grow" />
          <div className="seg">
            {[
              ['cards', LayoutGrid, t('groups.viewCards')],
              ['list', List, t('groups.viewList')],
            ].map(([v, Icon, label]) => (
              <button key={v} className={view === v ? 'on' : ''} onClick={() => changeView(v)}>
                <Icon size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      </div>

      {loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <div className="card">
          <Empty
            icon={Shapes}
            title={t('groups.empty')}
            text={t('groups.emptyText')}
            action={canEdit && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>{t('groups.add')}</Button>}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="card">
          <Empty icon={Shapes} title={t('groups.noMatch')} text={t('common.tryFilters')} />
        </div>
      ) : view === 'list' ? (
        <div className="table-wrap">
          <table className="table group-table">
            <thead>
              <tr>
                <th>{t('groups.name')}</th>
                <th>{t('groups.coach')}</th>
                <th>{t('groups.assistant')}</th>
                <th className="num">{t('groups.studentsCol')}</th>
                <th>{t('groups.trainings')}</th>
                <th className="actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const { age, year } = splitName(g.name);
                return (
                  <tr key={g.id} className={`click ${g.archived ? 'archived' : ''}`} onClick={() => open.students(g)}>
                    <td>
                      <span className="row nowrap" style={{ gap: 10 }}>
                        <span className="group-swatch" style={{ background: g.color || 'var(--border-strong)' }} />
                        <span className="strong">{age}</span>
                        {year && <span className="group-year">{year}</span>}
                        {!!g.archived && <Badge>{t('groups.archived')}</Badge>}
                      </span>
                    </td>
                    <td>
                      <PersonLine name={g.coach} phone={g.coach_phone} empty={t('groups.noCoach')} onCopy={copyPhone} compact />
                    </td>
                    <td>
                      <PersonLine name={g.assistant} phone={g.assistant_phone} empty="—" onCopy={copyPhone} compact />
                    </td>
                    <td className="num strong">{g.student_count}</td>
                    <td style={{ minWidth: 150 }}>
                      <Progress done={g.days_filled} total={g.days_total} />
                    </td>
                    <td className="actions" onClick={(e) => e.stopPropagation()}>
                      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <Button size="sm" icon={CalendarCheck} onClick={() => open.attendance(g)} title={t('groups.openAttendance')} />
                        {menu(g)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="group-grid">
          {rows.map((g) => {
            const { age, year } = splitName(g.name);
            const color = g.color || '#8a929b';
            return (
              <div
                key={g.id}
                className={`card group-card ${g.archived ? 'archived' : ''}`}
                style={{ '--g': color }}
                role="button"
                tabIndex={0}
                title={t('groups.openStudents')}
                onClick={() => open.students(g)}
                onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && open.students(g)}
              >
                <div className="group-card-top">
                  <div className="group-title">
                    <span className="group-age">{age}</span>
                    {year && <span className="group-year">{year}</span>}
                    {!!g.archived && <Badge>{t('groups.archived')}</Badge>}
                  </div>
                  {menu(g)}
                </div>
                <div className="group-people">
                  <PersonLine role={t('groups.coach')} name={g.coach} phone={g.coach_phone} empty={t('groups.noCoach')} onCopy={copyPhone} />
                  <PersonLine role={t('groups.assistant')} name={g.assistant} phone={g.assistant_phone} empty="—" onCopy={copyPhone} />
                </div>
                <div className="group-stats">
                  <button
                    className="group-stat"
                    onClick={(e) => {
                      e.stopPropagation();
                      open.students(g);
                    }}
                  >
                    <Users size={16} />
                    <span className="sv">
                      <span className="v">{g.student_count}</span>
                      <span className="l">{t('groups.studentsCol')}</span>
                    </span>
                  </button>
                  <button
                    className="group-stat"
                    onClick={(e) => {
                      e.stopPropagation();
                      open.attendance(g);
                    }}
                  >
                    <CalendarCheck size={16} />
                    <span className="sv">
                      <span className="v">
                        {g.days_filled}/{g.days_total}
                      </span>
                      <span className="l">{t('groups.trainingsShort')}</span>
                    </span>
                  </button>
                </div>
                <div className="group-bar" title={t('groups.trainingsHint', { done: g.days_filled, total: g.days_total })}>
                  <span style={{ width: `${g.days_total ? Math.round((g.days_filled / g.days_total) * 100) : 0}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && <GroupModal group={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

// "U10 (2016)" → { age: 'U10', year: '2016' }; other names stay whole.
function splitName(name) {
  const m = String(name || '').match(/^(.*?)\s*\((\d{4})\)\s*$/);
  return m ? { age: m[1], year: m[2] } : { age: name, year: '' };
}

function PersonLine({ role, name, phone, empty, onCopy, compact }) {
  const parts = String(name || '').trim().split(/\s+/);
  return (
    <div className={`person-line ${compact ? 'compact' : ''}`}>
      {!compact && (
        <span className={`person-ava ${name ? '' : 'none'}`}>{name ? `${parts[0]?.[0] || ''}${parts[1]?.[0] || ''}` : '?'}</span>
      )}
      <span className="person-text">
        <span className={name ? 'person-name' : 'person-name muted'}>{name || empty}</span>
        {(role || phone) && (
          <span className="person-sub">
            {role}
            {role && phone ? ' · ' : ''}
            {phone && (
              <button
                className="phone-link"
                title={phone}
                onClick={(e) => {
                  e.stopPropagation();
                  onCopy(phone);
                }}
              >
                {phone}
              </button>
            )}
          </span>
        )}
      </span>
    </div>
  );
}

function Progress({ done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="row" style={{ gap: 8 }}>
      <div className="group-bar inline">
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="small muted nowrap">
        {done}/{total}
      </span>
    </div>
  );
}

function GroupModal({ group, onClose }) {
  const t = useT();
  const act = useAction();
  const [f, setF] = useState({ name: '', coach: '', coach_phone: '', assistant: '', assistant_phone: '', color: COLORS[0], archived: 0, ...group });
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  const save = async () => {
    if (await act(() => rpc('groups.save', f), t('common.saved'))) onClose();
  };
  return (
    <Modal
      title={group.id ? t('groups.edit') : t('groups.add')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!f.name?.trim()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('groups.name')}>
          <input className="input" autoFocus value={f.name} placeholder={t('groups.namePlaceholder')} onChange={set('name')} />
        </Field>
        <div className="grid-2">
          <Field label={t('groups.coach')}>
            <input className="input" value={f.coach || ''} onChange={set('coach')} />
          </Field>
          <Field label={t('groups.coachPhone')}>
            <input className="input" value={f.coach_phone || ''} onChange={set('coach_phone')} />
          </Field>
          <Field label={t('groups.assistant')}>
            <input className="input" value={f.assistant || ''} onChange={set('assistant')} />
          </Field>
          <Field label={t('groups.assistantPhone')}>
            <input className="input" value={f.assistant_phone || ''} onChange={set('assistant_phone')} />
          </Field>
        </div>
        <Field label={t('groups.color')}>
          <div className="row">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => set('color')(c)}
                style={{
                  width: 28, height: 28, borderRadius: 8, background: c, cursor: 'pointer',
                  border: f.color === c ? '3px solid var(--text)' : '3px solid transparent',
                }}
                aria-label={c}
              />
            ))}
          </div>
        </Field>
        {group.id && (
          <label className="check">
            <input type="checkbox" checked={!!f.archived} onChange={(e) => set('archived')(e.target.checked)} />
            {t('groups.archiveLabel')}
          </label>
        )}
      </div>
    </Modal>
  );
}
