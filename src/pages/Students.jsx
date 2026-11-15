import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Download, Users, FileUp, Paperclip, Camera, Trash2, UserRound, FileText, Wallet, StickyNote } from 'lucide-react';
import { useT, monthName } from '../i18n';
import { useCan } from '../components/Auth';
import { useColumns } from '../components/Columns';
import { ImportModal } from '../components/Import';
import { useRpc, rpc, fmtDate, saveCsv, todayIso, resizeImage, seasonMonths, money, readFileBase64 } from '../lib';
import { Avatar, Badge, Button, Empty, Field, Loading, Modal, Money, SearchBox, Segmented, useAction, useClub } from '../components/ui';
import { PayModal } from './Payments';

export const CATEGORIES = ['siblings', 'half', 'war', 'staff'];

// The club's services, as listed in its records (Armenian only).
export const SERVICES = [
  'Առաջնություն անվճար',
  'Առաջնություն զեղչված',
  'Առաջնություն վճարովի',
  'Դարպասապահ 12',
  'Դարպասապահ 16',
  'Դարպասապահ 4',
  'Դարպասապահ 8',
  'Մարզահագուստ (ամառային)',
  'Մարզահագուստ (ձմեռային)',
  'Ուսումնամարզական',
  'Ուսումնամարզական %',
  'Ուսումնամարզական անվճար',
  'Ֆուտբոլ անհ. 4',
  'Ֆուտբոլ անհ. 8',
  'Ֆուտբոլ անհ.12',
  'Ֆուտբոլ անհ.16',
];

const MONTH_MARK = { paid: '✓', overdue: '✕', unpaid: '•', waived: '—' };

// Status of one monthly fee: paid, overdue, unpaid (not yet due), waived, or none (no fee for that month).
function monthStatus(m) {
  if (!m) return 'none';
  if (m.status !== 'unpaid') return m.status;
  return m.due_date && m.due_date < todayIso() ? 'overdue' : 'unpaid';
}

export default function Students({ nav, route }) {
  const canEdit = useCan('students');
  const canPay = useCan('payments');
  const t = useT();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const [groupId, setGroupId] = useState(route.groupId ? String(route.groupId) : '');
  const [debtOnly, setDebtOnly] = useState(false);
  const [editing, setEditing] = useState(route.create ? {} : null);
  const [paying, setPaying] = useState(null);
  const [importing, setImporting] = useState(false);
  const { currency } = useClub();
  const months = useMemo(() => seasonMonths(), []);
  const { data: groups } = useRpc('groups.list');
  const { data, loading } = useRpc('students.list', {
    search,
    status: status || null,
    groupId: groupId ? Number(groupId) : null,
    monthsFrom: months[0],
    monthsTo: months[months.length - 1],
  });

  const rows = useMemo(
    () =>
      (data || [])
        .filter((s) => !debtOnly || s.overdue > 0)
        .map((s) => ({ ...s, byMonth: Object.fromEntries(s.months.map((m) => [m.period, m])) })),
    [data, debtOnly]
  );


  const text = (v) => v || <span className="muted">—</span>;
  const plain = (id, label, get, opts = {}) => ({
    id,
    label,
    head: () => <th className={opts.num ? 'num' : ''}>{label}</th>,
    cell: (s) => <td className={opts.num ? 'num' : opts.nowrap ? 'nowrap' : ''}>{text(get(s))}</td>,
    ...opts,
  });
  const { columns, button: columnsButton } = useColumns('students', [
    {
      id: 'name',
      label: t('students.name'),
      fixed: true,
      head: () => <th className="sticky-col">{t('students.name')}</th>,
      cell: (s) => (
        <td className="sticky-col">
          <div className="cell-person">
            <Avatar first={s.first_name} last={s.last_name} seed={s.id} />
            <div>
              <div className="name nowrap">
                {s.first_name} {s.last_name}
                {s.patronymic ? ` ${s.patronymic}` : ''}
              </div>
            </div>
          </div>
        </td>
      ),
    },
    {
      id: 'group',
      label: t('students.group'),
      head: () => <th>{t('students.group')}</th>,
      cell: (s) => (
        <td>
          {s.group_name ? (
            <span className="row nowrap" style={{ gap: 7 }}>
              <span className="dot" style={{ background: s.group_color || undefined }} />
              {s.group_name}
            </span>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      ),
    },
    plain('coach', t('students.coach'), (s) => s.group_coach),
    {
      id: 'parent',
      label: t('students.parent'),
      head: () => <th>{t('students.parent')}</th>,
      cell: (s) => (
        <td>
          <div>{s.parent_name || '—'}</div>
          <div className="small muted">{s.parent_phone}</div>
        </td>
      ),
    },
    {
      id: 'medical',
      label: t('students.medicalDoc'),
      head: () => <th>{t('students.medicalDoc')}</th>,
      cell: (s) => (
        <td>
          <Badge tone={s.medical_doc ? 'good' : 'warn'}>{t(s.medical_doc ? 'medicalDoc.provided' : 'medicalDoc.missing')}</Badge>
        </td>
      ),
    },
    {
      id: 'fee',
      label: t('students.monthlyFee'),
      available: canPay,
      head: () => <th className="num">{t('students.monthlyFee')}</th>,
      cell: (s) => (
        <td className="num">
          <Money value={s.monthly_fee} />
        </td>
      ),
    },
    {
      id: 'months',
      label: t('columns.months'),
      available: canPay,
      head: () =>
        months.map((p) => (
          <th key={p} className="mcol" title={monthName(t, p)}>
            {t(`month.s${Number(p.slice(5))}`)}
            <div style={{ fontWeight: 400 }}>{p.slice(2, 4)}</div>
          </th>
        )),
      cell: (s) =>
        months.map((p) => {
          const m = s.byMonth[p];
          const st = monthStatus(m);
          const tip = m ? `${monthName(t, p)} · ${money(m.amount, currency)} · ${t(`chargeStatus.${st}`)}` : monthName(t, p);
          const payable = canPay && (st === 'overdue' || st === 'unpaid');
          return (
            <td key={p} className="mcol">
              <span
                className={`pay-cell ${st} ${payable ? 'payable' : ''}`}
                title={payable ? `${tip} — ${t('payments.pay')}` : tip}
                onClick={(e) => {
                  if (!payable) return;
                  e.stopPropagation();
                  setPaying([{ ...m, kind: 'monthly', first_name: s.first_name, last_name: s.last_name }]);
                }}
              >
                {MONTH_MARK[st] || '·'}
              </span>
            </td>
          );
        }),
    },
    {
      id: 'debt',
      label: t('columns.debt'),
      available: canPay,
      defaultHidden: true,
      head: () => <th className="num">{t('columns.debt')}</th>,
      cell: (s) => (
        <td className="num">{s.overdue > 0 ? <Money value={s.overdue} className="strong" /> : <span className="muted">—</span>}</td>
      ),
    },
    {
      id: 'status',
      label: t('students.status'),
      head: () => <th>{t('students.status')}</th>,
      cell: (s) => (
        <td>
          <Badge tone={s.status === 'active' ? 'accent' : ''}>{t(`status.${s.status}`)}</Badge>
        </td>
      ),
    },
    plain('birthDate', t('students.birthDate'), (s) => fmtDate(s.birth_date), { defaultHidden: true, nowrap: true }),
    plain('joinDate', t('students.joinDate'), (s) => fmtDate(s.join_date), { defaultHidden: true, nowrap: true }),
    plain('category', t('students.category'), (s) => (s.category ? t(`category.${s.category}`) : ''), { defaultHidden: true }),
    plain('service', t('students.service'), (s) => s.service, { defaultHidden: true }),
    plain('contractNo', t('students.contractNo'), (s) => s.contract_no, { defaultHidden: true, nowrap: true }),
    plain('parentPhone', `${t('students.parent')} · ${t('parent.phone')}`, (s) => s.parent_phone, { defaultHidden: true, nowrap: true }),
    plain('parentEmail', `${t('students.parent')} · ${t('parent.email')}`, (s) => s.parent_email, { defaultHidden: true }),
    plain('parentSsn', `${t('students.parent')} · ${t('parent.ssn')}`, (s) => s.parent_ssn, { defaultHidden: true, nowrap: true }),
    plain('parentDoc', `${t('students.parent')} · ${t('parent.docNo')}`, (s) => s.parent_doc_no, { defaultHidden: true, nowrap: true }),
    plain('parentAddress', `${t('students.parent')} · ${t('parent.address')}`, (s) => s.parent_address, { defaultHidden: true }),
    plain('inactiveReason', t('students.inactiveReason'), (s) => s.inactive_reason, { defaultHidden: true }),
  ]);

  const exportCsv = () =>
    saveCsv(`students-${todayIso()}.csv`, [
      [t('students.firstName'), t('students.lastName'), t('students.patronymic'), t('students.birthDate'), t('students.group'), t('students.coach'),
        t('parent.firstName'), t('parent.lastName'), t('parent.ssn'), t('parent.docNo'), t('parent.docIssuer'), t('parent.docDate'),
        t('parent.phone'), t('parent.email'), t('parent.address'), t('students.medicalDoc'), t('students.category'), t('students.service'), t('students.contractNo'), t('students.monthlyFee'), t('students.joinDate'), t('students.status'), t('students.inactiveReason'),
        ...months.map((p) => monthName(t, p))],
      ...rows.map((s) => [s.first_name, s.last_name, s.patronymic, fmtDate(s.birth_date), s.group_name, s.group_coach,
        s.parent_first_name, s.parent_last_name, s.parent_ssn, s.parent_doc_no, s.parent_doc_issuer, fmtDate(s.parent_doc_date),
        s.parent_phone, s.parent_email, s.parent_address,
        t(s.medical_doc ? 'medicalDoc.provided' : 'medicalDoc.missing'), s.category ? t(`category.${s.category}`) : '', s.service, s.contract_no, s.monthly_fee, fmtDate(s.join_date), t(`status.${s.status}`), s.inactive_reason,
        ...months.map((p) => {
          const st = monthStatus(s.byMonth[p]);
          return st === 'none' ? '' : t(`chargeStatus.${st}`);
        })]),
    ]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav.students')}</h1>
          <div className="sub">{data ? t('students.count', { n: rows.length }) : ' '}</div>
        </div>
        <div className="spacer" />
        {columnsButton}
        <Button icon={Download} onClick={exportCsv} disabled={!rows.length}>
          {t('common.exportCsv')}
        </Button>
        {canEdit && (
          <Button icon={FileUp} onClick={() => setImporting(true)}>
            {t('import.button')}
          </Button>
        )}
        {canEdit && (
          <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
            {t('students.add')}
          </Button>
        )}
      </div>

      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder={t('students.searchPlaceholder')} />
        <select className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">{t('students.allGroups')}</option>
          {(groups || []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: t('status.active') },
            { value: 'inactive', label: t('status.inactive') },
            { value: '', label: t('common.all') },
          ]}
        />
        {canPay && (
          <label className="check">
            <input type="checkbox" checked={debtOnly} onChange={(e) => setDebtOnly(e.target.checked)} />
            {t('students.withDebt')}
          </label>
        )}
        <div className="grow" />
        {canPay && columns.some((c) => c.id === 'months') && (
          <span className="small muted">
            {['paid', 'overdue', 'unpaid', 'waived'].map((k) => `${MONTH_MARK[k]} ${t(`chargeStatus.${k}`)}`).join(' · ')}
          </span>
        )}
      </div>

      {loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="card">
          <Empty
            icon={Users}
            title={t('students.empty')}
            text={search || groupId || debtOnly ? t('common.tryFilters') : t('students.emptyText')}
            action={!search && canEdit && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>{t('students.add')}</Button>}
          />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>{columns.map((c) => <Fragment key={c.id}>{c.head()}</Fragment>)}</tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="click" onClick={() => nav('students', { id: s.id })}>
                  {columns.map((c) => <Fragment key={c.id}>{c.cell(s)}</Fragment>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {importing && <ImportModal onClose={() => setImporting(false)} />}
      {paying && <PayModal charges={paying} onClose={() => setPaying(null)} onDone={() => setPaying(null)} />}

      {editing && (
        <StudentForm
          student={editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            if (!editing.id) nav('students', { id });
          }}
        />
      )}
    </>
  );
}

export function StudentForm({ student, onClose, onSaved }) {
  const t = useT();
  const act = useAction();
  const { data: groups } = useRpc('groups.list');
  const fileRef = useRef(null);
  const docRef = useRef(null);
  const [medicalFile, setMedicalFile] = useState(null); // picked, uploaded on save
  const [f, setF] = useState(() => ({
    first_name: '',
    last_name: '',
    patronymic: '',
    category: '',
    contract_no: '',
    service: '',
    inactive_reason: '',
    birth_date: '',
    gender: '',
    phone: '',
    email: '',
    address: '',
    document_no: '',
    parent_first_name: '',
    parent_last_name: '',
    parent_doc_no: '',
    parent_doc_issuer: '',
    parent_doc_date: '',
    parent_ssn: '',
    parent_address: '',
    parent_email: '',
    parent_phone: '',
    medical_doc: 0,
    group_id: '',
    monthly_fee: '',
    join_date: todayIso(),
    status: 'active',
    notes: '',
    photo: null,
    ...Object.fromEntries(Object.entries(student).map(([k, v]) => [k, v ?? ''])),
  }));
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e?.target ? e.target.value : e }));

  const pickPhoto = async (e) => {
    const file = e.target.files?.[0];
    if (file) setF((s) => ({ ...s, photo: null }));
    if (file) {
      const data = await resizeImage(file);
      setF((s) => ({ ...s, photo: data }));
    }
    e.target.value = '';
  };

  const save = async () => {
    const r = await act(async () => {
      const res = await rpc('students.save', f);
      if (medicalFile && f.medical_doc) await rpc('files.upload', { studentId: res.id, kind: 'medical', ...medicalFile });
      return res;
    }, t('common.saved'));
    if (r) onSaved(r.id);
  };

  return (
    <Modal
      title={student.id ? t('students.edit') : t('students.add')}
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!f.first_name.trim() || !f.last_name.trim()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 0 }}>
        <FormSection icon={UserRound} title={t('form.student')}>
          <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
            <div className="stack" style={{ gap: 6, alignItems: 'center' }}>
              <div className="photo-pick" onClick={() => fileRef.current.click()} title={t('students.photo')}>
                {f.photo ? <img src={f.photo} alt="" /> : <Camera size={26} />}
              </div>
              {f.photo && (
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => set('photo')(null)}>
                  {t('common.remove')}
                </Button>
              )}
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickPhoto} />
            </div>
            <div className="grid-3 grow">
              <Field label={`${t('students.firstName')} *`}>
                <input className="input" value={f.first_name} onChange={set('first_name')} autoFocus />
              </Field>
              <Field label={`${t('students.lastName')} *`}>
                <input className="input" value={f.last_name} onChange={set('last_name')} />
              </Field>
              <Field label={t('students.patronymic')}>
                <input className="input" value={f.patronymic} onChange={set('patronymic')} />
              </Field>
              <Field label={t('students.birthDate')}>
                <input className="input" type="date" value={f.birth_date} onChange={set('birth_date')} />
              </Field>
            </div>
          </div>
        </FormSection>

        <FormSection icon={FileText} title={t('form.documents')}>
          <div className="grid-3">
            <Field label={t('students.documentNo')}>
              <input className="input" value={f.document_no} onChange={set('document_no')} />
            </Field>
            <Field label={t('students.contractNo')}>
              <input className="input" value={f.contract_no} onChange={set('contract_no')} />
            </Field>
            <Field label={t('students.medicalDoc')}>
              <select className="select" value={f.medical_doc ? '1' : '0'} onChange={(e) => set('medical_doc')(Number(e.target.value))}>
                <option value="0">{t('medicalDoc.missing')}</option>
                <option value="1">{t('medicalDoc.provided')}</option>
              </select>
            </Field>
            {!!f.medical_doc && (
              <Field label={t('files.medicalUpload')} hint={student.id ? t('files.medicalUploadHintEdit') : t('files.medicalUploadHint')} className="span-3">
                <div className="row wrap">
                  <Button icon={Paperclip} onClick={() => docRef.current.click()}>
                    {medicalFile ? t('files.otherFile') : t('files.choose')}
                  </Button>
                  {medicalFile && (
                    <>
                      <span className="small strong">{medicalFile.name}</span>
                      <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setMedicalFile(null)} />
                    </>
                  )}
                  <input
                    ref={docRef}
                    type="file"
                    accept="image/*,application/pdf,.doc,.docx"
                    hidden
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) setMedicalFile(await readFileBase64(file));
                    }}
                  />
                </div>
              </Field>
            )}
          </div>
        </FormSection>

        <FormSection icon={Users} title={t('form.parent')}>
          <div className="grid-3">
            <Field label={t('parent.firstName')}>
              <input className="input" value={f.parent_first_name} onChange={set('parent_first_name')} />
            </Field>
            <Field label={t('parent.lastName')}>
              <input className="input" value={f.parent_last_name} onChange={set('parent_last_name')} />
            </Field>
            <Field label={t('parent.ssn')}>
              <input className="input" value={f.parent_ssn} onChange={set('parent_ssn')} />
            </Field>
            <Field label={t('parent.docNo')}>
              <input className="input" value={f.parent_doc_no} onChange={set('parent_doc_no')} />
            </Field>
            <Field label={t('parent.docIssuer')}>
              <input className="input" value={f.parent_doc_issuer} onChange={set('parent_doc_issuer')} />
            </Field>
            <Field label={t('parent.docDate')}>
              <input className="input" type="date" value={f.parent_doc_date} onChange={set('parent_doc_date')} />
            </Field>
            <Field label={t('parent.phone')}>
              <input className="input" value={f.parent_phone} onChange={set('parent_phone')} />
            </Field>
            <Field label={t('parent.email')}>
              <input className="input" value={f.parent_email} onChange={set('parent_email')} />
            </Field>
            <Field label={t('parent.address')} className="span-3">
              <input className="input" value={f.parent_address} onChange={set('parent_address')} />
            </Field>
          </div>
        </FormSection>

        <FormSection icon={Wallet} title={t('form.training')}>
          <div className="grid-3">
            <Field label={t('students.group')}>
              <select className="select" value={f.group_id} onChange={set('group_id')}>
                <option value="">{t('students.noGroup')}</option>
                {(groups || []).filter((g) => !g.archived || g.id === Number(f.group_id)).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('students.monthlyFee')} hint={t('students.monthlyFeeHint')}>
              <input className="input" type="number" min="0" step="500" value={f.monthly_fee} onChange={set('monthly_fee')} />
            </Field>
            <Field label={`${t('students.joinDate')} *`}>
              <input className="input" type="date" value={f.join_date} onChange={set('join_date')} />
            </Field>
            <Field label={t('students.service')}>
              <select className="select" value={f.service || ''} onChange={set('service')}>
                <option value="">—</option>
                {SERVICES.map((sv) => (
                  <option key={sv} value={sv}>
                    {sv}
                  </option>
                ))}
                {f.service && !SERVICES.includes(f.service) && <option value={f.service}>{f.service}</option>}
              </select>
            </Field>
            <Field label={t('students.category')}>
              <select className="select" value={f.category || ''} onChange={set('category')}>
                <option value="">—</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`category.${c}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('students.status')}>
              <select className="select" value={f.status} onChange={set('status')}>
                <option value="active">{t('status.active')}</option>
                <option value="inactive">{t('status.inactive')}</option>
              </select>
            </Field>
            {f.status === 'inactive' && (
              <Field label={t('students.inactiveReason')}>
                <input className="input" value={f.inactive_reason || ''} onChange={set('inactive_reason')} autoFocus />
              </Field>
            )}
          </div>
        </FormSection>

        <FormSection icon={StickyNote} title={t('students.notes')}>
          <textarea className="textarea" rows={3} value={f.notes} onChange={set('notes')} />
        </FormSection>
      </div>
    </Modal>
  );
}

export function FormSection({ icon: Icon, title, children }) {
  return (
    <section className="form-section">
      <h4>
        <Icon size={16} />
        {title}
      </h4>
      {children}
    </section>
  );
}
