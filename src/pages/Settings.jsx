import { useEffect, useRef, useState } from 'react';
import { FileDigit, Trash2, Building2, Monitor, Network, History, Save, RefreshCw, Copy, LogOut, Server, Receipt, UserCog, ImagePlus, BellRing, Database, Printer, Plus, Workflow } from 'lucide-react';
import { AutomationsSettings } from '../components/Automations';
import { useT, monthName } from '../i18n';
import { feeShares, parseHolidays } from '../holidays';
import { useRpc, rpc, fmtDateTime, currentPeriod, fitImage } from '../lib';
import { HdmSettings } from '../components/Hdm';
import { ThermalSettings } from '../components/Thermal';
import { UpdateSettings } from '../components/Updates';
import { NotifySettings } from '../components/Notify';
import { MyAccount, UsersSettings, useAuth } from '../components/Auth';
import DataManagement from '../components/DataManagement';
import ActivityLog from '../components/ActivityLog';
import { useEditLock } from '../components/Locks';
import { Badge, BrandLogo, Button, Field, Loading, Segmented, Tabs, useAction, useConfirm, useToast } from '../components/ui';

export default function Settings({ route, nav, appState, setAppState }) {
  const t = useT();
  const auth = useAuth();
  // Each tab has its own tick (Settings → Users); Users is for admins (or anyone while sign-in is off).
  const tabs = [
    auth.can('settings.club') && { id: 'club', label: t('settings.club'), icon: Building2 },
    { id: 'pc', label: t('settings.thisPc'), icon: Monitor },
    auth.can('settings.hdm') && { id: 'hdm', label: t('hdm.tab'), icon: Receipt },
    auth.can('settings.network') && { id: 'network', label: t('settings.network'), icon: Network },
    ((!auth.groups && auth.canAny('students.import', 'settings.data')) || (appState.config.mode === 'host' && auth.can('settings.backups'))) && {
      id: 'data',
      label: t('data.tab'),
      icon: Database,
    },
    auth.can('settings.notify') && { id: 'notify', label: t('notify.tab'), icon: BellRing },
    (!auth.required || auth.user?.is_admin) && { id: 'users', label: t('users.tab'), icon: UserCog },
    auth.can('settings.log') && { id: 'activity', label: t('settings.activity'), icon: History },
    auth.can('settings.automations') && { id: 'automations', label: t('auto.tab'), icon: Workflow },
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
      <div style={{ maxWidth: tab === 'notify' || tab === 'activity' || tab === 'automations' ? 1180 : 820 }}>
        {tab === 'club' && <ClubSettings />}
        {tab === 'hdm' && <HdmTab appState={appState} setAppState={setAppState} />}
        {tab === 'pc' && <PcSettings appState={appState} setAppState={setAppState} />}
        {tab === 'network' && <NetworkSettings appState={appState} setAppState={setAppState} />}
        {tab === 'data' && <DataManagement appState={appState} setAppState={setAppState} />}
        {tab === 'users' && <UsersSettings />}
        {tab === 'notify' && <NotifySettings />}
        {tab === 'activity' && <ActivityLog nav={nav} />}
        {tab === 'automations' && <AutomationsSettings />}
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
  // One person changes the club settings at a time: the lock is taken at the first change.
  const lock = useEditLock('settings:club', { lazy: true, idleMs: 5 * 60 * 1000 });
  useEffect(() => {
    if (data && !f) setF(data);
  }, [data]);
  if (!f) return <Loading />;
  const set = (k) => (e) => {
    lock.ensure();
    setF({ ...f, [k]: e.target.value });
  };
  return (
    <>
    <div className="card settings-section">
      <div className="card-pad">
        {lock.banner}
        <Field label={t('logo.title')} hint={t('logo.hint')}>
          <div className="row" style={{ gap: 14 }}>
            <BrandLogo size={64} logo={f.club_logo || null} />
            <Button
              icon={ImagePlus}
              disabled={lock.readOnly}
              onClick={async () => (await lock.ensure()) && logoRef.current.click()}
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
          <Holidays
            value={f.holidays}
            onChange={(v) => {
              lock.ensure();
              setF({ ...f, holidays: v });
            }}
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" icon={Save} disabled={lock.readOnly} onClick={() => act(() => rpc('settings.update', f), t('common.saved'))}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
    <ContractNumbering />
    </>
  );
}

// «Պայմանագրերի համարակալում»: new students get «prefix + number» in order (e.g. 26-08-1130, 26-08-1131…);
// numbers already used are skipped. For a new year: a new prefix and starting number.
function ContractNumbering() {
  const t = useT();
  const act = useAction();
  const canEdit = useAuth().can('settings.club');
  const { data: next, reload } = useRpc('students.contractNo.get');
  const [f, setF] = useState(null);
  useEffect(() => {
    if (next && !f) setF({ prefix: next.prefix, from: next.from });
  }, [next]);
  if (!f) return null;
  const dirty = f.prefix !== next.prefix || String(f.from) !== String(next.from);
  const preview = `${f.prefix}${f.from}`;
  return (
    <div className="card settings-section">
      <div className="card-head">
        <FileDigit size={17} />
        <h3>{t('contractNo.title')}</h3>
      </div>
      <div className="card-pad">
        <div className="small muted">{t('contractNo.text')}</div>
        <div className="row wrap" style={{ alignItems: 'flex-end', gap: 12 }}>
          <Field label={t('contractNo.prefix')}>
            <input className="input" style={{ width: 140 }} value={f.prefix} placeholder="26-08-" disabled={!canEdit} onChange={(e) => setF({ ...f, prefix: e.target.value })} />
          </Field>
          <Field label={t('contractNo.next')}>
            <input
              className="input"
              type="number"
              min="1"
              style={{ width: 140 }}
              value={f.from}
              disabled={!canEdit}
              onChange={(e) => setF({ ...f, from: e.target.value.replace(/\D/g, '') })}
            />
          </Field>
          {canEdit && (
            <Button
              variant="primary"
              icon={Save}
              disabled={!dirty}
              onClick={async () => {
                if (await act(() => rpc('settings.update', { contract_prefix: f.prefix, contract_next: f.from }), t('common.saved'))) {
                  setF(null);
                  reload();
                }
              }}
            >
              {t('common.save')}
            </Button>
          )}
        </div>
        <div className="small">
          {!f.from ? (
            <span className="muted">{t('contractNo.off')}</span>
          ) : dirty ? (
            t('contractNo.preview', { no: preview })
          ) : (
            <>
              {t('contractNo.preview', { no: '' })}
              <span className="strong">{next.next}</span>
            </>
          )}
        </div>
      </div>
    </div>
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
    {auth.can('settings.hdm') && <div className="card settings-section">
      <div className="card-head">
        <Printer size={17} />
        <h3>{t('thermal.section')}</h3>
      </div>
      <div className="card-pad">
        <ThermalSettings settings={appState.config.thermal} onChange={(thermal) => update({ thermal })} />
      </div>
    </div>}
    </>
  );
}

// «ՀԴՄ»: the fiscal cash register of this computer (its own tab — set per computer).
function HdmTab({ appState, setAppState }) {
  const update = async (patch) => setAppState(await window.fc.updateLocal(patch));
  return <HdmSettings settings={appState.config.hdm} onChange={(hdm) => update({ hdm })} />;
}

function NetworkSettings({ appState, setAppState }) {
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const host = appState.host;
  const isHost = appState.config.mode === 'host';

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

    </>
  );
}

// Holidays: date ranges (e.g. 15.12 – 15.01). The fee works in half-months, so the months they cover cost
// less: here December and January cost 50% each. Stored as JSON [{ from, to }] in the club settings.
function Holidays({ value, onChange }) {
  const t = useT();
  const list = parseHolidays(value);
  const save = (next) => onChange(JSON.stringify(next));
  const shares = feeShares(list);
  return (
    <Field label={t('settings.holidays')} hint={t('settings.holidaysHint')} className="span-2">
      <div className="stack" style={{ gap: 6 }}>
        {list.map((h, i) => (
          <div className="row nowrap" key={i}>
            <span className="small muted">{t('settings.holidayFrom')}</span>
            <input className="input" type="date" style={{ maxWidth: 170 }} value={h.from || ''} onChange={(e) => save(list.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
            <span className="small muted">{t('settings.holidayTo')}</span>
            <input
              className="input"
              type="date"
              style={{ maxWidth: 170 }}
              value={h.to || ''}
              min={h.from || undefined}
              onChange={(e) => save(list.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))}
            />
            <Button variant="ghost" icon={Trash2} onClick={() => save(list.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div className="row wrap">
          <Button size="sm" icon={Plus} onClick={() => save([...list, { from: '', to: '' }])}>
            {t('settings.holidayAdd')}
          </Button>
          {Object.keys(shares).length > 0 && (
            <span className="small" style={{ color: 'var(--info)' }}>
              {Object.entries(shares)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([p, n]) => `${monthName(t, p)} — ${n === 0 ? t('settings.feeMonthFree') : t('settings.feeMonthShare', { n })}`)
                .join(' · ')}
            </span>
          )}
        </div>
      </div>
    </Field>
  );
}
