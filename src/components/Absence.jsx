import { useRef, useState } from 'react';
import { FilePlus2, Printer, ExternalLink, CheckCircle2, Paperclip, Trash2 } from 'lucide-react';
import { useT } from '../i18n';
import { rpc, todayIso, readFileBase64 } from '../lib';
import { Button, Field, Modal, useAction } from './ui';
import { useEditLock } from './Locks';
import { useCan } from './Auth';

const REASONS = ['agreed', 'illness', 'other'];

// Prints / opens a stored document by its file id.
export async function printStoredFile(id) {
  const f = await rpc('files.get', { id });
  const r = await window.fc.printFile({ name: f.fileName, data: f.data, perm: 'students.print' });
  if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error, detail: r.detail, showDetail: true });
}
// perm: the tick it is opened with (seeing the student, their payments, or the absence application just made).
export async function openStoredFile(id, perm = 'students.view') {
  const f = await rpc('files.get', { id });
  const r = await window.fc.openTemp({ name: f.fileName, data: f.data, perm });
  if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error, detail: r.detail, showDetail: true });
}

// «Ստեղծել դիմում» — the absence application, filled from the club's Word form.
export function AbsenceModal({ student, onClose }) {
  const t = useT();
  const act = useAction();
  const canPrint = useCan('students.print');
  const canUpload = useCan('students.files'); // the attached scans are kept under the student's documents
  const lock = useEditLock(`student:${student.id}`);
  const [f, setF] = useState({
    from: todayIso(),
    to: todayIso(),
    reason: 'agreed',
    reasonOther: '',
    attachMedical: false,
    attachOther: false,
    attachOtherText: '',
    date: todayIso(),
  });
  const [files, setFiles] = useState({ medical: null, other: null });
  const [done, setDone] = useState(null);
  const medRef = useRef(null);
  const otherRef = useRef(null);
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });

  const create = async () => {
    const r = await act(async () => {
      const res = await rpc('applications.create', { studentId: student.id, ...f });
      // Attached files go to the student's documents too.
      if (canUpload && f.attachMedical && files.medical) await rpc('files.upload', { studentId: student.id, kind: 'medical', ...files.medical });
      if (canUpload && f.attachOther && files.other) await rpc('files.upload', { studentId: student.id, kind: 'other', ...files.other });
      return res;
    }, t('absence.saved'));
    if (r) setDone(r);
  };

  const pick = (kind) => async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const data = await readFileBase64(file);
    setFiles((x) => ({ ...x, [kind]: data }));
  };
  const fileChip = (kind, ref) => (
    <span className="row" style={{ gap: 6 }}>
      <Button size="sm" icon={Paperclip} onClick={() => ref.current.click()}>
        {files[kind] ? t('files.otherFile') : t('absence.attachFile')}
      </Button>
      {files[kind] && (
        <>
          <span className="small strong">{files[kind].name}</span>
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setFiles((x) => ({ ...x, [kind]: null }))} />
        </>
      )}
      <input ref={ref} type="file" accept="image/*,application/pdf,.doc,.docx" hidden onChange={pick(kind)} />
    </span>
  );

  if (done)
    return (
      <Modal
        title={t('absence.title')}
        onClose={onClose}
        width={520}
        footer={
          <>
            <Button icon={ExternalLink} onClick={() => act(() => openStoredFile(done.id, 'students.absence'))}>
              {t('absence.openWord')}
            </Button>
            {canPrint && (
              <Button icon={Printer} onClick={() => act(() => printStoredFile(done.id), t('absence.printing'))}>
                {t('absence.print')}
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              {t('hdm.done')}
            </Button>
          </>
        }
      >
        <div className="stack">
          <div className="row strong" style={{ color: 'var(--good)' }}>
            <CheckCircle2 size={18} /> {t('absence.savedText')}
          </div>
          <div className="small">{done.fileName}</div>
        </div>
      </Modal>
    );

  const valid = f.from && f.to && f.to >= f.from && (f.reason !== 'other' || f.reasonOther.trim());
  return (
    <Modal
      title={`${t('absence.title')} — ${student.first_name} ${student.last_name}`}
      lock={lock}
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={FilePlus2} onClick={create} disabled={!valid}>
            {t('absence.create')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-3">
          <Field label={t('absence.from')}>
            <input className="input" type="date" value={f.from} onChange={set('from')} />
          </Field>
          <Field label={t('absence.to')}>
            <input className="input" type="date" value={f.to} min={f.from} onChange={set('to')} />
          </Field>
          <Field label={t('absence.date')}>
            <input className="input" type="date" value={f.date} onChange={set('date')} />
          </Field>
        </div>
        {f.to < f.from && <div className="small" style={{ color: 'var(--bad)' }}>{t('error.PERIOD_INVALID')}</div>}

        <Field label={t('absence.reason')}>
          <div className="stack" style={{ gap: 6 }}>
            {REASONS.map((r) => (
              <label key={r} className="check">
                <input type="radio" name="absence-reason" checked={f.reason === r} onChange={() => setF({ ...f, reason: r })} />
                {t(`absence.reason_${r}`)}
              </label>
            ))}
            {f.reason === 'other' && (
              <input className="input" autoFocus placeholder={t('absence.reasonOther')} value={f.reasonOther} onChange={set('reasonOther')} />
            )}
          </div>
        </Field>

        <Field label={t('absence.attached')}>
          <div className="stack" style={{ gap: 8 }}>
            <div className="row wrap" style={{ gap: 12 }}>
              <label className="check">
                <input type="checkbox" checked={f.attachMedical} onChange={set('attachMedical')} />
                {t('absence.attachMedical')}
              </label>
              {f.attachMedical && canUpload && fileChip('medical', medRef)}
            </div>
            <div className="row wrap" style={{ gap: 12 }}>
              <label className="check">
                <input type="checkbox" checked={f.attachOther} onChange={set('attachOther')} />
                {t('absence.attachOther')}
              </label>
              {f.attachOther && (
                <>
                  <input className="input" style={{ maxWidth: 240 }} placeholder={t('absence.attachOtherText')} value={f.attachOtherText} onChange={set('attachOtherText')} />
                  {fileChip('other', otherRef)}
                </>
              )}
            </div>
          </div>
        </Field>
        <div className="small muted">{t('absence.hint')}</div>
      </div>
    </Modal>
  );
}
