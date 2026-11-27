import { useEffect, useState } from 'react';
import { Download, RefreshCw, CheckCircle2, AlertTriangle, ShieldAlert, Minus } from 'lucide-react';
import { useT } from '../i18n';
import { Button, useConfirm } from './ui';

// Status of the automatic update (see electron/updater.js).
export function useUpdateStatus() {
  const [status, setStatus] = useState({ state: 'idle' });
  useEffect(() => {
    window.fc.update.status().then(setStatus);
    return window.fc.update.onStatus(setStatus);
  }, []);
  return status;
}

function useInstall() {
  const t = useT();
  const confirm = useConfirm();
  return async (version) => {
    if (await confirm({ title: t('update.installTitle', { v: version }), text: t('update.installText'), confirmLabel: t('update.install') }))
      window.fc.update.install();
  };
}

// Mins:secs left until the automatic restart (status.installAt), ticking every second.
function useCountdown(installAt) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!installAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [installAt]);
  const left = installAt ? Math.max(0, Math.ceil((installAt - now) / 1000)) : 0;
  return { left, text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` };
}

// A new version (updates are mandatory, see electron/updater.js) — a card over the corner of the app, so the
// work goes on: first the background download, then «restarts in 3:00» counting down, with «Update now».
// At 0 the app restarts and installs by itself.
export function UpdateBanner() {
  const t = useT();
  const s = useUpdateStatus();
  const { left, text } = useCountdown(s.state === 'ready' ? s.installAt : null);
  const [small, setSmall] = useState(false); // minimized to a pill (opens again when the download is done)
  const ready = s.state === 'ready';
  useEffect(() => {
    if (ready) setSmall(false);
  }, [ready]);
  if (!s.required && !ready) return null;
  const failed = s.state === 'error';
  if (small)
    return (
      <button className={`update-pill ${ready ? 'ready' : ''}`} onClick={() => setSmall(false)} title={t('update.requiredTitle', { v: s.version || '' })}>
        <ShieldAlert size={15} />
        {ready ? (left > 0 ? text : t('update.installing')) : failed ? t('update.retry') : `${s.percent || 0}%`}
      </button>
    );
  return (
    <div className={`update-banner ${ready ? 'ready' : ''}`} role="alert">
      <ShieldAlert size={22} className="update-icon" />
      <div className="grow stack" style={{ gap: 6 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="strong">{t('update.requiredTitle', { v: s.version || '' })}</span>
          <button className="update-min" onClick={() => setSmall(true)} title={t('update.minimize')} aria-label={t('update.minimize')}>
            <Minus size={15} />
          </button>
        </div>
        {ready ? (
          <>
            <div className="small">
              {left > 0 ? t('update.countdown', { time: text }) : t('update.installing')}
            </div>
            <div className="small muted">{t('update.countdownHelp')}</div>
            <div className="row">
              <Button variant="primary" size="sm" icon={Download} onClick={() => window.fc.update.install()}>
                {t('update.now')}
              </Button>
            </div>
          </>
        ) : failed ? (
          <>
            <div className="small" style={{ color: 'var(--bad)' }}>{t('update.error', { error: s.error || '' })}</div>
            <div className="row">
              <Button size="sm" icon={RefreshCw} onClick={() => window.fc.update.check()}>
                {t('update.retry')}
              </Button>
            </div>
          </>
        ) : (
          <div className="update-progress">
            <div className="small">{t('update.downloading', { v: s.version || '', p: s.percent || 0 })}</div>
            <div className="progress">
              <div style={{ width: `${s.percent || 0}%` }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Settings → This computer.
export function UpdateSettings() {
  const t = useT();
  const s = useUpdateStatus();
  const install = useInstall();
  const line = {
    dev: <span className="muted">{t('update.dev')}</span>,
    idle: <span className="muted">{t('update.idle')}</span>,
    checking: <span className="muted">{t('update.checking')}</span>,
    none: (
      <span className="row" style={{ color: 'var(--good)' }}>
        <CheckCircle2 size={15} /> {t('update.none')}
      </span>
    ),
    downloading: <span>{t('update.downloading', { v: s.version || '', p: s.percent || 0 })}</span>,
    ready: (
      <span className="row" style={{ color: 'var(--accent)' }}>
        <Download size={15} /> {t('update.ready', { v: s.version })}
      </span>
    ),
    error: (
      <span className="row" style={{ color: 'var(--bad)' }}>
        <AlertTriangle size={15} /> {t('update.error', { error: s.error || '' })}
      </span>
    ),
  }[s.state];
  return (
    <div className="stack">
      <div className="small">{t('settings.version', { v: s.current || '' })}</div>
      <div className="small">{line}</div>
      <div className="row">
        {s.state === 'ready' ? (
          <Button variant="primary" icon={Download} onClick={() => install(s.version)}>
            {t('update.install')}
          </Button>
        ) : (
          <Button icon={RefreshCw} disabled={['dev', 'checking', 'downloading'].includes(s.state)} onClick={() => window.fc.update.check()}>
            {t('update.check')}
          </Button>
        )}
      </div>
      <div className="small muted">{t('update.help')}</div>
    </div>
  );
}
