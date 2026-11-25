// Settings → Data management: everything that moves club data in or out of FC Manager
// (importing students, exporting them for another FC Manager, database backups).
// Printing and Excel/CSV reports stay on their own pages.
import { useEffect, useState } from 'react';
import { FileUp, ArrowRightLeft, DatabaseBackup, FolderOpen, Upload, Cloud, CheckCircle2, AlertTriangle, Trash2, LogIn, LogOut, RefreshCw, HardDriveDownload } from 'lucide-react';
import { useT } from '../i18n';
import { useRpc, rpc, todayIso } from '../lib';
import { useAuth } from './Auth';
import { ImportModal } from './Import';
import { Button, Field, Modal, Segmented, useAction, useConfirm, useToast } from './ui';

export default function DataManagement({ appState, setAppState }) {
  const auth = useAuth();
  const isHost = appState.config.mode === 'host';
  return (
    <>
      {auth.can('students', 'edit') && <ImportCard />}
      {auth.can('students', 'view') && <TransferCard />}
      {isHost && auth.can('settings', 'view') && <BackupsCard appState={appState} setAppState={setAppState} />}
    </>
  );
}

function ImportCard() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="card settings-section">
      <div className="card-head">
        <FileUp size={17} />
        <h3>{t('data.importTitle')}</h3>
      </div>
      <div className="card-pad">
        <div className="muted small">{t('data.importText')}</div>
        <div className="row">
          <Button variant="primary" icon={FileUp} onClick={() => setOpen(true)}>
            {t('import.button')}
          </Button>
        </div>
      </div>
      {open && <ImportModal onClose={() => setOpen(false)} />}
    </div>
  );
}

// Students (with their payments) to an Excel file another FC Manager imports (the hidden "_fcmanager" sheets).
function TransferCard() {
  const t = useT();
  const act = useAction();
  const [groupId, setGroupId] = useState('');
  const [status, setStatus] = useState('active');
  const { data: groups } = useRpc('groups.list');
  const { data: rows } = useRpc('students.list', { status: status || null, groupId: groupId ? Number(groupId) : null });

  const run = () => {
    const cols = [
      ['first_name', 'students.firstName'], ['last_name', 'students.lastName'], ['patronymic', 'students.patronymic'],
      ['birth_date', 'students.birthDate'], ['document_no', 'students.documentNo'], ['group_name', 'students.group'],
      ['contract_no', 'students.contractNo'], ['medical_doc', 'students.medicalDoc'], ['category', 'students.category'],
      ['service', 'students.service'], ['monthly_fee', 'students.monthlyFee'], ['join_date', 'students.joinDate'],
      ['status', 'students.status'], ['inactive_reason', 'students.inactiveReason'], ['leave_date', 'students.leaveDate'], ['notes', 'students.notes'],
      ['parent_first_name', 'import.parentFirst'], ['parent_last_name', 'import.parentLast'], ['parent_phone', 'import.parentPhone'],
      ['parent_messenger', 'import.parentMessenger'], ['parent_email', 'import.parentEmail'], ['parent_doc_no', 'import.parentDocNo'],
      ['parent_doc_date', 'import.parentDocDate'], ['parent_doc_issuer', 'import.parentDocIssuer'], ['parent_ssn', 'import.parentSsn'],
      ['parent_address', 'import.parentAddress'],
    ].map(([key, label]) => ({ key, header: t(label), width: ['parent_address', 'notes'].includes(key) ? 34 : 16 }));
    const value = (s, k) => {
      if (k === 'medical_doc') return s.medical_doc ? t('common.yes') : t('common.no');
      if (k === 'category') return s.category ? t(`category.${s.category}`) : '';
      if (k === 'status') return t(`status.${s.status}`);
      return s[k] ?? '';
    };
    const group = groupId ? (groups || []).find((g) => String(g.id) === String(groupId))?.name : null;
    // Their payments go along in a second sheet, linked by contract № (or name + birth date).
    const keyOf = (s) => s.contract_no || `${s.first_name}|${s.last_name}|${s.birth_date || ''}`;
    const chargeCols = ['student_key', 'kind', 'period', 'description', 'amount', 'due_date', 'status', 'paid_at', 'method', 'note'];
    act(async () => {
      const ids = new Map(rows.map((s) => [s.id, keyOf(s)]));
      const all = await rpc('charges.list', {});
      const charges = all.filter((c) => ids.has(c.student_id) && !c.excused_by);
      // Everything about these students (documents, attendance, contracts…) plus the readable table.
      const data = await rpc('students.export', { studentIds: rows.map((s) => s.id) });
      const r = await window.fc.saveTransfer({
        defaultName: `FC-Manager-${group || 'all'}-${todayIso()}.zip`,
        data,
        xlsx: {
        columns: cols,
        rows: rows.map((s) => Object.fromEntries(cols.map((c) => [c.key, value(s, c.key)]))),
        charges: {
          columns: chargeCols,
          headers: [t('import.studentKey'), t('payments.type'), t('payments.month'), t('payments.description'), t('payments.amount'), t('payments.dueDate'), t('payments.status'), t('payments.paidAt'), t('payments.method'), t('payments.note')],
          rows: charges.map((c) => chargeCols.map((k) => (k === 'student_key' ? ids.get(c.student_id) : c[k] ?? ''))),
        },
        },
      });
      if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error, detail: r.detail });
    }, t('transfer.saved', { n: rows.length }));
  };

  return (
    <div className="card settings-section">
      <div className="card-head">
        <ArrowRightLeft size={17} />
        <h3>{t('transfer.button')}</h3>
      </div>
      <div className="card-pad">
        <div className="muted small">{t('transfer.hint')}</div>
        <div className="grid-2">
          <Field label={t('students.group')}>
            <select className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">{t('students.allGroups')}</option>
              {(groups || []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('students.status')}>
            <Segmented
              value={status}
              onChange={setStatus}
              options={[
                { value: 'active', label: t('status.active') },
                { value: 'inactive', label: t('status.inactive') },
                { value: '', label: t('common.all') },
              ]}
            />
          </Field>
        </div>
        <div className="row">
          <Button variant="primary" icon={ArrowRightLeft} onClick={run} disabled={!rows?.length}>
            {t('data.exportN', { n: rows?.length ?? 0 })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function BackupsCard({ appState, setAppState }) {
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const [backups, setBackups] = useState(null);
  const host = appState.host;
  const loadBackups = () => window.fc.backup.list().then(setBackups);
  useEffect(() => {
    loadBackups();
  }, []);

  return (
    <div className="card settings-section">
      <div className="card-head">
        <DatabaseBackup size={17} />
        <h3>{t('settings.backups')}</h3>
      </div>
      <div className="card-pad">
        <div className="muted small">{t('settings.backupHelp')}</div>
        <div className="small">
          {t('settings.dbLocation')}: <span className="num">{host.dbPath}</span>
        </div>
        <div className="row wrap">
          <Button
            variant="primary"
            icon={DatabaseBackup}
            onClick={async () => {
              const r = await window.fc.backup.create();
              r.ok ? toast.success(t('settings.backupDone')) : toast.error(r.error);
              loadBackups();
              setAppState(await window.fc.state());
            }}
          >
            {t('settings.backupNow')}
          </Button>
          <Button icon={FolderOpen} onClick={() => window.fc.backup.openFolder()}>
            {t('settings.openBackups')}
          </Button>
          <Button
            icon={Upload}
            variant="danger"
            onClick={async () => {
              if (!(await confirm({ title: t('settings.restore'), text: t('settings.restoreConfirm'), confirmLabel: t('settings.restore') }))) return;
              const r = await window.fc.backup.restore();
              if (r.ok) {
                toast.success(t('settings.restored'));
                loadBackups();
              } else if (r.error !== 'CANCELLED') toast.error(r.error);
            }}
          >
            {t('settings.restore')}
          </Button>
        </div>
        {backups?.length > 0 && (
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table className="table">
              <tbody>
                {backups.slice(0, 15).map((b) => (
                  <tr key={b.name}>
                    <td className="small">{b.name}</td>
                    <td className="small muted nowrap">{new Date(b.at).toLocaleString('en-GB')}</td>
                    <td className="small muted num">{(b.size / 1024).toFixed(0)} KB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <OneDriveBackups cloud={host.cloud} setAppState={setAppState} />
        <GoogleDriveBackups initial={host.gdrive} onRestored={loadBackups} />
      </div>
    </div>
  );
}

// Copies every backup into the OneDrive folder on the host PC; the OneDrive app uploads it to the cloud.
function OneDriveBackups({ cloud = {}, setAppState }) {
  const t = useT();
  const set = async (patch) => setAppState(await window.fc.backup.cloudSet(patch));
  return (
    <div className="cloud-box">
      <div className="row">
        <Cloud size={18} />
        <span className="strong">OneDrive</span>
      </div>
      <label className="check">
        <input type="checkbox" checked={!!cloud.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        {t('cloud.enable')}
      </label>
      <div className="small muted">{t('cloud.help')}</div>
      {!cloud.oneDrive && !cloud.folder && <div className="small" style={{ color: 'var(--warn)' }}>{t('cloud.notFound')}</div>}
      <div className="row wrap small">
        <span className="muted">{t('cloud.folder')}:</span>
        <span className="num">{cloud.folder || '—'}</span>
      </div>
      <div className="row wrap">
        <Button
          size="sm"
          icon={FolderOpen}
          onClick={async () => {
            const folder = await window.fc.backup.cloudPick();
            if (folder) set({ folder });
          }}
        >
          {t('cloud.change')}
        </Button>
        {cloud.folder && (
          <Button size="sm" onClick={() => window.fc.backup.cloudOpen()}>
            {t('cloud.open')}
          </Button>
        )}
      </div>
      {cloud.enabled &&
        (cloud.lastError ? (
          <div className="row small" style={{ color: 'var(--bad)' }}>
            <AlertTriangle size={15} />
            {cloud.lastError === 'NO_ONEDRIVE' ? t('cloud.notFound') : t('cloud.failed', { error: cloud.lastError })}
          </div>
        ) : cloud.lastAt ? (
          <div className="row small" style={{ color: 'var(--good)' }}>
            <CheckCircle2 size={15} />
            {t('cloud.last', { at: new Date(cloud.lastAt).toLocaleString('en-GB'), file: cloud.lastFile })}
          </div>
        ) : null)}
    </div>
  );
}

// Sends every backup to Google Drive through a Google sign-in (Drive API; only this app's own files).
const gdriveError = (t, code, detail) => {
  const key = `gdrive.error.${code}`;
  return t(key) === key ? `${code}${detail && detail !== code ? ` — ${detail}` : ''}` : t(key);
};

function GoogleDriveBackups({ initial, onRestored }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [st, setSt] = useState(initial || {});
  const [form, setForm] = useState({ clientId: initial?.clientId || '', clientSecret: '' });
  const [editing, setEditing] = useState(!initial?.configured);
  const [busy, setBusy] = useState('');
  const [files, setFiles] = useState(null);
  useEffect(() => {
    window.fc.backup.gdriveStatus().then((s) => {
      setSt(s);
      setEditing(!s.configured);
      setForm((f) => ({ ...f, clientId: s.clientId || f.clientId }));
    });
    return window.fc.backup.onGdrive?.(setSt);
  }, []);
  const call = async (what, fn, ok) => {
    setBusy(what);
    try {
      const r = await fn();
      if (!r.ok) {
        if (r.error !== 'CANCELLED') toast.error(gdriveError(t, r.error, r.detail));
        return null;
      }
      if (ok) toast.success(ok);
      return r.result ?? true;
    } finally {
      setBusy('');
      setSt(await window.fc.backup.gdriveStatus());
    }
  };
  const save = async () => {
    const r = await call('save', () => window.fc.backup.gdriveSet({ clientId: form.clientId, ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}) }));
    if (r) {
      setEditing(false);
      setForm((f) => ({ ...f, clientSecret: '' }));
    }
  };
  const loadFiles = async () => {
    const r = await call('list', () => window.fc.backup.gdriveList());
    setFiles(Array.isArray(r) ? r : []);
  };
  const restore = async (f) => {
    if (!(await confirm({ title: t('settings.restore'), text: t('gdrive.restoreConfirm', { name: f.name }), confirmLabel: t('settings.restore') }))) return;
    const r = await call('restore', () => window.fc.backup.gdriveRestore({ id: f.id, name: f.name }), t('settings.restored'));
    if (r) onRestored?.();
  };

  return (
    <div className="cloud-box">
      <div className="row">
        <Cloud size={18} />
        <span className="strong">Google Drive</span>
        {st.connected && <span className="small muted">· {st.email || t('gdrive.connected')}</span>}
      </div>

      {(editing || !st.configured) && (
        <>
          <div className="small muted">{t('gdrive.setupIntro')}</div>
          <details className="small">
            <summary className="link-btn">{t('gdrive.howTo')}</summary>
            <ol style={{ margin: '8px 0 0', paddingLeft: 20, display: 'grid', gap: 4 }}>
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <li key={i}>{t(`gdrive.step${i}`)}</li>
              ))}
            </ol>
          </details>
          <div className="grid-2">
            <Field label="Client ID">
              <input className="input" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} placeholder="…apps.googleusercontent.com" />
            </Field>
            <Field label="Client secret">
              <input
                className="input"
                type="password"
                value={form.clientSecret}
                onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
                placeholder={st.hasSecret ? '••••••••' : 'GOCSPX-…'}
              />
            </Field>
          </div>
          <div className="row">
            <Button size="sm" variant="primary" onClick={save} disabled={!form.clientId.trim() || (!form.clientSecret.trim() && !st.hasSecret) || !!busy}>
              {t('common.save')}
            </Button>
            {st.configured && (
              <Button size="sm" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </Button>
            )}
          </div>
        </>
      )}

      {st.configured && !editing && !st.connected && (
        <>
          <div className="small muted">{t('gdrive.signInHint')}</div>
          {st.lastError === 'GDRIVE_REAUTH' && <div className="small" style={{ color: 'var(--warn)' }}>{t('gdrive.error.GDRIVE_REAUTH')}</div>}
          <div className="row wrap">
            <Button size="sm" variant="primary" icon={LogIn} disabled={!!busy} onClick={() => call('connect', () => window.fc.backup.gdriveConnect(), t('gdrive.connectedToast'))}>
              {busy === 'connect' ? t('gdrive.waiting') : t('gdrive.signIn')}
            </Button>
            <Button size="sm" onClick={() => setEditing(true)}>
              {t('gdrive.changeKeys')}
            </Button>
          </div>
        </>
      )}

      {st.connected && !editing && (
        <>
          <label className="check">
            <input type="checkbox" checked={!!st.enabled} onChange={(e) => call('save', () => window.fc.backup.gdriveSet({ enabled: e.target.checked }))} />
            {t('gdrive.enable')}
          </label>
          <div className="small muted">{t('gdrive.help')}</div>
          <div className="row wrap">
            <Button size="sm" icon={Upload} disabled={!!busy} onClick={() => call('upload', () => window.fc.backup.gdriveUploadNow(), t('gdrive.uploaded'))}>
              {busy === 'upload' ? t('gdrive.uploading') : t('gdrive.uploadNow')}
            </Button>
            <Button size="sm" icon={RefreshCw} disabled={!!busy} onClick={loadFiles}>
              {t('gdrive.showFiles')}
            </Button>
            <Button
              size="sm"
              icon={LogOut}
              disabled={!!busy}
              onClick={async () => {
                if (await confirm({ title: t('gdrive.disconnect'), text: t('gdrive.disconnectConfirm'), confirmLabel: t('gdrive.disconnect') }))
                  call('disconnect', () => window.fc.backup.gdriveDisconnect());
              }}
            >
              {t('gdrive.disconnect')}
            </Button>
          </div>
          {st.busy ? (
            <div className="small muted">{t('gdrive.uploading')}</div>
          ) : st.lastError ? (
            <div className="row small" style={{ color: 'var(--bad)' }}>
              <AlertTriangle size={15} />
              {t('gdrive.failed', { error: gdriveError(t, st.lastError) })}
            </div>
          ) : st.lastAt ? (
            <div className="row small" style={{ color: 'var(--good)' }}>
              <CheckCircle2 size={15} />
              {t('cloud.last', { at: new Date(st.lastAt).toLocaleString('en-GB'), file: st.lastFile })}
            </div>
          ) : null}
          {files &&
            (files.length ? (
              <div className="table-wrap" style={{ maxHeight: 240 }}>
                <table className="table">
                  <tbody>
                    {files.map((f) => (
                      <tr key={f.id}>
                        <td className="small">{f.name}</td>
                        <td className="small muted num">{(Number(f.size || 0) / 1024).toFixed(0)} KB</td>
                        <td className="right">
                          <Button size="sm" icon={HardDriveDownload} disabled={!!busy} onClick={() => restore(f)}>
                            {t('settings.restore')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="small muted">{t('gdrive.noFiles')}</div>
            ))}
        </>
      )}
    </div>
  );
}
