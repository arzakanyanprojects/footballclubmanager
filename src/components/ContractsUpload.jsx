// «Ներբեռնել պայմանագրեր»: many signed contracts (.docx / .pdf) at once. Each file finds its student by
// the contract № in its name (e.g. «26-08-627.docx», «Պայմանագիր 26-08-627 Ղևոնդյան Լեո.docx»), or by
// the student's name; the user checks the list, fixes what wasn't found, and the files are saved
// under each student (Փաստաթղթեր, «Պայմանագիր»).
import { useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileUp, Upload, UserSearch, AlertTriangle } from 'lucide-react';
import { useT } from '../i18n';
import { rpc, readFileBase64 } from '../lib';
import { Button, Modal, StudentPicker, useAction } from './ui';

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (s) => norm(s).split(' ').filter(Boolean);
const NUMBER = /(\d{2})\s*[-–_.]\s*(\d{2})\s*[-–_.]\s*(\d{1,5})/;
const IGNORE = new Set(['պայմանագիր', 'պայմանագիրը', 'договор', 'contract', 'docx', 'doc', 'pdf', 'ստորագրված', 'scan']);

// The student a file belongs to: { id, how: 'number' | 'name' } or { id: null, how: 'none' | 'many' }.
export function matchFile(fileName, students) {
  const base = fileName.replace(/\.[^.]+$/, '');
  const fileWords = new Set(words(base).filter((w) => !IGNORE.has(w)));
  const nameScore = (s) => {
    const first = norm(s.first_name);
    const last = norm(s.last_name);
    if (!first || !last || !fileWords.has(first) || !fileWords.has(last)) return 0;
    return 2 + (s.patronymic && fileWords.has(norm(s.patronymic)) ? 1 : 0);
  };
  const best = (list) => {
    const scored = list.map((s) => ({ s, n: nameScore(s) })).filter((x) => x.n > 0);
    if (!scored.length) return null;
    const top = Math.max(...scored.map((x) => x.n));
    const winners = scored.filter((x) => x.n === top);
    return winners.length === 1 ? winners[0].s : 'many';
  };
  const m = base.match(NUMBER);
  if (m) {
    const no = `${m[1]}-${m[2]}-${m[3]}`;
    const withNo = students.filter((s) => String(s.contract_no || '').replace(/\s+/g, '') === no);
    if (withNo.length === 1) return { id: withNo[0].id, how: 'number' };
    if (withNo.length > 1) {
      // One number on several children (brothers, a typo): the name in the file decides.
      const b = best(withNo);
      return b && b !== 'many' ? { id: b.id, how: 'number' } : { id: null, how: 'many' };
    }
  }
  const b = best(students);
  if (b === 'many') return { id: null, how: 'many' };
  return b ? { id: b.id, how: 'name' } : { id: null, how: 'none' };
}

export function ContractsUploadModal({ onClose }) {
  const t = useT();
  const act = useAction();
  const input = useRef(null);
  const [students, setStudents] = useState(null);
  const [rows, setRows] = useState([]); // { file, id, how, on, fixing }
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const byId = useMemo(() => new Map((students || []).map((s) => [s.id, s])), [students]);

  const pick = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    const list = students || (await rpc('students.list', { status: null }).catch(() => []));
    setStudents(list);
    setRows(files.map((file) => ({ file, ...matchFile(file.name, list), on: true })));
  };
  const setRow = (i, patch) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const ready = rows.filter((r) => r.on && r.id);

  const upload = async () => {
    setBusy(true);
    const res = { saved: 0, skipped: 0, failed: [] };
    for (const r of ready) {
      try {
        const data = await readFileBase64(r.file);
        const out = await rpc('files.upload', { studentId: r.id, kind: 'contract', name: r.file.name, type: data.type, data: data.data, skipSame: true });
        out?.skipped ? res.skipped++ : res.saved++;
      } catch (err) {
        res.failed.push(`${r.file.name}: ${t(`error.${err.code}`) === `error.${err.code}` ? err.message : t(`error.${err.code}`)}`);
      }
    }
    setBusy(false);
    setDone(res);
  };

  if (done)
    return (
      <Modal title={t('cupload.title')} onClose={onClose} width={520} footer={<Button variant="primary" onClick={onClose}>{t('hdm.done')}</Button>}>
        <div className="stack">
          <div className="row strong" style={{ color: 'var(--good)' }}>
            <CheckCircle2 size={18} /> {t('cupload.done', { n: done.saved })}
          </div>
          {done.skipped > 0 && <div className="small muted">{t('cupload.skipped', { n: done.skipped })}</div>}
          {done.failed.length > 0 && (
            <div className="small" style={{ color: 'var(--bad)' }}>
              {done.failed.slice(0, 10).map((f) => (
                <div key={f}>{f}</div>
              ))}
            </div>
          )}
          <div className="small muted">{t('cupload.where')}</div>
        </div>
      </Modal>
    );

  const counts = { number: 0, name: 0, none: 0, many: 0 };
  rows.forEach((r) => (counts[r.id ? r.how : r.how] = (counts[r.id ? r.how : r.how] || 0) + 1));
  return (
    <Modal
      title={t('cupload.title')}
      onClose={onClose}
      width={rows.length ? 900 : 560}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          {rows.length > 0 && (
            <Button variant="primary" icon={Upload} onClick={() => act(upload)} disabled={busy || !ready.length}>
              {busy ? t('cupload.uploading') : t('cupload.run', { n: ready.length })}
            </Button>
          )}
        </>
      }
    >
      <input ref={input} type="file" multiple accept=".docx,.doc,.pdf" hidden onChange={pick} />
      {!rows.length ? (
        <div className="stack" style={{ alignItems: 'flex-start' }}>
          <div className="small muted">{t('cupload.intro')}</div>
          <Button variant="primary" icon={FileUp} onClick={() => input.current.click()}>
            {t('cupload.pick')}
          </Button>
        </div>
      ) : (
        <div className="stack">
          <div className="row wrap small" style={{ gap: 14 }}>
            <span className="strong">{t('cupload.files', { n: rows.length })}</span>
            <span style={{ color: 'var(--good)' }}>{t('cupload.byNumber', { n: counts.number })}</span>
            <span style={{ color: 'var(--good)' }}>{t('cupload.byName', { n: counts.name })}</span>
            {counts.none + counts.many > 0 && <span style={{ color: 'var(--warn)' }}>{t('cupload.unmatched', { n: counts.none + counts.many })}</span>}
            <div className="grow" />
            <Button size="sm" onClick={() => input.current.click()}>
              {t('import.otherFile')}
            </Button>
          </div>
          <div className="table-wrap" style={{ maxHeight: 420 }}>
            <table className="table import-review">
              <thead>
                <tr>
                  <th />
                  <th>{t('cupload.file')}</th>
                  <th>{t('payments.student')}</th>
                  <th>{t('students.group')}</th>
                  <th>{t('students.contractNo')}</th>
                  <th>{t('cupload.how')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const s = r.id ? byId.get(r.id) : null;
                  return (
                    <tr key={i} className={r.id ? '' : 'warn'}>
                      <td>
                        <input type="checkbox" checked={r.on && !!r.id} disabled={!r.id} onChange={(e) => setRow(i, { on: e.target.checked })} />
                      </td>
                      <td className="nowrap" title={r.file.name}>
                        {r.file.name.length > 48 ? `${r.file.name.slice(0, 46)}…` : r.file.name}
                      </td>
                      <td style={{ minWidth: 240 }}>
                        {r.fixing ? (
                          <StudentPicker value={r.id} onChange={(id) => setRow(i, { id, how: 'manual', on: true, fixing: false })} autoFocus />
                        ) : s ? (
                          <a href="#" onClick={(e) => (e.preventDefault(), setRow(i, { fixing: true }))} style={{ textDecoration: 'none' }} title={t('cupload.change')}>
                            {[s.first_name, s.last_name, s.patronymic].filter(Boolean).join(' ')}
                          </a>
                        ) : (
                          <Button size="sm" icon={UserSearch} onClick={() => setRow(i, { fixing: true })}>
                            {t('cupload.choose')}
                          </Button>
                        )}
                      </td>
                      <td className="nowrap">{s?.group_name || ''}</td>
                      <td className="nowrap">{s?.contract_no || ''}</td>
                      <td className="nowrap small">
                        {r.id ? (
                          <span style={{ color: 'var(--good)' }}>{t(`cupload.how_${r.how}`)}</span>
                        ) : (
                          <span className="row" style={{ color: 'var(--warn)', gap: 4 }}>
                            <AlertTriangle size={13} /> {t(`cupload.how_${r.how}`)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
