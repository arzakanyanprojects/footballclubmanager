import { useState } from 'react';
import { Server, MonitorSmartphone, Shield, Radar, Check } from 'lucide-react';
import { useT } from '../i18n';
import { Button, Field, useToast } from '../components/ui';

export default function Setup({ appState, onDone }) {
  const t = useT();
  const toast = useToast();
  const [mode, setMode] = useState('host');
  const [operator, setOperator] = useState(appState.config.operator || '');
  const [language, setLanguage] = useState(appState.config.language || 'en');
  const [conn, setConn] = useState({ hostAddress: appState.config.hostAddress || '', hostPort: 47800, accessKey: '' });
  const [hosts, setHosts] = useState(null);
  const [busy, setBusy] = useState(false);

  const changeLanguage = async (lang) => {
    setLanguage(lang);
    onDone(await window.fc.updateLocal({ language: lang }));
  };

  const scan = async () => {
    setHosts('scanning');
    setHosts(await window.fc.discover());
  };

  const finish = async () => {
    setBusy(true);
    const r = await window.fc.setup({ mode, operator: operator.trim(), language, ...conn });
    setBusy(false);
    if (!r.ok) return toast.error(t(`error.${r.error}`));
    onDone(r.result);
  };

  return (
    <div className="setup">
      <div className="setup-box">
        <div className="setup-title">
          <div className="brand-logo" style={{ width: 48, height: 48, borderRadius: 13 }}>
            <Shield size={26} />
          </div>
          <div className="grow">
            <h1>{t('setup.welcome')}</h1>
            <div className="muted">{t('setup.subtitle')}</div>
          </div>
          <div className="seg">
            {['en', 'hy'].map((l) => (
              <button key={l} className={language === l ? 'on' : ''} onClick={() => changeLanguage(l)}>
                {l === 'en' ? 'English' : 'Հայերեն'}
              </button>
            ))}
          </div>
        </div>

        <div className="mode-cards">
          <button className={`mode-card ${mode === 'host' ? 'on' : ''}`} onClick={() => setMode('host')}>
            <div className="ic">
              <Server size={22} />
            </div>
            <h3>{t('setup.hostTitle')}</h3>
            <p>{t('setup.hostText')}</p>
          </button>
          <button className={`mode-card ${mode === 'client' ? 'on' : ''}`} onClick={() => setMode('client')}>
            <div className="ic">
              <MonitorSmartphone size={22} />
            </div>
            <h3>{t('setup.clientTitle')}</h3>
            <p>{t('setup.clientText')}</p>
          </button>
        </div>

        <div className="card card-pad stack">
          <Field label={t('setup.yourName')} hint={t('setup.yourNameHint')}>
            <input className="input" value={operator} onChange={(e) => setOperator(e.target.value)} autoFocus />
          </Field>

          {mode === 'client' && (
            <>
              <div className="row">
                <div className="grow strong">{t('setup.findHost')}</div>
                <Button size="sm" icon={Radar} onClick={scan} disabled={hosts === 'scanning'}>
                  {hosts === 'scanning' ? t('setup.scanning') : t('setup.scan')}
                </Button>
              </div>
              {Array.isArray(hosts) && hosts.length === 0 && <div className="small muted">{t('setup.noHosts')}</div>}
              {Array.isArray(hosts) &&
                hosts.map((h) => (
                  <div
                    key={h.address + h.port}
                    className={`host-item ${conn.hostAddress === h.address ? 'on' : ''}`}
                    onClick={() => setConn({ ...conn, hostAddress: h.address, hostPort: h.port })}
                  >
                    <Server size={18} />
                    <div className="grow">
                      <div className="strong">{h.club}</div>
                      <div className="small muted">
                        {h.host} · {h.address}:{h.port}
                      </div>
                    </div>
                    {conn.hostAddress === h.address && <Check size={18} />}
                  </div>
                ))}
              <div className="grid-3">
                <Field label={t('setup.hostAddress')} className="span-2">
                  <input
                    className="input"
                    placeholder="192.168.1.10"
                    value={conn.hostAddress}
                    onChange={(e) => setConn({ ...conn, hostAddress: e.target.value.trim() })}
                  />
                </Field>
                <Field label={t('setup.port')}>
                  <input className="input" type="number" value={conn.hostPort} onChange={(e) => setConn({ ...conn, hostPort: e.target.value })} />
                </Field>
              </div>
              <Field label={t('setup.accessCode')} hint={t('setup.accessCodeHint')}>
                <input
                  className="input"
                  style={{ textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 600 }}
                  value={conn.accessKey}
                  onChange={(e) => setConn({ ...conn, accessKey: e.target.value })}
                />
              </Field>
            </>
          )}

          {mode === 'host' && <div className="small muted">{t('setup.hostNote')}</div>}

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button
              variant="primary"
              onClick={finish}
              disabled={busy || (mode === 'client' && (!conn.hostAddress || !conn.accessKey))}
            >
              {busy ? t('setup.connecting') : mode === 'host' ? t('setup.startHost') : t('setup.connect')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
