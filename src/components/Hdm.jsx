import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Printer, RotateCcw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useT } from '../i18n';
import { rpc, money } from '../lib';
import { Button, Modal, useClub } from './ui';

// ՀԴՄ (fiscal receipt) step after a payment. Settings live per computer (appState.config.hdm).
const HdmCtx = createContext({ enabled: false, afterPayment: async () => null, print: async () => null });
export const useHdm = () => useContext(HdmCtx);

export function HdmProvider({ settings, operator, children }) {
  const [job, setJob] = useState(null);

  const open = useCallback((p) => new Promise((resolve) => setJob({ ...p, resolve })), []);
  const api = useMemo(
    () => ({
      enabled: !!settings?.enabled,
      test: settings?.mode !== 'device',
      // After a payment: asks for a receipt only when this payment method needs one.
      afterPayment: (p) =>
        settings?.enabled && (settings.methods || []).includes(p.method) ? open(p) : Promise.resolve(null),
      // Print on request (e.g. a receipt that failed earlier, or a test receipt).
      print: (p) => (settings?.enabled ? open(p) : Promise.resolve(null)),
    }),
    [settings, open]
  );

  return (
    <HdmCtx.Provider value={api}>
      {children}
      {job && (
        <ReceiptModal
          job={job}
          test={settings?.mode !== 'device'}
          operator={operator}
          onClose={(result) => {
            job.resolve(result || null);
            setJob(null);
          }}
        />
      )}
    </HdmCtx.Provider>
  );
}

/**
 * job: { items: [{ id?, label, amount }], method, student, practice? }
 * practice: a test receipt from Settings, not tied to a payment.
 */
function ReceiptModal({ job, test, operator, onClose }) {
  const t = useT();
  const [state, setState] = useState('printing'); // printing | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const total = job.items.reduce((s, i) => s + Number(i.amount || 0), 0);

  const send = useCallback(async () => {
    setState('printing');
    setError(null);
    const r = await window.fc.hdmPrint({
      items: job.items.map(({ label, amount }) => ({ label, amount: Number(amount) })),
      total,
      method: job.method,
      student: job.student,
      cashier: operator,
    });
    if (!r.ok) {
      setError(r.error);
      setState('error');
      return;
    }
    const ids = job.items.map((i) => i.id).filter(Boolean);
    if (ids.length) await rpc('charges.setReceipt', { ids, receipt: r.result.receiptNo }).catch(() => {});
    setResult(r.result);
    setState('done');
  }, [job, total, operator]);

  useEffect(() => {
    send();
  }, []);

  return (
    <Modal
      title={t('hdm.title')}
      onClose={() => state !== 'printing' && onClose(result)}
      width={480}
      footer={
        state === 'printing' ? (
          <span className="row muted small">
            <span className="spinner" style={{ width: 16, height: 16 }} /> {t('hdm.sending')}
          </span>
        ) : state === 'error' ? (
          <>
            <Button onClick={() => onClose(null)}>{t('hdm.skip')}</Button>
            <Button variant="primary" icon={RotateCcw} onClick={send}>
              {t('hdm.retry')}
            </Button>
          </>
        ) : (
          <Button variant="primary" icon={CheckCircle2} onClick={() => onClose(result)}>
            {t('hdm.done')}
          </Button>
        )
      }
    >
      <div className="stack" style={{ alignItems: 'center' }}>
        {test && <div className="hdm-test-note">{t('hdm.testNote')}</div>}
        {state === 'error' && (
          <div className="row small" style={{ color: 'var(--bad)', alignSelf: 'stretch' }}>
            <AlertTriangle size={16} />
            {t(`error.${error}`) === `error.${error}` ? error : t(`error.${error}`)}
          </div>
        )}
        <ReceiptSlip job={job} total={total} result={result} test={test} operator={operator} faded={state !== 'done'} />
        {state === 'error' && <div className="small muted">{t('hdm.laterHint')}</div>}
      </div>
    </Modal>
  );
}

function ReceiptSlip({ job, total, result, test, operator, faded }) {
  const t = useT();
  const club = useClub();
  const when = result ? new Date(result.printedAt) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${pad(when.getDate())}.${pad(when.getMonth() + 1)}.${when.getFullYear()} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
  return (
    <div className={`receipt ${faded ? 'faded' : ''}`}>
      <div className="center strong">{club.club_name || 'FC Manager'}</div>
      {club.club_address && <div className="center">{club.club_address}</div>}
      <div className="center strong" style={{ marginTop: 6 }}>
        {t('hdm.receipt')}
        {test ? ` · ${t('hdm.testShort')}` : ''}
      </div>
      <div className="sep" />
      <div className="line">
        <span>{t('hdm.date')}</span>
        <span>{stamp}</span>
      </div>
      {operator && (
        <div className="line">
          <span>{t('hdm.cashier')}</span>
          <span>{operator}</span>
        </div>
      )}
      {job.student && (
        <div className="line">
          <span>{t('payments.student')}</span>
          <span>{job.student}</span>
        </div>
      )}
      <div className="sep" />
      {job.items.map((i, k) => (
        <div className="line" key={k}>
          <span>{i.label}</span>
          <span>{money(i.amount, club.currency)}</span>
        </div>
      ))}
      <div className="sep" />
      <div className="line total">
        <span>{t('hdm.total')}</span>
        <span>{money(total, club.currency)}</span>
      </div>
      <div className="line">
        <span>{t('payments.method')}</span>
        <span>{t(`method.${job.method}`)}</span>
      </div>
      <div className="sep" />
      <div className="line">
        <span>{t('hdm.receiptNo')}</span>
        <span>{result ? result.receiptNo : '……'}</span>
      </div>
      <div className="line">
        <span>{t('hdm.fiscalNo')}</span>
        <span>{result ? result.fiscalNo : '……'}</span>
      </div>
      {test && <div className="center small" style={{ marginTop: 8 }}>{t('hdm.testFooter')}</div>}
    </div>
  );
}

// Settings → This computer: the ՀԴՄ section.
export function HdmSettings({ settings, onChange }) {
  const t = useT();
  const hdm = useHdm();
  const [s, setS] = useState(settings || {});
  const set = (patch) => {
    const next = { ...s, ...patch };
    setS(next);
    const { testCounter, ...save } = next; // the counter is kept by the main process
    onChange(save);
  };
  const toggleMethod = (m) => {
    const methods = new Set(s.methods || []);
    methods.has(m) ? methods.delete(m) : methods.add(m);
    set({ methods: [...methods] });
  };
  return (
    <div className="stack">
      <label className="check">
        <input type="checkbox" checked={!!s.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span className="strong">{t('hdm.enable')}</span>
      </label>
      <div className="small muted">{t('hdm.enableHint')}</div>
      {s.enabled && (
        <>
          <div className="field">
            <label>{t('hdm.mode')}</label>
            <div className="seg" style={{ alignSelf: 'flex-start' }}>
              {['test', 'device'].map((m) => (
                <button key={m} className={(s.mode || 'test') === m ? 'on' : ''} onClick={() => set({ mode: m })}>
                  {t(`hdm.mode_${m}`)}
                </button>
              ))}
            </div>
            <div className="hint">{t(s.mode === 'device' ? 'hdm.deviceHint' : 'hdm.testHint')}</div>
          </div>
          {s.mode === 'device' && (
            <div className="grid-2">
              <div className="field">
                <label>{t('hdm.host')}</label>
                <input className="input" value={s.host || ''} placeholder="192.168.1.50" onChange={(e) => set({ host: e.target.value.trim() })} />
              </div>
              <div className="field">
                <label>{t('setup.port')}</label>
                <input className="input" value={s.port || ''} onChange={(e) => set({ port: e.target.value.trim() })} />
              </div>
              <div className="field">
                <label>{t('hdm.cashierNo')}</label>
                <input className="input" value={s.cashier || ''} onChange={(e) => set({ cashier: e.target.value.trim() })} />
              </div>
              <div className="field">
                <label>{t('hdm.password')}</label>
                <input className="input" type="password" value={s.password || ''} onChange={(e) => set({ password: e.target.value })} />
              </div>
            </div>
          )}
          <div className="field">
            <label>{t('hdm.methods')}</label>
            <div className="row wrap" style={{ gap: 16 }}>
              {['easypay', 'card', 'transfer'].map((m) => (
                <label key={m} className="check">
                  <input type="checkbox" checked={(s.methods || []).includes(m)} onChange={() => toggleMethod(m)} />
                  {t(`method.${m}`)}
                </label>
              ))}
            </div>
          </div>
          <div className="row">
            <Button
              icon={Printer}
              onClick={() => hdm.print({ items: [{ label: t('hdm.testItem'), amount: 100 }], method: (s.methods || ['card'])[0] || 'card', practice: true })}
            >
              {t('hdm.testPrint')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
