import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Trash2, Building2, Monitor, Network, History, Save, RefreshCw, FolderOpen, DatabaseBackup, Upload, Copy, LogOut, Server, Receipt, UserCog, ImagePlus, BellRing, Cloud, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useT } from '../i18n';
import { useRpc, rpc, fmtDateTime, currentPeriod, fitImage } from '../lib';
import { HdmSettings } from '../components/Hdm';
import { UpdateSettings } from '../components/Updates';
import { NotifySettings } from '../components/Notify';
import { MyAccount, UsersSettings, useAuth } from '../components/Auth';
import { Badge, BrandLogo, Button, Field, Loading, Segmented, Tabs, useAction, useConfirm, useToast } from '../components/ui';

export default function Settings({ route, appState, setAppState }) {
  const t = useT();
  const auth = useAuth();
  // Club, network and activity need the Settings right; Users is for admins (or anyone while sign-in is off).
  const tabs = [
    auth.can('settings', 'view') && { id: 'club', label: t('settings.club'), icon: Building2 },
    { id: 'pc', label: t('settings.thisPc'), icon: Monitor },
    auth.can('settings', 'view') && { id: 'network', label: t('settings.network'), icon: Network },
    auth.can('settings', 'view') && { id: 'notify', label: t('notify.tab'), icon: BellRing },
    (!auth.required || auth.user?.is_admin) && { id: 'users', label: t('users.tab'), icon: UserCog },
    auth.can('settings', 'view') && { id: 'activity', label: t('settings.activity'), icon: History },
  ].filter(Boolean);
  const [picked, setTab] = useState(route.tab || tabs[0].id);
  const tab = tabs.some((x) => x.id === picked) ? picked : tabs[0].id;
  return (
    <>
      <div className="page-head">
        <h1>{t('nav.settings')}</h1>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={tabs}
      />
      <div style={{ maxWidth: 820 }}>
        {tab === 'club' && <ClubSettings />}
        {tab === 'pc' && <PcSettings appState={appState} setAppState={setAppState} />}
        {tab === 'network' && <NetworkSettings appState={appState} setAppState={setAppState} />}
        {tab === 'users' && <UsersSettings />}
        {tab === 'notify' && <NotifySettings />}
        {tab === 'activity' && <ActivityLog />}
      </div>
    </>
  );
}

function ClubSettings() {
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const { data } = useRpc('settings.get');
  const [f, setF] = useState(null);
  const logoRef = useRef(null);
  useEffect(() => {
    if (data && !f) setF(data);
  }, [data]);
  if (!f) return <Loading />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const demoLoaded = data?.demo_loaded === '1';
  const toggleDemo = async () => {
    const ok = await confirm(
      demoLoaded
        ? { title: t('demo.remove'), text: t('demo.removeConfirm'), confirmLabel: t('demo.remove') }
        : { title: t('demo.load'), text: t('demo.loadConfirm'), confirmLabel: t('demo.load'), danger: false }
    );
    if (!ok) return;
    const r = await act(() => rpc(demoLoaded ? 'demo.clear' : 'demo.load'), demoLoaded ? t('demo.removed') : t('demo.loaded'));
    if (r) setF(null);
  };
  return (
    <>
    <div className="card settings-section">
      <div className="card-pad">
        <Field label={t('logo.title')} hint={t('logo.hint')}>
          <div className="row" style={{ gap: 14 }}>
            <BrandLogo size={64} logo={f.club_logo || null} />
            <Button
              icon={ImagePlus}
              onClick={() => logoRef.current.click()}
            >
              {f.club_logo ? t('logo.change') : t('logo.upload')}
            </Button>
            {f.club_logo && (
              <Button variant="ghost" icon={Trash2} onClick={() => setF({ ...f, club_logo: '' })}>
                {t('common.remove')}
              </Button>
            )}
            <input
              ref={logoRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) setF({ ...f, club_logo: await fitImage(file, 256) });
              }}
            />
          </div>
        </Field>
        <div className="grid-2">
          <Field label={t('settings.clubName')} className="span-2">
            <input className="input" value={f.club_name || ''} onChange={set('club_name')} />
          </Field>
          <Field label={t('settings.clubAddress')}>
            <input className="input" value={f.club_address || ''} onChange={set('club_address')} />
          </Field>
          <Field label={t('settings.clubPhone')}>
            <input className="input" value={f.club_phone || ''} onChange={set('club_phone')} />
          </Field>
          <Field label={t('settings.director')}>
            <input className="input" value={f.director_name || ''} onChange={set('director_name')} />
          </Field>
          <Field label={t('settings.currency')}>
            <select className="select" value={f.currency || 'AMD'} onChange={set('currency')}>
              {['AMD', 'USD', 'EUR', 'RUB', 'GEL'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label={t('settings.dueDay')} hint={t('settings.dueDayHint')}>
            <input className="input" type="number" min="1" max="28" value={f.due_day || 10} onChange={set('due_day')} />
          </Field>
          <Field label={t('settings.billingStart')} hint={t('settings.billingStartHint')}>
            <input className="input" type="month" value={f.billing_start || currentPeriod()} onChange={set('billing_start')} />
          </Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" icon={Save} onClick={() => act(() => rpc('settings.update', f), t('common.saved'))}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
    <div className="card settings-section">
      <div className="card-head">
        <FlaskConical size={17} />
        <h3>{t('demo.title')}</h3>
        <div className="spacer" />
        {demoLoaded && <Badge tone="warn">{t('demo.active')}</Badge>}
      </div>
      <div className="card-pad">
        <div className="muted small">{demoLoaded ? t('demo.loadedText') : t('demo.text')}</div>
        <div className="row">
          <Button variant={demoLoaded ? 'danger' : undefined} icon={demoLoaded ? Trash2 : FlaskConical} onClick={toggleDemo}>
            {demoLoaded ? t('demo.remove') : t('demo.load')}
          </Button>
        </div>
      </div>
    </div>
    </>
  );
}

function PcSettings({ appState, setAppState }) {
  const t = useT();
  const toast = useToast();
  const [operator, setOperator] = useState(appState.config.operator || '');
  const update = async (patch) => setAppState(await window.fc.updateLocal(patch));
  const auth = useAuth();
  return (
    <>
    <MyAccount />
    <div className="card settings-section">
      <div className="card-pad">
        {!auth.required && <Field label={t('setup.yourName')} hint={t('setup.yourNameHint')}>
          <div className="row">
            <input className="input" value={operator} onChange={(e) => setOperator(e.target.value)} />
            <Button
              onClick={async () => {
                await update({ operator: operator.trim() });
                toast.success(t('common.saved'));
              }}
            >
              {t('common.save')}
            </Button>
          </div>
        </Field>}
        <Field label={t('settings.language')}>
          <Segmented
            value={appState.config.language}
            onChange={(language) => update({ language })}
            options={[
              { value: 'en', label: 'English' },
              { value: 'hy', label: 'Հայերեն' },
            ]}
          />
        </Field>
        <Field label={t('settings.theme')}>
          <Segmented
            value={appState.config.theme}
            onChange={(theme) => update({ theme })}
            options={['system', 'light', 'dark'].map((v) => ({ value: v, label: t(`theme.${v}`) }))}
          />
        </Field>
        <Field hint={t('settings.autoStartHint')}>
          <label className="check">
            <input type="checkbox" checked={appState.config.autoStart !== false} onChange={(e) => update({ autoStart: e.target.checked })} />
            <span className="strong">{t('settings.autoStart')}</span>
          </label>
        </Field>
      </div>
    </div>
    <div className="card settings-section">
      <div className="card-head">
        <RefreshCw size={17} />
        <h3>{t('update.title')}</h3>
      </div>
      <div className="card-pad">
        <UpdateSettings />
      </div>
    </div>
    {auth.can('payments') && <div className="card settings-section">
      <div className="card-head">
        <Receipt size={17} />
        <h3>{t('hdm.section')}</h3>
        <div className="spacer" />
        {appState.config.hdm?.enabled && (
          <Badge tone={appState.config.hdm.mode === 'device' ? 'good' : 'warn'}>
            {t(appState.config.hdm.mode === 'device' ? 'hdm.mode_device' : 'hdm.mode_test')}
          </Badge>
        )}
      </div>
      <div className="card-pad">
        <HdmSettings settings={appState.config.hdm} onChange={(hdm) => update({ hdm })} />
      </div>
    </div>}
    </>
  );
}

function NetworkSettings({ appState, setAppState }) {
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const [backups, setBackups] = useState(null);
  const host = appState.host;
  const isHost = appState.config.mode === 'host';

  const loadBackups = () => window.fc.backup.list().then(setBackups);
  useEffect(() => {
    if (isHost) loadBackups();
  }, [isHost]);

  const switchMode = async () => {
    if (!(await confirm({ title: t('settings.changeMode'), text: t('settings.changeModeConfirm'), confirmLabel: t('settings.changeMode') }))) return;
    setAppState(await window.fc.resetMode());
  };

  return (
    <>
      <div className="card settings-section">
        <div className="card-head">
          <Server size={17} />
          <h3>{isHost ? t('settings.thisIsHost') : t('settings.thisIsClient')}</h3>
          <div className="spacer" />
          {isHost ? (
            <Badge tone={host?.running ? 'good' : 'bad'}>{host?.running ? t('settings.sharing') : t('settings.notSharing')}</Badge>
          ) : (
            <Badge tone={appState.online !== false ? 'good' : 'bad'}>{appState.online !== false ? t('conn.connected') : t('conn.offline')}</Badge>
          )}
        </div>
        <div className="card-pad">
          {isHost ? (
            <>
              <div className="muted small">{t('settings.hostHelp')}</div>
              <div className="grid-2">
                <Field label={t('settings.addresses')}>
                  <div className="stack" style={{ gap: 4 }}>
                    {host.addresses.length ? (
                      host.addresses.map((a) => (
                        <div key={a} className="strong num">
                          {a}:{host.port}
                        </div>
                      ))
                    ) : (
                      <span className="muted">{t('settings.noNetwork')}</span>
                    )}
                  </div>
                </Field>
                <Field label={t('setup.accessCode')}>
                  <div className="row">
                    <span className="code-box">{host.accessKey}</span>
                    <Button
                      icon={Copy}
                      onClick={() => {
                        navigator.clipboard.writeText(host.accessKey);
                        toast.success(t('common.copied'));
                      }}
                    />
                    <Button
                      icon={RefreshCw}
                      title={t('settings.newCode')}
                      onClick={async () =>
                        (await confirm({ text: t('settings.newCodeConfirm'), confirmLabel: t('settings.newCode') })) &&
                        setAppState(await window.fc.newAccessKey())
                      }
                    />
                  </div>
                </Field>
              </div>
              {!host.running && <div className="small" style={{ color: 'var(--bad)' }}>{t('settings.portBusy', { port: host.port })}</div>}
              <div className="small muted">{t('settings.firewallHint')}</div>
            </>
          ) : (
            <dl className="kv">
              <dt>{t('setup.hostAddress')}</dt>
              <dd className="strong">
                {appState.config.hostAddress}:{appState.config.hostPort}
              </dd>
              <dt>{t('setup.accessCode')}</dt>
              <dd>{appState.config.accessKey}</dd>
            </dl>
          )}
          <div className="row">
            <Button icon={LogOut} onClick={switchMode}>
              {t('settings.changeMode')}
            </Button>
          </div>
        </div>
      </div>

      {isHost && (
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
          </div>
        </div>
      )}
    </>
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

function ActivityLog() {
  const t = useT();
  const { data } = useRpc('activity.list', { limit: 300 });
  if (!data) return <Loading />;
  return (
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
          {data.map((a) => (
            <tr key={a.id}>
              <td className="small nowrap">{fmtDateTime(a.at)}</td>
              <td className="small">{a.user || '—'}</td>
              <td className="small">
                <span className="strong">{t(`activity.${a.action}`)}</span>
                {a.details && <span className="muted"> · {a.details}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
