import { useMemo, useState } from 'react';
import { FileUp, Upload, CheckCircle2, AlertTriangle, Wand2 } from 'lucide-react';
import { useT } from '../i18n';
import { rpc } from '../lib';
import { Button, Field, Modal, Segmented, useAction } from './ui';

const CATEGORY_KEYS = ['siblings', 'half', 'war', 'staff'];

// FC Manager fields a file column can be matched to. `alias`: header words that match automatically.
const FIELDS = [
  { id: 'full_name', label: 'import.fullName', alias: ['full name', 'name surname', 'surname name', 'անուն ազգանուն', 'ազգանուն անուն', 'անուն ազգանուն հայրանուն', 'ազգանուն անուն հայրանուն', 'սան', 'սանի անուն', 'ф и о', 'фио'] },
  { id: 'first_name', label: 'students.firstName', alias: ['first name', 'firstname', 'name', 'անուն', 'имя'] },
  { id: 'last_name', label: 'students.lastName', alias: ['last name', 'lastname', 'surname', 'ազգանուն', 'фамилия'] },
  { id: 'patronymic', label: 'students.patronymic', alias: ['patronymic', 'middle name', 'հայրանուն', 'отчество'] },
  { id: 'birth_date', label: 'students.birthDate', type: 'date', alias: ['birth date', 'birthdate', 'date of birth', 'dob', 'ծննդյան ամսաթիվ', 'ծննդյան օր', 'дата рождения'] },
  { id: 'document_no', label: 'students.documentNo', alias: ['birth certificate', 'document', 'ծննդյան վկայական', 'անձնագիր', 'փաստաթուղթ'] },
  { id: 'contract_no', label: 'students.contractNo', alias: ['contract', 'contract no', 'պայմանագրի համար', 'պայմանագիր', 'договор'] },
  { id: 'medical_doc', label: 'students.medicalDoc', type: 'bool', alias: ['medical', 'բժ. թուղթ', 'բժշկական', 'բժ թուղթ', 'справка'] },
  { id: 'parent_full_name', label: 'import.parentFullName', alias: ['parent', 'parent name', 'ծնող', 'ծնողի անուն', 'родитель'] },
  { id: 'parent_first_name', label: 'import.parentFirst', alias: ['parent first name', 'ծնողի անունը'] },
  { id: 'parent_last_name', label: 'import.parentLast', alias: ['parent last name', 'ծնողի ազգանուն'] },
  { id: 'parent_phone', label: 'import.parentPhone', alias: ['phone', 'parent phone', 'mobile', 'հեռախոս', 'ծնողի հեռախոս', 'телефон'] },
  { id: 'parent_email', label: 'import.parentEmail', alias: ['email', 'e-mail', 'էլ. փոստ', 'էլ փոստ', 'почта'] },
  { id: 'parent_ssn', label: 'import.parentSsn', alias: ['ssn', 'հծհ', 'հանրային ծառայության համարանիշ'] },
  { id: 'parent_doc_no', label: 'import.parentDocNo', alias: ['passport', 'id card', 'ծնողի անձնագիր', 'անձնագրի համար', 'паспорт'] },
  { id: 'parent_doc_issuer', label: 'import.parentDocIssuer', alias: ['issued by', 'ում կողմից'] },
  { id: 'parent_doc_date', label: 'import.parentDocDate', type: 'date', alias: ['issue date', 'տրման ամսաթիվ'] },
  { id: 'parent_address', label: 'import.parentAddress', alias: ['address', 'հասցե', 'адрес'] },
  { id: 'group_name', label: 'students.group', alias: ['group', 'team', 'խումբ', 'թիմ', 'группа'] },
  { id: 'monthly_fee', label: 'students.monthlyFee', type: 'money', alias: ['fee', 'monthly fee', 'ամսավճար', 'վճար', 'оплата'] },
  { id: 'join_date', label: 'students.joinDate', type: 'date', alias: ['join date', 'start date', 'միանալու ամսաթիվ', 'անդամակցության ամսաթիվ'] },
  { id: 'service', label: 'students.service', alias: ['service', 'ծառայություն', 'ծառայություններ'] },
  { id: 'category', label: 'students.category', type: 'category', alias: ['category', 'կարգավիճակ', 'զեղչ'] },
  { id: 'status', label: 'students.status', type: 'status', alias: ['status', 'active', 'ակտիվություն', 'статус'] },
  { id: 'inactive_reason', label: 'students.inactiveReason', alias: ['reason', 'պատճառ'] },
  { id: 'notes', label: 'students.notes', alias: ['notes', 'note', 'comment', 'նշումներ', 'մեկնաբանություն', 'примечание'] },
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Best file column for each field, from the header names: exact names first, then the field
// whose alias is the longest part of the header (so "Ծնողի հեռախոս" beats "հեռախոս").
function guessMapping(headers) {
  const map = {};
  const used = new Set();
  const hs = headers.map(norm);
  for (const f of FIELDS) {
    const i = hs.findIndex((h, idx) => !used.has(idx) && h && f.alias.some((a) => h === norm(a)));
    if (i >= 0) {
      map[f.id] = i;
      used.add(i);
    }
  }
  hs.forEach((h, idx) => {
    if (!h || used.has(idx)) return;
    let best = null;
    for (const f of FIELDS) {
      if (map[f.id] != null) continue;
      for (const a of f.alias.map(norm)) {
        if (a.length > 2 && h.includes(a) && (!best || a.length > best.len)) best = { id: f.id, len: a.length };
      }
    }
    if (best) {
      map[best.id] = idx;
      used.add(idx);
    }
  });
  // A full-name column makes separate first/last name columns unnecessary, and the other way round.
  if (map.first_name != null && map.last_name != null) delete map.full_name;
  return map;
}

// "20.06.2011", "20/06/2011", "2011-06-20", Excel day numbers → 2011-06-20
function toDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? (Number(m[3]) > 40 ? `19${m[3]}` : `20${m[3]}`) : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return null; // not a date we understand
}
const YES = ['1', 'yes', 'true', 'y', 'այո', 'ներկայացված', 'ներկայացված է', 'առկա', 'կա', 'provided', 'да', '+', '✓'];
const INACTIVE = ['inactive', 'no', '0', 'false', 'ոչ ակտիվ', 'ոչակտիվ', 'դուրս եկած', 'неактивен', 'left'];

function splitName(full, order) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (order === 'last-first') return { last_name: parts[0] || '', first_name: parts[1] || '', patronymic: parts.slice(2).join(' ') };
  return { first_name: parts[0] || '', last_name: parts[1] || '', patronymic: parts.slice(2).join(' ') };
}

// One file row → student fields; problems go to `warn`.
function convertRow(row, map, opts, t) {
  const out = {};
  const warn = [];
  const get = (id) => (map[id] != null ? String(row[map[id]] ?? '').trim() : '');
  for (const f of FIELDS) {
    const v = get(f.id);
    if (!v) continue;
    if (f.id === 'full_name') Object.assign(out, Object.fromEntries(Object.entries(splitName(v, opts.order)).filter(([k, x]) => x && !get(k))));
    else if (f.id === 'parent_full_name') {
      const p = splitName(v, opts.parentOrder);
      if (!get('parent_first_name')) out.parent_first_name = p.first_name;
      if (!get('parent_last_name')) out.parent_last_name = p.last_name;
    } else if (f.type === 'date') {
      const d = toDate(v);
      if (d) out[f.id] = d;
      else warn.push(`${t(f.label)}: “${v}”`);
    } else if (f.type === 'bool') out[f.id] = YES.includes(v.toLowerCase()) ? 1 : 0;
    else if (f.type === 'money') out[f.id] = Number(v.replace(/[^\d.,-]/g, '').replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.')) || 0;
    else if (f.type === 'status') out[f.id] = INACTIVE.includes(v.toLowerCase()) ? 'inactive' : 'active';
    else if (f.type === 'category') {
      const key = CATEGORY_KEYS.find((k) => norm(t(`category.${k}`)) === norm(v) || k === v.toLowerCase());
      if (key) out[f.id] = key;
      else warn.push(`${t(f.label)}: “${v}”`);
    } else out[f.id] = v;
  }
  if (!out.first_name || !out.last_name) warn.push(t('import.noName'));
  return { data: out, warn };
}

export function ImportModal({ onClose }) {
  const t = useT();
  const act = useAction();
  const [file, setFile] = useState(null); // { fileName, sheets }
  const [sheet, setSheet] = useState(0);
  const [header, setHeader] = useState(true);
  const [map, setMap] = useState({});
  const [opts, setOpts] = useState({ order: 'first-last', parentOrder: 'first-last', mode: 'skip', createGroups: true });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const rows = file?.sheets[sheet]?.rows || [];
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const headers = header && rows[0] ? rows[0].map((h, i) => h || `${t('import.column')} ${i + 1}`) : Array.from({ length: width }, (_, i) => `${t('import.column')} ${i + 1}`);
  const body = header ? rows.slice(1) : rows;

  const pick = async () => {
    const r = await act(async () => {
      const res = await window.fc.importRead();
      if (!res.ok) throw Object.assign(new Error(res.error), { code: res.error, detail: res.detail });
      return res.result;
    });
    if (!r) return;
    if (!r.sheets.length) return act(() => Promise.reject(Object.assign(new Error(), { code: 'IMPORT_EMPTY' })));
    setFile(r);
    setSheet(0);
    setResult(null);
    setMap(guessMapping(r.sheets[0].rows[0] || []));
  };

  const converted = useMemo(() => body.map((r) => convertRow(r, map, opts, t)), [body, map, opts, t]);
  const valid = converted.filter((c) => c.data.first_name && c.data.last_name);
  const withWarnings = converted.filter((c) => c.warn.length);
  const mappedCount = Object.values(map).filter((v) => v != null).length;

  const run = async () => {
    setBusy(true);
    const r = await act(() => rpc('students.import', { rows: valid.map((c) => c.data), mode: opts.mode, createGroups: opts.createGroups }));
    setBusy(false);
    if (r) setResult(r);
  };

  if (result)
    return (
      <Modal
        title={t('import.title')}
        onClose={onClose}
        width={520}
        footer={
          <Button variant="primary" onClick={onClose}>
            {t('hdm.done')}
          </Button>
        }
      >
        <div className="stack">
          <div className="row strong" style={{ color: 'var(--good)' }}>
            <CheckCircle2 size={18} /> {t('import.finished')}
          </div>
          <div className="import-stats">
            <div><b>{result.created}</b>{t('import.created')}</div>
            <div><b>{result.updated}</b>{t('import.updated')}</div>
            <div><b>{result.skipped}</b>{t('import.skipped')}</div>
            <div><b>{result.groupsCreated}</b>{t('import.groupsCreated')}</div>
          </div>
          {result.errors.length > 0 && (
            <div className="small" style={{ color: 'var(--bad)' }}>
              {result.errors.slice(0, 10).map((e) => (
                <div key={e.row}>
                  {t('import.row', { n: e.row })}: {t(`error.${e.error}`)}
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    );

  return (
    <Modal
      title={t('import.title')}
      onClose={onClose}
      width={file ? 980 : 560}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          {file && (
            <Button variant="primary" icon={Upload} onClick={run} disabled={busy || !valid.length}>
              {t('import.run', { n: valid.length })}
            </Button>
          )}
        </>
      }
    >
      {!file ? (
        <div className="stack" style={{ alignItems: 'flex-start' }}>
          <div className="small muted">{t('import.intro')}</div>
          <Button variant="primary" icon={FileUp} onClick={pick}>
            {t('import.pick')}
          </Button>
        </div>
      ) : (
        <div className="stack">
          <div className="row wrap" style={{ gap: 14 }}>
            <span className="strong">{file.fileName}</span>
            {file.sheets.length > 1 && (
              <select
                className="select"
                style={{ width: 'auto' }}
                value={sheet}
                onChange={(e) => {
                  setSheet(Number(e.target.value));
                  setMap(guessMapping(file.sheets[Number(e.target.value)].rows[0] || []));
                }}
              >
                {file.sheets.map((s, i) => (
                  <option key={i} value={i}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
            <label className="check small">
              <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
              {t('import.hasHeader')}
            </label>
            <span className="small muted">{t('import.rowsFound', { n: body.length })}</span>
            <div className="grow" />
            <Button size="sm" onClick={pick}>
              {t('import.otherFile')}
            </Button>
          </div>

          <div className="import-grid">
            <div>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="strong grow">{t('import.mapping')}</span>
                <Button size="sm" variant="ghost" icon={Wand2} onClick={() => setMap(guessMapping(header ? rows[0] || [] : []))}>
                  {t('import.autoMatch')}
                </Button>
              </div>
              <div className="small muted" style={{ marginBottom: 8 }}>{t('import.mappingHint', { n: mappedCount })}</div>
              <div className="import-map">
                {FIELDS.map((f) => {
                  const col = map[f.id];
                  const sample = col != null ? body.find((r) => r[col])?.[col] : '';
                  return (
                    <div key={f.id} className={`import-map-row ${col != null ? 'on' : ''}`}>
                      <span className="import-field">{t(f.label)}</span>
                      <select
                        className="select"
                        value={col ?? ''}
                        onChange={(e) => setMap({ ...map, [f.id]: e.target.value === '' ? null : Number(e.target.value) })}
                      >
                        <option value="">— {t('import.skip')} —</option>
                        {headers.map((h, i) => (
                          <option key={i} value={i}>
                            {h}
                          </option>
                        ))}
                      </select>
                      <span className="small muted import-sample" title={sample}>{sample || ''}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="stack" style={{ gap: 14 }}>
              <Field label={t('import.nameOrder')} hint={t('import.nameOrderHint')}>
                <Segmented
                  value={opts.order}
                  onChange={(order) => setOpts({ ...opts, order })}
                  options={[
                    { value: 'first-last', label: t('import.firstLast') },
                    { value: 'last-first', label: t('import.lastFirst') },
                  ]}
                />
              </Field>
              <Field label={t('import.parentOrder')}>
                <Segmented
                  value={opts.parentOrder}
                  onChange={(parentOrder) => setOpts({ ...opts, parentOrder })}
                  options={[
                    { value: 'first-last', label: t('import.firstLast') },
                    { value: 'last-first', label: t('import.lastFirst') },
                  ]}
                />
              </Field>
              <Field label={t('import.existing')} hint={t('import.existingHint')}>
                <Segmented
                  value={opts.mode}
                  onChange={(mode) => setOpts({ ...opts, mode })}
                  options={[
                    { value: 'skip', label: t('import.modeSkip') },
                    { value: 'update', label: t('import.modeUpdate') },
                  ]}
                />
              </Field>
              <label className="check small">
                <input type="checkbox" checked={opts.createGroups} onChange={(e) => setOpts({ ...opts, createGroups: e.target.checked })} />
                {t('import.createGroups')}
              </label>
              <div className="small">
                <div className="strong">{t('import.ready', { n: valid.length, total: body.length })}</div>
                {withWarnings.length > 0 && (
                  <div style={{ color: 'var(--warn)', marginTop: 6 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <AlertTriangle size={14} /> {t('import.warnings', { n: withWarnings.length })}
                    </div>
                    <ul className="import-warn">
                      {converted
                        .map((c, i) => ({ ...c, i }))
                        .filter((c) => c.warn.length)
                        .slice(0, 8)
                        .map((c) => (
                          <li key={c.i}>
                            {t('import.row', { n: c.i + 1 + (header ? 1 : 0) })}: {c.warn.join('; ')}
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div>
            <div className="strong small" style={{ marginBottom: 6 }}>{t('import.preview')}</div>
            <div className="table-wrap" style={{ maxHeight: 220 }}>
              <table className="table">
                <thead>
                  <tr>
                    {[
                      'students.firstName', 'students.lastName', 'students.patronymic', 'students.birthDate', 'students.group',
                      'students.monthlyFee', 'import.parentFullName', 'import.parentPhone',
                    ].map((k) => (
                      <th key={k}>{t(k)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {converted.slice(0, 6).map(({ data: d }, i) => (
                    <tr key={i}>
                      <td>{d.first_name || <span className="bad-text">?</span>}</td>
                      <td>{d.last_name || <span className="bad-text">?</span>}</td>
                      <td>{d.patronymic}</td>
                      <td className="nowrap">{d.birth_date}</td>
                      <td>{d.group_name}</td>
                      <td className="num">{d.monthly_fee || ''}</td>
                      <td>{[d.parent_first_name, d.parent_last_name].filter(Boolean).join(' ')}</td>
                      <td className="nowrap">{d.parent_phone}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
