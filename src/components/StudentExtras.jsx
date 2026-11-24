// Student page tabs: «Փոխկապակցված անձինք» (linked students — brothers, sisters…) and
// «Գործողություններ» (everything that happened with the student).
import { useState } from 'react';
import { UserPlus, Link2, Unlink } from 'lucide-react';
import { useT, monthName } from '../i18n';
import { useCan } from './Auth';
import { useRpc, rpc, fmtDate, fmtDateTime, money } from '../lib';
import { Avatar, Badge, Button, Empty, Field, Loading, Modal, Money, SearchBox, useAction, useClub, useConfirm } from './ui';
import { useStudentForm } from './StudentFormHost';
import { useEditLock } from './Locks';

const RELATIONS = ['sibling', 'cousin', 'other'];

// ---------------------------------------------------------------- linked students
export function RelatedTab({ student, related, nav }) {
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const canEdit = useCan('students');
  const canPay = useCan('payments');
  const [modal, setModal] = useState(null); // 'link'
  const studentForm = useStudentForm();

  // A brother / sister: the family details come from this student, the category is «2 և ավել երեխա».
  const sibling = {
    last_name: student.last_name,
    patronymic: student.patronymic,
    category: 'siblings',
    ...Object.fromEntries(
      ['parent_first_name', 'parent_last_name', 'parent_phone', 'parent_messenger', 'parent_email', 'parent_ssn', 'parent_doc_no', 'parent_doc_issuer', 'parent_doc_date', 'parent_address', 'address', 'phone'].map((k) => [
        k,
        student[k],
      ])
    ),
  };
  const unlink = async (r) => {
    if (await confirm({ title: t('related.unlink'), text: t('related.unlinkConfirm', { name: `${r.first_name} ${r.last_name}` }), confirmLabel: t('related.unlink') }))
      act(() => rpc('students.unlink', { id: student.id, otherId: r.id }), t('common.saved'));
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      {canEdit && (
        <div className="row">
          <div className="small muted grow">{t('related.hint')}</div>
          <Button icon={Link2} onClick={() => setModal('link')}>
            {t('related.linkExisting')}
          </Button>
          <Button variant="primary" icon={UserPlus} onClick={() =>
              studentForm.open(sibling, {
                onSaved: (id) => act(() => rpc('students.link', { id: student.id, otherId: id, relation: 'sibling' }), t('related.linked')),
              })
            }>
            {t('related.addSibling')}
          </Button>
        </div>
      )}
      {!related.length ? (
        <div className="card">
          <Empty icon={Link2} title={t('related.empty')} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('students.name')}</th>
                <th>{t('related.relation')}</th>
                <th>{t('students.group')}</th>
                <th>{t('students.birthDate')}</th>
                <th>{t('students.category')}</th>
                <th>{t('students.contractNo')}</th>
                <th>{t('students.status')}</th>
                {canPay && <th className="num">{t('students.overdue')}</th>}
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {related.map((r) => (
                <tr key={r.id} className="click" onClick={() => nav('students', { id: r.id })}>
                  <td>
                    <div className="cell-person">
                      <Avatar first={r.first_name} last={r.last_name} seed={r.id} size={28} />
                      <span className="name nowrap">{[r.first_name, r.last_name, r.patronymic].filter(Boolean).join(' ')}</span>
                    </div>
                  </td>
                  <td className="nowrap">{r.relation ? t(`relation.${r.relation}`) : <span className="muted">{t('related.indirect')}</span>}</td>
                  <td className="nowrap">
                    {r.group_name ? (
                      <span className="row nowrap" style={{ gap: 7 }}>
                        <span className="dot" style={{ background: r.group_color || undefined }} />
                        {r.group_name}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="nowrap">{fmtDate(r.birth_date)}</td>
                  <td>{r.category ? t(`category.${r.category}`) : <span className="muted">—</span>}</td>
                  <td className="nowrap">{r.contract_no || <span className="muted">—</span>}</td>
                  <td>
                    <Badge tone={r.status === 'active' ? 'accent' : ''}>{t(`status.${r.status}`)}</Badge>
                  </td>
                  {canPay && (
                    <td className="num">{r.overdue > 0 ? <Money value={r.overdue} className="strong" /> : <span className="muted">—</span>}</td>
                  )}
                  {canEdit && (
                    <td onClick={(e) => e.stopPropagation()}>
                      {r.direct && <Button size="sm" variant="ghost" icon={Unlink} title={t('related.unlink')} onClick={() => unlink(r)} />}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {modal === 'link' && <LinkModal student={student} exclude={[student.id, ...related.map((r) => r.id)]} onClose={() => setModal(null)} />}
    </div>
  );
}

function LinkModal({ student, exclude, onClose }) {
  const t = useT();
  const act = useAction();
  const lock = useEditLock(`student:${student.id}`);
  const [search, setSearch] = useState(student.last_name || '');
  const [picked, setPicked] = useState(null);
  const [relation, setRelation] = useState('sibling');
  const [setCategory, setSetCategory] = useState(true);
  const { data } = useRpc('students.list', { search: search.trim() || null, status: null });
  const list = (data || []).filter((s) => !exclude.includes(s.id)).slice(0, 30);
  const save = async () => {
    if (await act(() => rpc('students.link', { id: student.id, otherId: picked.id, relation, setCategory: relation === 'sibling' && setCategory }), t('related.linked')))
      onClose();
  };
  return (
    <Modal
      title={t('related.linkTitle', { name: `${student.first_name} ${student.last_name}` })}
      lock={lock}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={Link2} onClick={save} disabled={!picked}>
            {t('related.link')}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <SearchBox value={search} onChange={setSearch} placeholder={t('students.searchPlaceholder')} />
        <div className="card" style={{ maxHeight: 260, overflow: 'auto' }}>
          <div className="list">
            {!data ? (
              <Loading />
            ) : list.length ? (
              list.map((s) => (
                <label key={s.id} className={`list-item click ${picked?.id === s.id ? 'on' : ''}`} style={{ padding: '7px 12px', gap: 10 }}>
                  <input type="radio" checked={picked?.id === s.id} onChange={() => setPicked(s)} />
                  <span className="grow">
                    {[s.first_name, s.last_name, s.patronymic].filter(Boolean).join(' ')}
                    <span className="small muted"> · {s.group_name || '—'} · {fmtDate(s.birth_date)}</span>
                  </span>
                </label>
              ))
            ) : (
              <div className="small muted" style={{ padding: 12 }}>{t('related.noneFound')}</div>
            )}
          </div>
        </div>
        <div className="grid-2">
          <Field label={t('related.relation')}>
            <select className="select" value={relation} onChange={(e) => setRelation(e.target.value)}>
              {RELATIONS.map((r) => (
                <option key={r} value={r}>
                  {t(`relation.${r}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {relation === 'sibling' && (
          <label className="check">
            <input type="checkbox" checked={setCategory} onChange={(e) => setSetCategory(e.target.checked)} />
            {t('related.setCategory', { name: picked ? `${picked.first_name} ${picked.last_name}` : '…' })}
          </label>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- history
const KIND = (a) => (a.startsWith('charge.') ? 'payments' : a.startsWith('attendance.') ? 'attendance' : a.startsWith('file.') || a.startsWith('application.') || a.startsWith('contract.') ? 'documents' : 'details');
const FILTERS = ['all', 'details', 'payments', 'attendance', 'documents'];

export function HistoryTab({ student }) {
  const t = useT();
  const [filter, setFilter] = useState('all');
  const { data } = useRpc('students.history', { id: student.id });
  if (!data) return <Loading />;
  const rows = data.filter((e) => filter === 'all' || KIND(e.action) === filter);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row">
        <div className="seg">
          {FILTERS.map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {t(`history.filter_${f}`)}
            </button>
          ))}
        </div>
        <div className="grow" />
        <span className="small muted">{t('history.count', { n: rows.length })}</span>
      </div>
      {!rows.length ? (
        <div className="card">
          <Empty title={t('history.empty')} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('activity.when')}</th>
                <th>{t('activity.who')}</th>
                <th>{t('activity.what')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <HistoryRow key={e.id || `d${i}`} e={e} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HistoryRow({ e }) {
  const t = useT();
  const { currency } = useClub();
  const m = e.meta || {};
  const charge = () => {
    const what = m.kind === 'monthly' ? `${t('charge.monthly')} · ${monthName(t, m.period)}` : m.description || t(`charge.${m.kind || 'other'}`);
    return [what, m.amount != null ? money(m.amount, currency) : null, m.method ? t(`method.${m.method}`) : null, m.hdm ? `ՀԴՄ № ${m.hdm}` : null].filter(Boolean).join(' · ');
  };
  const field = (k) => {
    const key = { first_name: 'students.firstName', last_name: 'students.lastName', patronymic: 'students.patronymic', birth_date: 'students.birthDate', document_no: 'students.documentNo', contract_no: 'students.contractNo', category: 'students.category', service: 'students.service', medical_doc: 'students.medicalDoc', group: 'students.group', monthly_fee: 'students.monthlyFee', join_date: 'students.joinDate', status: 'students.status', inactive_reason: 'students.inactiveReason', leave_date: 'students.leaveDate', notes: 'students.notes', parent_first_name: 'parent.firstName', parent_last_name: 'parent.lastName', parent_phone: 'parent.phone', parent_messenger: 'parent.messenger', parent_email: 'parent.email', parent_ssn: 'parent.ssn', parent_doc_no: 'parent.docNo', parent_doc_issuer: 'parent.docIssuer', parent_doc_date: 'parent.docDate', parent_address: 'parent.address', phone: 'students.phone', email: 'students.email', address: 'students.address', photo: 'students.photo' }[k];
    return key ? t(key) : k;
  };
  const value = (k, v) => {
    if (v === '' || v == null) return '—';
    if (k === 'category') return t(`category.${v}`);
    if (k === 'status') return t(`status.${v}`);
    if (k === 'medical_doc') return t(Number(v) ? 'medicalDoc.provided' : 'medicalDoc.missing');
    if (/date$/.test(k)) return fmtDate(v);
    if (k === 'monthly_fee') return money(v, currency);
    return String(v);
  };
  let detail = e.details || '';
  if (e.action.startsWith('charge.')) detail = charge();
  if (e.action === 'charge.hdm') detail = `${charge()} · ${t('hdm.receiptNo')} ${m.receipt}${m.fiscal ? ` · ${t('hdm.fiscalNo')} ${m.fiscal}` : ''}`;
  if (e.action === 'charge.hdmReturned') detail = `${charge()} · ${t('hdm.receiptNo')} ${m.receipt} → ${m.returnNo || ''}`;
  if (e.action === 'charge.updated' && m.before) detail = `${charge()} (${t('history.was')} ${money(m.before.amount, currency)})`;
  if (e.action === 'attendance.mark') detail = `${fmtDate(m.date)} · ${t(`att.${m.status}`)}`;
  if (e.action === 'attendance.changed') detail = `${fmtDate(m.date)} · ${m.from ? t(`att.${m.from}`) : '—'} → ${m.to ? t(`att.${m.to}`) : t('history.removed')}`;
  if (e.action === 'file.uploaded' || e.action === 'file.deleted') detail = m.name || detail;
  if (e.action === 'application.created') detail = `${fmtDate(m.from)} – ${fmtDate(m.to)}${m.reason ? ` · ${m.reason}` : ''}`;
  if (e.action.startsWith('contract.')) detail = m.number ? `№ ${m.number}` : '';
  if (e.action === 'student.linked' || e.action === 'student.unlinked') detail = `${m.other || ''}${m.relation ? ` · ${t(`relation.${m.relation}`)}` : ''}`;
  if (e.action === 'student.terminated') detail = `${fmtDate(m.date)}${m.reason ? ` · ${m.reason}` : ''}`;
  if (e.action === 'student.transferred' || e.action === 'student.transferUpdated') detail = m.file || '';
  return (
    <tr>
      <td className="small nowrap">{e.action === 'attendance.mark' ? fmtDate(m.date) : fmtDateTime(e.at)}</td>
      <td className="small">{e.user || <span className="muted">—</span>}</td>
      <td className="small">
        <span className="strong">{t(`history.${e.action}`) === `history.${e.action}` ? t(`activity.${e.action}`) : t(`history.${e.action}`)}</span>
        {detail && <span className="muted"> · {detail}</span>}
        {e.action === 'student.updated' && Array.isArray(m.changes) && (
          <div className="history-changes">
            {m.changes.map(([k, a, b], i) => (
              <div key={i}>
                {field(k)}: <span className="muted">{value(k, a)}</span> → <span className="strong">{value(k, b)}</span>
              </div>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}
