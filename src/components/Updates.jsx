import { useEffect, useState } from 'react';
import { Download, RefreshCw, CheckCircle2, AlertTriangle, ShieldAlert } from 'lucide-react';
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

// A new version was found: the update is mandatory, so this screen replaces the whole app (sign-in included)
// until it is installed — first the download's progress, then the only button, «Update now».
export function UpdateScreen({ status: s }) {
  const t = useT();
  const ready = s.state === 'ready';
  const failed = s.state === 'error';
  return (
    <div className="update-screen">
      <div className="update-box">
        <ShieldAlert size={40} className="update-icon" />
        <h2>{t('update.requiredTitle', { v: s.version || '' })}</h2>
        <p className="muted">{t('update.requiredText', { current: s.current || '' })}</p>
        {ready ? (
          <Button variant="primary" icon={Download} onClick={() => window.fc.update.install()}>
            {t('update.now')}
          </Button>
        ) : failed ? (
          <>
            <p style={{ color: 'var(--bad)' }}>{t('update.error', { error: s.error || '' })}</p>
            <Button icon={RefreshCw} onClick={() => window.fc.update.check()}>
              {t('update.retry')}
            </Button>
          </>
        ) : (
          <div className="update-progress">
            <div className="small">{t('update.downloading', { v: s.version || '', p: s.percent || 0 })}</div>
            <div className="progress">
              <div style={{ width: `${s.percent || 0}%` }} />
            </div>
          </div>
        )}
        <p className="small muted">{t('update.requiredHelp')}</p>
      </div>
    </div>
  );
}

// Sidebar: shown only when a new version is downloaded and waiting.
export function UpdateNotice() {
  const t = useT();
  const s = useUpdateStatus();
  const install = useInstall();
  if (s.state !== 'ready') return null;
  return (
    <button className="update-notice" onClick={() => install(s.version)}>
      <Download size={15} />
      <span>
        {t('update.ready', { v: s.version })}
        <span className="small">{t('update.clickToInstall')}</span>
      </span>
    </button>
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
