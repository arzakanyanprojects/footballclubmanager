import { useState } from 'react';
import { Plus, Shapes, Users, UserRound, UserPlus, Pencil, Trash2 } from 'lucide-react';
import { useT } from '../i18n';
import { useCan } from '../components/Auth';
import { useRpc, rpc } from '../lib';
import { Badge, Button, Empty, Field, Loading, Modal, Money, RowMenu, useAction, useConfirm } from '../components/ui';

const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

export default function Groups({ nav }) {
  const canEdit = useCan('groups');
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const { data, loading } = useRpc('groups.list');
  const [editing, setEditing] = useState(null);

  return (
    <>
      <div className="page-head sticky-head">
        <div>
          <h1>{t('nav.groups')}</h1>
          <div className="sub">{t('groups.subtitle')}</div>
        </div>
        <div className="spacer" />
        {canEdit && (
          <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
            {t('groups.add')}
          </Button>
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
      ) : (
        <div className="group-grid">
          {data.map((g) => (
            <div key={g.id} className="card group-card" style={{ opacity: g.archived ? 0.6 : 1, borderTop: `3px solid ${g.color || 'var(--border-strong)'}` }}>
              <div className="card-head" style={{ borderBottom: 0, paddingBottom: 2 }}>
                <h3 className="grow">{g.name}</h3>
                {g.archived ? <Badge>{t('groups.archived')}</Badge> : null}
                {canEdit && <RowMenu
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
                />}
              </div>
              <div className="card-pad stack" style={{ gap: 6, paddingTop: 4 }}>
                <div className="row small">
                  <UserRound size={14} className="muted" />
                  <span className="grow">
                    {g.coach || <span className="muted">{t('groups.noCoach')}</span>}
                    <div className="small muted">
                      {t('groups.coach')}
                      {g.coach_phone && <span className="nowrap"> · {g.coach_phone}</span>}
                    </div>
                  </span>
                </div>
                <div className="row small">
                  <UserPlus size={14} className="muted" />
                  <span className="grow">
                    {g.assistant || <span className="muted">—</span>}
                    <div className="small muted">
                      {t('groups.assistant')}
                      {g.assistant_phone && <span className="nowrap"> · {g.assistant_phone}</span>}
                    </div>
                  </span>
                </div>
                <div className="row" style={{ marginTop: 2 }}>
                  <Button size="sm" icon={Users} onClick={() => nav('students', { groupId: g.id })}>
                    {t('groups.students', { n: g.student_count })}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && <GroupModal group={editing} onClose={() => setEditing(null)} />}
    </>
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
