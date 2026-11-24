import { Fragment, useEffect, useRef, useState } from 'react';
import { Plus, FileSignature, FileText, Printer, FileDown, Trash2, Save, Download, Upload, Pencil, AlertTriangle, ExternalLink, CheckCircle2 } from 'lucide-react';
import { useT } from '../i18n';
import { useCan } from '../components/Auth';
import { useColumns } from '../components/Columns';
import { useRpc, rpc, fmtDate, fmtDateTime, todayIso, contractBodyHtml, contractDocument } from '../lib';
import {
  Badge, Button, Empty, Field, Loading, Modal, RowMenu, SearchBox, Segmented, StudentPicker, Tabs, useAction, useConfirm,
} from '../components/ui';

export const CONTRACT_TONE = { draft: 'warn', signed: 'good', expired: 'bad', terminated: '' };

// Fields a Word template can use, written in Word as {name}.
const PLACEHOLDERS = [
  'contract_no', 'sign_day', 'sign_month', 'sign_month_gen', 'sign_year', 'start_day', 'start_month', 'start_year',
  'student_name', 'student_birth_date', 'student_document_no', 'student_birth_doc', 'student_status', 'group_name',
  'monthly_fee', 'chk_regular', 'chk_team', 'parent_name', 'parent_doc_no', 'parent_doc_issuer', 'parent_doc_date',
  'parent_ssn', 'parent_address', 'parent_phone', 'parent_email',
];

// Student fields that print as a blank line in the contract when empty.
const CONTRACT_FIELDS = [
  ['contract_no', 'students.contractNo'],
  ['birth_date', 'students.birthDate'],
  ['document_no', 'students.documentNo'],
  ['group_id', 'students.group'],
  ['parent_first_name', 'contracts.parentFirstName'],
  ['parent_last_name', 'contracts.parentLastName'],
  ['parent_doc_no', 'parent.docNo'],
  ['parent_doc_issuer', 'parent.docIssuer'],
  ['parent_doc_date', 'parent.docDate'],
  ['parent_ssn', 'parent.ssn'],
  ['parent_address', 'parent.address'],
  ['parent_phone', 'parent.phone'],
  ['parent_email', 'parent.email'],
];

const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });

async function saveBase64(defaultName, data) {
  const r = await window.fc.saveBinary({ defaultName, data, filters: [{ name: 'Word', extensions: ['docx'] }] });
  if (!r.ok && r.error !== 'CANCELLED') throw Object.assign(new Error(r.error), { code: r.error, detail: r.detail });
  return r.ok;
}

// Builds the filled Word file from the student's current details and saves it.
export async function downloadContract(id) {
  const doc = await rpc('contracts.document', { id });
  return saveBase64(doc.fileName, doc.data);
}
// The same filled Word file, sent straight to the printer / opened in Word.
export async function printContract(id) {
  const doc = await rpc('contracts.document', { id });
  const r = await window.fc.printFile({ name: doc.fileName, data: doc.data });
  if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error, detail: r.detail, showDetail: true });
}
export async function openContract(id) {
  const doc = await rpc('contracts.document', { id });
  const r = await window.fc.openTemp({ name: doc.fileName, data: doc.data });
  if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error, detail: r.detail, showDetail: true });
}

// After a new student is created with their contract: print it, open it in Word or save it.
export function ContractReadyModal({ contractId, studentName, number, onClose }) {
  const t = useT();
  const act = useAction();
  return (
    <Modal
      title={t('contracts.readyTitle')}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button icon={FileDown} onClick={() => act(() => downloadContract(contractId))}>
            {t('contracts.downloadWord')}
          </Button>
          <Button icon={ExternalLink} onClick={() => act(() => openContract(contractId))}>
            {t('contracts.openWord')}
          </Button>
          <Button variant="primary" icon={Printer} onClick={() => act(() => printContract(contractId), t('contracts.printing'))}>
            {t('contracts.print')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row strong" style={{ color: 'var(--good)' }}>
          <CheckCircle2 size={18} /> {t('contracts.readyText', { name: studentName, number: number || '—' })}
        </div>
        <div className="small muted">{t('contracts.readyHint')}</div>
      </div>
    </Modal>
  );
}

export default function Contracts({ route }) {
  const t = useT();
  const [tab, setTab] = useState('contracts');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav.contracts')}</h1>
          <div className="sub">{t('contracts.subtitle')}</div>
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'contracts', label: t('contracts.list'), icon: FileSignature },
          { id: 'templates', label: t('contracts.templates'), icon: FileText },
        ]}
      />
      {tab === 'contracts' ? <ContractList openId={route.openId} /> : <Templates />}
    </>
  );
}

function ContractList({ openId }) {
  const canEdit = useCan('contracts');
  const t = useT();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(null);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(openId || null);
  const { data, loading } = useRpc('contracts.list', { search, status });
  const { columns, button: columnsButton } = useColumns('contracts', [
    { id: 'number', label: '№', head: () => <th>№</th>, cell: (c) => <td className="strong nowrap">{c.number || '—'}</td> },
    {
      id: 'student',
      label: t('payments.student'),
      head: () => <th>{t('payments.student')}</th>,
      cell: (c) => (
        <td>
          {[c.first_name, c.last_name, c.patronymic].filter(Boolean).join(' ')}
          <div className="small muted">{c.group_name}</div>
        </td>
      ),
    },
    { id: 'template', label: t('contracts.template'), head: () => <th>{t('contracts.template')}</th>, cell: (c) => <td>{c.title}</td> },
    {
      id: 'contractDate',
      label: t('contracts.contractDate'),
      head: () => <th>{t('contracts.contractDate')}</th>,
      cell: (c) => <td className="nowrap">{fmtDate(c.contract_date)}</td>,
    },
    {
      id: 'startDate',
      label: t('contracts.startDate'),
      head: () => <th>{t('contracts.startDate')}</th>,
      cell: (c) => <td className="nowrap">{fmtDate(c.start_date)}</td>,
    },
    {
      id: 'endDate',
      label: t('contracts.endDate'),
      defaultHidden: true,
      head: () => <th>{t('contracts.endDate')}</th>,
      cell: (c) => <td className="nowrap">{fmtDate(c.end_date) || '—'}</td>,
    },
    {
      id: 'group',
      label: t('students.group'),
      defaultHidden: true,
      head: () => <th>{t('students.group')}</th>,
      cell: (c) => <td>{c.group_name || '—'}</td>,
    },
    {
      id: 'status',
      label: t('payments.status'),
      head: () => <th>{t('payments.status')}</th>,
      cell: (c) => (
        <td>
          <Badge tone={CONTRACT_TONE[c.status]}>{t(`contractStatus.${c.status}`)}</Badge>
        </td>
      ),
    },
  ]);


  return (
    <>
      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder={t('contracts.searchPlaceholder')} />
        <Segmented
          value={status}
          onChange={setStatus}
          options={[{ value: null, label: t('common.all') }, ...['draft', 'signed', 'terminated'].map((s) => ({ value: s, label: t(`contractStatus.${s}`) }))]}
        />
        <div className="grow" />
        {columnsButton}
        {canEdit && (
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            {t('contracts.new')}
          </Button>
        )}
      </div>
      {loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <div className="card">
          <Empty icon={FileSignature} title={t('contracts.empty')} text={t('contracts.emptyText')} />
        </div>
      ) : (
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
              {data.map((c) => (
                <tr key={c.id} className="click" onClick={() => setOpen(c.id)}>
                  {columns.map((col) => (
                    <Fragment key={col.id}>{col.cell(c)}</Fragment>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewContractModal onClose={() => setCreating(false)} onCreated={(id) => (setCreating(false), setOpen(id))} />}
      {open && <ContractModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function NewContractModal({ studentId: fixed, onClose, onCreated }) {
  const t = useT();
  const act = useAction();
  const { data: templates } = useRpc('docTemplates.list');
  const [studentId, setStudentId] = useState(fixed || null);
  const [student, setStudent] = useState(null);
  const [templateId, setTemplateId] = useState('');
  const [contractDate, setContractDate] = useState(todayIso());
  const [startDate, setStartDate] = useState('');
  const [startTouched, setStartTouched] = useState(false);

  useEffect(() => {
    if (templates?.length && !templateId) setTemplateId(String(templates[0].id));
  }, [templates]);

  // The start date defaults to the student's join date until changed by hand.
  useEffect(() => {
    if (!studentId) return setStudent(null);
    rpc('students.get', { id: studentId })
      .then((r) => {
        setStudent(r.student);
        if (!startTouched) setStartDate(r.student.join_date || todayIso());
      })
      .catch(() => setStudent(null));
  }, [studentId]);

  const missing = student ? CONTRACT_FIELDS.filter(([key]) => !student[key]).map(([, label]) => t(label)) : [];

  const create = async () => {
    const r = await act(
      () => rpc('contracts.create', { studentId, docTemplateId: Number(templateId), contractDate, startDate }),
      t('contracts.created')
    );
    if (!r) return;
    await act(() => downloadContract(r.id));
    onCreated(r.id);
  };

  return (
    <Modal
      title={t('contracts.new')}
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={FileDown} onClick={create} disabled={!studentId || !templateId || !contractDate}>
            {t('contracts.create')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {!fixed && (
          <Field label={t('payments.student')}>
            <StudentPicker value={studentId} onChange={setStudentId} autoFocus />
          </Field>
        )}
        <Field label={t('contracts.template')}>
          <select className="select" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {(templates || []).map((tp) => (
              <option key={tp.id} value={tp.id}>
                {tp.name}
              </option>
            ))}
          </select>
        </Field>
        {templates && !templates.length && <div className="small" style={{ color: 'var(--bad)' }}>{t('contracts.noTemplates')}</div>}
        <div className="grid-2">
          <Field label={t('contracts.contractDate')} hint={t('contracts.contractDateHint')}>
            <input className="input" type="date" value={contractDate} onChange={(e) => setContractDate(e.target.value)} />
          </Field>
          <Field label={t('contracts.startDate')} hint={t('contracts.startDateHint')}>
            <input
              className="input"
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                setStartTouched(true);
              }}
            />
          </Field>
        </div>
        {student && (
          <div className="card card-pad stack" style={{ gap: 6, background: 'var(--surface-2)' }}>
            <div className="row">
              <span className="muted">{t('students.contractNo')}:</span>
              <span className="strong">{student.contract_no || '—'}</span>
            </div>
            {missing.length > 0 ? (
              <div className="row small" style={{ alignItems: 'flex-start', color: 'var(--warn)' }}>
                <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{t('contracts.missingFields', { fields: missing.join(', ') })}</span>
              </div>
            ) : (
              <div className="small" style={{ color: 'var(--good)' }}>{t('contracts.allFilled')}</div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function ContractModal({ id, onClose }) {
  const canEdit = useCan('contracts');
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const [c, setC] = useState(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    rpc('contracts.get', { id }).then(setC).catch(() => onClose());
  }, [id]);

  if (!c) return null;
  // Older contracts were plain text made in the app; new ones are filled Word files.
  const isWord = !!c.doc_template_id || !c.body;
  const set = (k) => (e) => {
    setC({ ...c, [k]: e?.target ? e.target.value : e });
    setDirty(true);
  };
  const save = async () => {
    if (await act(() => rpc('contracts.save', c), t('common.saved'))) setDirty(false);
  };
  const remove = async () => {
    if (!(await confirm({ text: t('contracts.deleteConfirm', { number: c.number || '' }), confirmLabel: t('common.delete') }))) return;
    if (await act(() => rpc('contracts.delete', { id }), t('common.deleted'))) onClose();
  };
  const html = () => contractDocument(c.title, c.body);
  const pdfName = `${t('contracts.fileName')}-${c.number || ''}-${c.last_name}.pdf`.replace(/[\\/:*?"<>|]/g, '_');

  return (
    <Modal
      title={`${c.number ? `№ ${c.number} — ` : ''}${[c.first_name, c.last_name, c.patronymic].filter(Boolean).join(' ')}`}
      onClose={onClose}
      width={isWord ? 640 : 920}
      footer={
        <>
          {canEdit && (
            <Button className="left" variant="danger" icon={Trash2} onClick={remove}>
              {t('common.delete')}
            </Button>
          )}
          {isWord ? (
            <>
              <Button icon={FileDown} onClick={() => act(() => downloadContract(id))}>
                {t('contracts.downloadWord')}
              </Button>
              <Button icon={ExternalLink} onClick={() => act(() => openContract(id))}>
                {t('contracts.openWord')}
              </Button>
              <Button icon={Printer} onClick={() => act(() => printContract(id), t('contracts.printing'))}>
                {t('contracts.print')}
              </Button>
            </>
          ) : (
            <>
              <Button icon={Printer} onClick={() => act(() => window.fc.print({ html: html() }))}>
                {t('contracts.print')}
              </Button>
              <Button icon={FileDown} onClick={() => act(() => window.fc.exportPdf({ html: html(), defaultName: pdfName }))}>
                {t('contracts.exportPdf')}
              </Button>
            </>
          )}
          <Button variant="primary" icon={Save} onClick={save} disabled={!dirty}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('contracts.template')} className="span-2">
            <input className="input" value={c.title} onChange={set('title')} />
          </Field>
          <Field label={t('contracts.contractDate')}>
            <input className="input" type="date" value={c.contract_date || ''} onChange={set('contract_date')} />
          </Field>
          <Field label={t('contracts.startDate')}>
            <input className="input" type="date" value={c.start_date || ''} onChange={set('start_date')} />
          </Field>
          <Field label={t('payments.status')}>
            <select
              className="select"
              value={c.status}
              onChange={(e) => {
                const status = e.target.value;
                setC({ ...c, status, signed_date: status === 'signed' && !c.signed_date ? todayIso() : c.signed_date });
                setDirty(true);
              }}
            >
              {['draft', 'signed', 'terminated'].map((s) => (
                <option key={s} value={s}>
                  {t(`contractStatus.${s}`)}
                </option>
              ))}
            </select>
          </Field>
          {c.status === 'signed' && (
            <Field label={t('contracts.signedDate')}>
              <input className="input" type="date" value={c.signed_date || ''} onChange={set('signed_date')} />
            </Field>
          )}
        </div>
        {isWord ? (
          <div className="small muted">{t('contracts.wordNote')}</div>
        ) : (
          <div className="doc-preview" dangerouslySetInnerHTML={{ __html: contractBodyHtml(c.body) }} />
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ Word templates
function Templates() {
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const { data, loading } = useRpc('docTemplates.list');
  const [naming, setNaming] = useState(null); // { id?, name, data?, file_name? }
  const uploadRef = useRef(null);
  const replaceRef = useRef(null);
  const replaceId = useRef(null);

  const readDocx = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return null;
    return { data: await fileToBase64(file), file_name: file.name, name: file.name.replace(/\.docx$/i, '') };
  };

  const download = (tp) =>
    act(async () => {
      const r = await rpc('docTemplates.get', { id: tp.id });
      return saveBase64(r.file_name || `${r.name}.docx`, r.data);
    });

  return (
    <>
      <div className="toolbar">
        <div className="muted grow">{t('templates.wordIntro')}</div>
        <Button variant="primary" icon={Upload} onClick={() => uploadRef.current.click()}>
          {t('templates.upload')}
        </Button>
        <input
          ref={uploadRef}
          type="file"
          accept=".docx"
          hidden
          onChange={async (e) => {
            const f = await readDocx(e);
            if (f) setNaming(f);
          }}
        />
        <input
          ref={replaceRef}
          type="file"
          accept=".docx"
          hidden
          onChange={async (e) => {
            const f = await readDocx(e);
            const tp = data.find((x) => x.id === replaceId.current);
            if (f && tp) act(() => rpc('docTemplates.save', { id: tp.id, name: tp.name, data: f.data, file_name: f.file_name }), t('templates.replaced'));
          }}
        />
      </div>

      {loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <div className="card">
          <Empty icon={FileText} title={t('templates.empty')} text={t('templates.emptyText')} />
        </div>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 18 }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('templates.name')}</th>
                <th>{t('templates.file')}</th>
                <th>{t('templates.updated')}</th>
                <th className="actions" />
              </tr>
            </thead>
            <tbody>
              {data.map((tp) => (
                <tr key={tp.id}>
                  <td className="strong">
                    <span className="row" style={{ gap: 8 }}>
                      <FileText size={16} style={{ color: 'var(--info)' }} />
                      {tp.name}
                    </span>
                  </td>
                  <td className="small muted">
                    {tp.file_name || '—'} · {Math.round(tp.size / 1024)} KB
                  </td>
                  <td className="small muted nowrap">{fmtDateTime(tp.updated_at || tp.created_at)}</td>
                  <td className="actions">
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <Button size="sm" icon={Download} onClick={() => download(tp)}>
                        {t('templates.download')}
                      </Button>
                      <RowMenu
                        items={[
                          {
                            label: t('templates.replace'),
                            icon: Upload,
                            onClick: () => {
                              replaceId.current = tp.id;
                              replaceRef.current.click();
                            },
                          },
                          { label: t('templates.rename'), icon: Pencil, onClick: () => setNaming({ id: tp.id, name: tp.name }) },
                          '-',
                          {
                            label: t('common.delete'),
                            icon: Trash2,
                            danger: true,
                            onClick: async () =>
                              (await confirm({ text: t('templates.deleteConfirm', { name: tp.name }), confirmLabel: t('common.delete') })) &&
                              act(() => rpc('docTemplates.delete', { id: tp.id }), t('common.deleted')),
                          },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>{t('templates.fieldsTitle')}</h3>
        </div>
        <div className="card-pad stack" style={{ gap: 12 }}>
          <div className="small muted">{t('templates.fieldsHelp')}</div>
          <div className="ph-grid">
            {PLACEHOLDERS.map((p) => (
              <div key={p} className="ph-row">
                <code>{`{${p}}`}</code>
                <span className="small">{t(`wph.${p}`)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {naming && (
        <Modal
          title={naming.id ? t('templates.rename') : t('templates.upload')}
          onClose={() => setNaming(null)}
          width={460}
          footer={
            <>
              <Button onClick={() => setNaming(null)}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                disabled={!naming.name?.trim()}
                onClick={async () => {
                  if (await act(() => rpc('docTemplates.save', naming), t('common.saved'))) setNaming(null);
                }}
              >
                {t('common.save')}
              </Button>
            </>
          }
        >
          <Field label={t('templates.name')}>
            <input className="input" autoFocus value={naming.name} onChange={(e) => setNaming({ ...naming, name: e.target.value })} />
          </Field>
        </Modal>
      )}
    </>
  );
}
