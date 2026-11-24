import { useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Pencil, Plus, FileSignature, Trash2, Phone, Cake, Shapes, CalendarPlus, Wallet, CalendarCheck, IdCard, UserRound, FileText, Users, StickyNote, FolderOpen, Upload, ExternalLink, Download, Stethoscope, FilePlus2, Printer, UserX, Link2, History,
} from 'lucide-react';
import { useT } from '../i18n';
import { useCan } from '../components/Auth';
import { useRpc, rpc, age, fmtDate, fmtDateTime, money, readFileBase64, fileSize, todayIso } from '../lib';
import { Avatar, Badge, Button, Empty, Field, Loading, Modal, Money, Tabs, useAction, useClub, useConfirm } from '../components/ui';
import { StudentForm, FormSection } from './Students';
import { AbsenceModal, printStoredFile, openStoredFile } from '../components/Absence';
import { ChargesTable, MonthlyPaymentModal, chargeStatus } from './Payments';
import { NewContractModal, ContractModal, CONTRACT_TONE } from './Contracts';
import { RelatedTab, HistoryTab } from '../components/StudentExtras';
import { useEditLock } from '../components/Locks';

export default function StudentProfile({ id, nav }) {
  const canEdit = useCan('students');
  const canPay = useCan('payments');
  const canContracts = useCan('contracts');
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const { currency } = useClub();
  const { data, error } = useRpc('students.get', { id });
  const [tab, setTab] = useState('info');
  const [modal, setModal] = useState(null);

  const totals = useMemo(() => {
    const c = data?.charges || [];
    const sum = (f) => c.filter(f).reduce((s, x) => s + x.amount, 0);
    return {
      overdue: sum((x) => chargeStatus(x) === 'overdue'),
      unpaid: sum((x) => x.status === 'unpaid'),
      paid: sum((x) => x.status === 'paid'),
    };
  }, [data]);

  if (error) return <Empty title={t('error.NOT_FOUND')} action={<Button onClick={() => nav('students')}>{t('common.back')}</Button>} />;
  if (!data) return <Loading />;
  const s = data.student;
  const st = data.attendanceStats;

  const remove = async () => {
    const ok = await confirm({
      title: t('students.deleteTitle'),
      text: t('students.deleteConfirm', { name: `${s.first_name} ${s.last_name}` }),
      confirmLabel: t('common.delete'),
    });
    if (ok && (await act(() => rpc('students.delete', { id }), t('common.deleted')))) nav('students');
  };

  return (
    <>
      <div className="page-head">
        <Button variant="ghost" icon={ArrowLeft} onClick={() => nav('students')}>
          {t('nav.students')}
        </Button>
        <div className="spacer" />
        {canEdit && (
          <>
            <Button icon={Trash2} variant="danger" onClick={remove}>
              {t('common.delete')}
            </Button>
            <Button icon={Pencil} onClick={() => setModal('edit')}>
              {t('common.edit')}
            </Button>
          </>
        )}
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="profile-head">
          <Avatar first={s.first_name} last={s.last_name} photo={s.photo} seed={s.id} size={84} />
          <div className="grow">
            <div className="row">
              <h2>
                {s.first_name} {s.last_name}
                {s.patronymic ? ` ${s.patronymic}` : ''}
              </h2>
              <Badge tone={s.status === 'active' ? 'accent' : ''}>{t(`status.${s.status}`)}</Badge>
            </div>
            <div className="profile-meta">
              <span>
                <Shapes size={15} />
                {s.group_name || t('students.noGroup')}
              </span>
              {s.birth_date && (
                <span>
                  <Cake size={15} />
                  {fmtDate(s.birth_date)} · {t('students.years', { n: age(s.birth_date) })}
                </span>
              )}
              {(s.parent_phone || s.phone) && (
                <span>
                  <Phone size={15} />
                  {s.parent_phone || s.phone}
                  {s.parent_name ? ` (${s.parent_name})` : ''}
                </span>
              )}
              <span>
                <CalendarPlus size={15} />
                {t('students.since', { date: fmtDate(s.join_date) })}
              </span>
            </div>
          </div>
          {(canPay || canEdit) && (
            <div className="stack" style={{ gap: 8 }}>
              {canPay && (
                <Button variant="primary" icon={Plus} onClick={() => setModal('charge')}>
                  {t('payments.newCharge')}
                </Button>
              )}
              {canEdit && (
                <div className="row nowrap" style={{ gap: 8 }}>
                  <Button icon={FilePlus2} onClick={() => setModal('absence')}>
                    {t('absence.button')}
                  </Button>
                  {s.status === 'active' && (
                    <Button variant="danger" icon={UserX} onClick={() => setModal('terminate')}>
                      {t('terminate.button')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="balance-strip">
          <div>
            <div className="label">{t('students.overdue')}</div>
            <div className="value" style={{ color: totals.overdue ? 'var(--bad)' : undefined }}>
              {money(totals.overdue, currency)}
            </div>
          </div>
          <div>
            <div className="label">{t('students.unpaidTotal')}</div>
            <div className="value">{money(totals.unpaid, currency)}</div>
          </div>
          <div>
            <div className="label">{t('students.monthlyFee')}</div>
            <div className="value">{money(s.monthly_fee, currency)}</div>
          </div>
        </div>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'info', label: t('students.details'), icon: IdCard },
          { id: 'payments', label: t('nav.payments'), icon: Wallet, count: data.charges.filter((c) => c.status === 'unpaid').length || null },
          { id: 'attendance', label: t('nav.attendance'), icon: CalendarCheck },
          { id: 'contracts', label: t('files.tab'), icon: FolderOpen, count: data.contracts.length + (data.files || []).length || null },
          { id: 'related', label: t('related.tab'), icon: Link2, count: (data.related || []).length || null },
          { id: 'history', label: t('history.tab'), icon: History },
        ]}
      />

      {tab === 'payments' &&
        (data.charges.length ? (
          <ChargesTable rows={data.charges} student={s} />
        ) : (
          <div className="card">
            <Empty icon={Wallet} title={t('students.noCharges')} text={s.monthly_fee ? '' : t('students.noFeeHint')} />
          </div>
        ))}

      {tab === 'attendance' && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="stats" style={{ marginBottom: 0 }}>
            {['present', 'late', 'absent', 'excused'].map((k) => (
              <div className="card stat" key={k}>
                <div className="stat-top">{t(`att.${k}`)}</div>
                <div className="stat-value">{st[k] || 0}</div>
                <div className="stat-sub">{t('students.last90')}</div>
              </div>
            ))}
          </div>
          <div className="card">
            <div className="card-head">
              <h3>{t('students.recentAttendance')}</h3>
              <div className="spacer" />
              {st.total > 0 && (
                <span className="small muted">
                  {t('students.attendanceRate', { pct: Math.round((((st.present || 0) + (st.late || 0)) / st.total) * 100) })}
                </span>
              )}
            </div>
            {data.attendance.length === 0 ? (
              <Empty title={t('students.noAttendance')} />
            ) : (
              <div className="card-pad att-dots">
                {data.attendance.map((a) => (
                  <span key={a.date} className={`att-cell ${a.status}`} style={{ width: 'auto', padding: '0 8px' }} title={t(`att.${a.status}`)}>
                    {fmtDate(a.date).slice(0, 5)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'contracts' && (
        <>
          <StudentFiles student={s} files={data.files || []} canEdit={canEdit} />
          <div className="toolbar" style={{ marginTop: 18 }}>
            <h3 className="row" style={{ gap: 8, fontSize: 15 }}>
              <FileSignature size={17} /> {t('nav.contracts')}
            </h3>
            <div className="grow" />
            {canContracts && (
              <Button variant="primary" icon={FileSignature} onClick={() => setModal('contract')}>
                {t('contracts.new')}
              </Button>
            )}
          </div>
          {data.contracts.length === 0 ? (
            <div className="card">
              <Empty icon={FileSignature} title={t('contracts.empty')} />
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>№</th>
                    <th>{t('contracts.template')}</th>
                    <th>{t('contracts.contractDate')}</th>
                    <th>{t('payments.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.contracts.map((c) => (
                    <tr key={c.id} className="click" onClick={() => setModal({ contract: c.id })}>
                      <td className="strong">{c.number}</td>
                      <td>{c.title}</td>
                      <td className="nowrap">
                        {fmtDate(c.contract_date || c.start_date)}
                      </td>
                      <td>
                        <Badge tone={CONTRACT_TONE[c.status]}>{t(`contractStatus.${c.status}`)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'related' && <RelatedTab student={s} related={data.related || []} nav={nav} />}
      {tab === 'history' && <HistoryTab student={s} />}

      {tab === 'info' && (
        <div className="card card-pad details-form">
          {canEdit && (
            <div className="details-edit">
              <Button size="sm" icon={Pencil} onClick={() => setModal('edit')}>
                {t('common.edit')}
              </Button>
            </div>
          )}
          <FormSection icon={UserRound} title={t('form.student')}>
            <div className="grid-3">
              <Ro label={t('students.firstName')} value={s.first_name} />
              <Ro label={t('students.lastName')} value={s.last_name} />
              <Ro label={t('students.patronymic')} value={s.patronymic} />
              <Ro label={t('students.birthDate')} value={fmtDate(s.birth_date)} />
            </div>
          </FormSection>
          <FormSection icon={FileText} title={t('form.documents')}>
            <div className="grid-3">
              <Ro label={t('students.documentNo')} value={s.document_no} />
              <Ro label={t('students.contractNo')} value={s.contract_no} />
              <Ro
                label={t('students.medicalDoc')}
                value={
                  <Badge tone={s.medical_doc ? 'good' : 'warn'}>{t(s.medical_doc ? 'medicalDoc.provided' : 'medicalDoc.missing')}</Badge>
                }
              />
            </div>
          </FormSection>
          <FormSection icon={Users} title={t('form.parent')}>
            <div className="grid-3">
              <Ro label={t('parent.firstName')} value={s.parent_first_name} />
              <Ro label={t('parent.lastName')} value={s.parent_last_name} />
              <Ro label={t('parent.ssn')} value={s.parent_ssn} />
              <Ro label={t('parent.docNo')} value={s.parent_doc_no} />
              <Ro label={t('parent.docIssuer')} value={s.parent_doc_issuer} />
              <Ro label={t('parent.docDate')} value={fmtDate(s.parent_doc_date)} />
              <Ro label={t('parent.phone')} value={s.parent_phone} />
              <Ro label={t('parent.messenger')} value={s.parent_messenger} />
              <Ro label={t('parent.email')} value={s.parent_email} />
              <Ro label={t('parent.address')} value={s.parent_address} className="span-3" />
            </div>
          </FormSection>
          <FormSection icon={Wallet} title={t('form.training')}>
            <div className="grid-3">
              <Ro label={t('students.group')} value={s.group_name} />
              {canPay && <Ro label={t('students.monthlyFee')} value={money(s.monthly_fee, currency)} />}
              <Ro label={t('students.joinDate')} value={fmtDate(s.join_date)} />
              <Ro label={t('students.service')} value={s.service} />
              <Ro label={t('students.category')} value={s.category ? t(`category.${s.category}`) : ''} />
              <Ro label={t('students.status')} value={t(`status.${s.status}`)} />
              {s.status === 'inactive' && <Ro label={t('students.inactiveReason')} value={s.inactive_reason} className="span-2" />}
              {s.leave_date && <Ro label={t('students.leaveDate')} value={fmtDate(s.leave_date)} />}
            </div>
          </FormSection>
          <FormSection icon={StickyNote} title={t('students.notes')}>
            <div className="ro-field ro-multi">{s.notes || <span className="muted">—</span>}</div>
            <div className="small muted">{t('students.createdAt')}: {fmtDateTime(s.created_at)}</div>
          </FormSection>
        </div>
      )}

      {modal === 'edit' && <StudentForm student={s} onClose={() => setModal(null)} onSaved={() => setModal(null)} />}
      {modal === 'charge' && <MonthlyPaymentModal student={s} charges={data.charges} onClose={() => setModal(null)} />}
      {modal === 'absence' && <AbsenceModal student={s} onClose={() => setModal(null)} />}
      {modal === 'terminate' && <TerminateModal student={s} onClose={() => setModal(null)} />}
      {modal === 'contract' && (
        <NewContractModal studentId={s.id} onClose={() => setModal(null)} onCreated={(cid) => setModal({ contract: cid })} />
      )}
      {modal?.contract && <ContractModal id={modal.contract} onClose={() => setModal(null)} />}
    </>
  );
}

// «Դադարեցում»: the date the student stops; they become inactive from it.
function TerminateModal({ student, onClose }) {
  const t = useT();
  const act = useAction();
  const lock = useEditLock(`student:${student.id}`);
  const [date, setDate] = useState(todayIso());
  const [reason, setReason] = useState('');
  const save = async () => {
    if (await act(() => rpc('students.terminate', { id: student.id, date, reason }), t('terminate.done'))) onClose();
  };
  return (
    <Modal
      title={t('terminate.title', { name: `${student.first_name} ${student.last_name}` })}
      lock={lock}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger-solid" icon={UserX} onClick={save} disabled={!date}>
            {t('terminate.confirm')}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <div className="muted small">{t('terminate.text')}</div>
        <Field label={t('students.leaveDate')}>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} autoFocus />
        </Field>
        <Field label={t('terminate.reason')}>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// A filled-in form field, read only (the Details tab mirrors the student form).
function Ro({ label, value, className = '' }) {
  const empty = value == null || value === '';
  return (
    <div className={`field ${className}`}>
      <label>{label}</label>
      <div className={`ro-field ${empty ? 'empty' : ''}`}>{empty ? '—' : value}</div>
    </div>
  );
}

// Documents uploaded for the student (medical certificate and others).
function StudentFiles({ student, files, canEdit }) {
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const pickRef = useRef(null);
  const [kind, setKind] = useState('medical');

  const upload = (k) => {
    setKind(k);
    pickRef.current.click();
  };
  const open = (f) => act(() => openStoredFile(f.id));
  const print = (f) => act(() => printStoredFile(f.id), t('absence.printing'));
  const download = (f) =>
    act(async () => {
      const r = await rpc('files.get', { id: f.id });
      const res = await window.fc.saveBinary({ defaultName: r.fileName, data: r.data, filters: [] });
      if (!res.ok && res.error !== 'CANCELLED') throw Object.assign(new Error(res.error), { code: res.error });
    });
  const remove = async (f) => {
    if (await confirm({ title: t('files.deleteTitle'), text: t('files.deleteText', { name: f.file_name }), confirmLabel: t('common.delete') }))
      act(() => rpc('files.delete', { id: f.id }), t('common.deleted'));
  };

  return (
    <div className="card">
      <div className="card-head">
        <Stethoscope size={17} />
        <h3>{t('files.title')}</h3>
        <div className="spacer" />
        <Badge tone={student.medical_doc ? 'good' : 'warn'}>{t(student.medical_doc ? 'medicalDoc.provided' : 'medicalDoc.missing')}</Badge>
        {canEdit && (
          <>
            <Button size="sm" icon={Upload} onClick={() => upload('medical')}>
              {t('files.uploadMedical')}
            </Button>
            <Button size="sm" icon={Upload} onClick={() => upload('other')}>
              {t('files.uploadOther')}
            </Button>
          </>
        )}
        <input
          ref={pickRef}
          type="file"
          accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            const data = await readFileBase64(file);
            act(() => rpc('files.upload', { studentId: student.id, kind, ...data }), t('files.uploaded'));
          }}
        />
      </div>
      {files.length === 0 ? (
        <Empty title={t('files.empty')} text={student.medical_doc ? t('files.emptyProvided') : ''} />
      ) : (
        <table className="table">
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td>
                  <a href="#" className="strong" onClick={(e) => (e.preventDefault(), open(f))} style={{ textDecoration: 'none' }}>
                    {f.file_name}
                  </a>
                  <div className="small muted">{t(`files.kind_${f.kind}`)}</div>
                </td>
                <td className="small muted nowrap">{fileSize(f.size)}</td>
                <td className="small muted nowrap">
                  {fmtDateTime(f.created_at)}
                  {f.created_by ? ` · ${f.created_by}` : ''}
                </td>
                <td className="actions">
                  <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                    <Button size="sm" icon={ExternalLink} onClick={() => open(f)}>
                      {t('files.open')}
                    </Button>
                    <Button size="sm" icon={Printer} onClick={() => print(f)} title={t('absence.print')} />
                    <Button size="sm" icon={Download} onClick={() => download(f)} title={t('files.save')} />
                    {canEdit && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove(f)} title={t('common.delete')} />}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
