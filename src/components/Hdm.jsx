import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Printer, RotateCcw, CheckCircle2, AlertTriangle, PlugZap, FileText, Copy } from 'lucide-react';
import { useT } from '../i18n';
import { rpc, money } from '../lib';
import { Button, Field, Modal, useClub, useConfirm, useToast } from './ui';

// ՀԴՄ (fiscal receipt) around a payment. Settings live per computer (appState.config.hdm).
// Test mode: the payment is saved first, then a simulated receipt is shown (afterPayment).
// Device mode: the receipt goes to the real ՀԴՄ first — for a card the customer pays on the device —
// and the payment is saved only when the ՀԴՄ confirms (beforePayment).
const HdmCtx = createContext({
  enabled: false,
  device: false,
  beforePayment: async () => undefined,
  afterPayment: async () => null,
  print: async () => null,
  returnReceipt: async () => false,
});
export const useHdm = () => useContext(HdmCtx);

const LAST_CRN = 'fc.hdm.crn';
const rememberCrn = (crn) => {
  try {
    if (crn) localStorage.setItem(LAST_CRN, crn);
  } catch {
    /* per-PC convenience only */
  }
};
const lastCrn = () => {
  try {
    return localStorage.getItem(LAST_CRN) || '';
  } catch {
    return '';
  }
};

export function HdmProvider({ settings, operator, children }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [job, setJob] = useState(null);
  const device = settings?.mode === 'device';
  const needs = (method) => !!settings?.enabled && (settings.methods || []).includes(method);

  const open = useCallback((p) => new Promise((resolve) => setJob({ ...p, resolve })), []);
  const api = useMemo(
    () => ({
      enabled: !!settings?.enabled,
      test: !device,
      device: !!settings?.enabled && device,
      // Device mode, before saving a payment: the receipt result, false if it didn't go through
      // (don't save the payment), or undefined when no receipt is needed (save as usual).
      beforePayment: (p) => (device && needs(p.method) ? open({ ...p, before: true }) : Promise.resolve(undefined)),
      // Test mode, after saving a payment: shows the simulated receipt.
      afterPayment: (p) => (!device && needs(p.method) ? open(p) : Promise.resolve(null)),
      // Print on request (e.g. a receipt that failed earlier, or a test receipt).
      print: (p) => (settings?.enabled ? open(p) : Promise.resolve(null)),
      // A full return receipt on the ՀԴՄ for a paid charge; its payments become unpaid again.
      returnReceipt: async (charge) => {
        if (!(await confirm({ title: t('hdm.returnTitle'), text: t('hdm.returnConfirm', { no: charge.hdm_receipt }), confirmLabel: t('hdm.return') })))
          return false;
        const r = await window.fc.hdmAction({ kind: 'return', receiptNo: charge.hdm_receipt, crn: charge.hdm_crn || lastCrn() });
        if (!r.ok) {
          toast.error(errorText(t, r));
          return false;
        }
        await rpc('charges.receiptReturned', { receipt: charge.hdm_receipt, crn: charge.hdm_crn, returnNo: r.result.receiptNo });
        toast.success(t('hdm.returned', { no: r.result.receiptNo }));
        return true;
      },
    }),
    [settings, open, device, t, toast, confirm]
  );

  return (
    <HdmCtx.Provider value={api}>
      {children}
      {job && (
        <ReceiptModal
          job={job}
          test={!device}
          operator={operator}
          onClose={(result) => {
            job.resolve(result === undefined ? (job.before ? false : null) : result);
            setJob(null);
          }}
        />
      )}
    </HdmCtx.Provider>
  );
}

const errorText = (t, r) => {
  const msg = t(`error.${r.error}`);
  return `${msg === `error.${r.error}` ? r.error : msg}${r.detail && r.error !== 'HDM_CARD_FAILED' ? ` (${r.detail})` : ''}`;
};

/**
 * job: { items: [{ id?, label, amount }], method, student, practice?, before? }
 * practice: a test receipt from Settings, not tied to a payment.
 * before: device mode — nothing is saved yet; onClose(false) means «don't save the payment».
 */
function ReceiptModal({ job, test, operator, onClose }) {
  const t = useT();
  const [state, setState] = useState('printing'); // printing | done | error | uncertain
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [manualNo, setManualNo] = useState('');
  const total = job.items.reduce((s, i) => s + Number(i.amount || 0), 0);
  const viaPos = !test && job.before && job.method === 'card';
  const ids = job.items.map((i) => i.id).filter(Boolean);

  const send = useCallback(async () => {
    setState('printing');
    setError(null);
    const r = await window.fc.hdmPrint({
      items: job.items.map(({ label, amount, fullPrice }) => ({ label, amount: Number(amount), ...(Number(fullPrice) > Number(amount) ? { fullPrice: Number(fullPrice) } : {}) })),
      champ: !!job.champ,
      total,
      method: job.method,
      student: job.student,
      cashier: operator,
      // Printing for a payment already recorded: it was paid already, don't ask the ՀԴՄ terminal for a card.
      paidElsewhere: !job.before && !test,
    });
    if (!r.ok) {
      setError(r);
      setState(r.uncertain ? 'uncertain' : 'error');
      return;
    }
    rememberCrn(r.result.crn);
    // After a payment (test mode, or printing later): the receipt goes onto the saved payments.
    if (ids.length) await rpc('charges.setReceipt', { ids, receipt: r.result.receiptNo, crn: r.result.crn, fiscal: r.result.fiscalNo }).catch(() => {});
    setResult(r.result);
    setState('done');
  }, [job, total, operator, ids.join(',')]);

  // «The receipt was printed»: the number read from the paper.
  const confirmManual = async () => {
    const res = { test: false, receiptNo: manualNo.trim(), fiscalNo: '', crn: lastCrn(), printedAt: new Date().toISOString(), manual: true };
    if (ids.length) await rpc('charges.setReceipt', { ids, receipt: res.receiptNo, crn: res.crn }).catch(() => {});
    onClose(res);
  };

  useEffect(() => {
    send();
  }, []);

  const cancel = () => onClose(job.before ? false : null);
  return (
    <Modal
      title={t('hdm.title')}
      onClose={() => state !== 'printing' && (state === 'done' ? onClose(result) : cancel())}
      width={480}
      footer={
        state === 'printing' ? (
          <span className="row muted small">
            <span className="spinner" style={{ width: 16, height: 16 }} /> {t(viaPos ? 'hdm.waitingCard' : 'hdm.sending')}
          </span>
        ) : state === 'error' ? (
          <>
            <Button onClick={cancel}>{t(job.before ? 'hdm.cancelPayment' : 'hdm.skip')}</Button>
            <Button variant="primary" icon={RotateCcw} onClick={send}>
              {t('hdm.retry')}
            </Button>
          </>
        ) : state === 'uncertain' ? (
          <>
            <Button onClick={cancel}>{t('hdm.notPrinted')}</Button>
            <Button
              variant="primary"
              icon={CheckCircle2}
              disabled={!manualNo.trim()}
              onClick={confirmManual}
            >
              {t('hdm.wasPrinted')}
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
        {state === 'printing' && viaPos && <div className="hdm-test-note">{t('hdm.payOnDevice', { amount: money(total, 'AMD') })}</div>}
        {state === 'error' && (
          <div className="row small" style={{ color: 'var(--bad)', alignSelf: 'stretch' }}>
            <AlertTriangle size={16} />
            {errorText(t, error)}
          </div>
        )}
        {state === 'error' && job.before && <div className="small muted" style={{ alignSelf: 'stretch' }}>{t('hdm.notSaved')}</div>}
        {state === 'uncertain' && (
          <div className="stack" style={{ alignSelf: 'stretch', gap: 10 }}>
            <div className="row small" style={{ color: 'var(--warn)' }}>
              <AlertTriangle size={16} />
              {t('hdm.uncertain')}
            </div>
            <Button size="sm" icon={Copy} onClick={() => window.fc.hdmAction({ kind: 'lastCopy' })}>
              {t('hdm.lastCopy')}
            </Button>
            <Field label={t('hdm.receiptNoFromPaper')}>
              <input className="input" value={manualNo} onChange={(e) => setManualNo(e.target.value)} placeholder="123" />
            </Field>
          </div>
        )}
        <ReceiptSlip job={job} total={total} result={result} test={test} operator={operator} faded={state !== 'done'} />
        {state === 'error' && !job.before && <div className="small muted">{t('hdm.laterHint')}</div>}
      </div>
    </Modal>
  );
}

function ReceiptSlip({ job, total, result, test, operator, faded }) {
  const t = useT();
  const club = useClub();
  const when = result ? new Date(result.printedAt) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${pad(when.getDate())}/${pad(when.getMonth() + 1)}/${when.getFullYear()} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
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
      {job.items.map((i, k) => {
        const full = Number(i.fullPrice) || 0;
        const pct = full > Number(i.amount) ? Math.round(((full - Number(i.amount)) / full) * 10000) / 100 : 0;
        if (!(pct > 0 && pct < 100))
          return (
            <div className="line" key={k}>
              <span>{i.label}</span>
              <span>{money(i.amount, club.currency)}</span>
            </div>
          );
        // As the ՀԴՄ prints it: the full price, «Զեղչ», then what is paid.
        return (
          <Fragment key={k}>
            <div className="line">
              <span>{i.label}</span>
              <span>{money(full, club.currency)}</span>
            </div>
            <div className="line muted">
              <span>
                {t('hdm.discount')} {pct}%
              </span>
              <span>−{money(full - Number(i.amount), club.currency)}</span>
            </div>
            <div className="line">
              <span />
              <span>{money(i.amount, club.currency)}</span>
            </div>
          </Fragment>
        );
      })}
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
        <span>{result ? result.fiscalNo || '—' : '……'}</span>
      </div>
      {test && <div className="center small" style={{ marginTop: 8 }}>{t('hdm.testFooter')}</div>}
    </div>
  );
}

// Settings → This computer: the ՀԴՄ section.
export function HdmSettings({ settings, onChange }) {
  const t = useT();
  const hdm = useHdm();
  const toast = useToast();
  const confirm = useConfirm();
  const [s, setS] = useState(settings || {});
  const [check, setCheck] = useState(null); // { busy } | { result } | { error }
  const [busy, setBusy] = useState(null);
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
  const device = s.mode === 'device';
  const runCheck = async () => {
    setCheck({ busy: true });
    const r = await window.fc.hdmTest();
    setCheck(r.ok ? { result: r.result } : { error: errorText(t, r) });
  };
  const run = async (kind, ask) => {
    if (ask && !(await confirm(ask))) return;
    setBusy(kind);
    const r = await window.fc.hdmAction({ kind });
    setBusy(null);
    r.ok ? toast.success(t('hdm.sent')) : toast.error(errorText(t, r));
  };
  const input = (k, { raw, ...props } = {}) => (
    <input className="input" value={s[k] || ''} onChange={(e) => set({ [k]: raw ? e.target.value : e.target.value.trim() })} {...props} />
  );
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
            <div className="hint">{t(device ? 'hdm.deviceHint' : 'hdm.testHint')}</div>
          </div>
          {device && (
            <>
              <div className="grid-2">
                <Field label={t('hdm.host')}>{input('host', { placeholder: '10.10.10.45' })}</Field>
                <Field label={t('setup.port')}>{input('port', { placeholder: '1025' })}</Field>
                <Field label={t('hdm.hdmPassword')} className="span-2">
                  {input('hdmPassword', { type: 'password', raw: true, autoComplete: 'off' })}
                </Field>
                <Field label={t('hdm.dep')}>{input('dep', { inputMode: 'numeric' })}</Field>
                <div />
                <Field label={t('hdm.cashierNo')}>{input('cashier', { inputMode: 'numeric' })}</Field>
                <Field label={t('hdm.password')}>{input('password', { type: 'password', raw: true, autoComplete: 'off' })}</Field>
              </div>
              <div className="grid-2">
                <Field label={t('hdm.productName')} className="span-2">
                  <input className="input" value={s.productName ?? 'Ուսումնամարզական ծառայություն'} maxLength={50} onChange={(e) => set({ productName: e.target.value })} />
                </Field>
                <Field label={t('hdm.adgCode')}>{input('adgCode', { placeholder: '85.51', value: s.adgCode ?? '85.51' })}</Field>
                <Field label={t('hdm.productCode')}>{input('productCode', { placeholder: '1.7.6', value: s.productCode ?? '1.7.6' })}</Field>
                <Field label={t('hdm.unit')}>{input('unit', { placeholder: 'ամիս', value: s.unit ?? 'ամիս' })}</Field>
              </div>
              <label className="check">
                <input type="checkbox" checked={s.devicePos !== false} onChange={(e) => set({ devicePos: e.target.checked })} />
                {t('hdm.devicePos')}
              </label>
              <div className="row wrap">
                <Button icon={PlugZap} onClick={runCheck} disabled={check?.busy}>
                  {t('hdm.check')}
                </Button>
                <Button icon={Printer} onClick={() => run('sample')} disabled={!!busy}>
                  {t('hdm.sample')}
                </Button>
                <Button icon={Copy} onClick={() => run('lastCopy')} disabled={!!busy}>
                  {t('hdm.lastCopy')}
                </Button>
                <Button icon={FileText} onClick={() => run('x')} disabled={!!busy}>
                  {t('hdm.reportX')}
                </Button>
                <Button
                  icon={FileText}
                  variant="danger"
                  onClick={() => run('z', { title: t('hdm.reportZ'), text: t('hdm.reportZConfirm'), confirmLabel: t('hdm.reportZ') })}
                  disabled={!!busy}
                >
                  {t('hdm.reportZ')}
                </Button>
              </div>
              {check?.busy && (
                <span className="row muted small">
                  <span className="spinner" style={{ width: 16, height: 16 }} /> {t('hdm.checking')}
                </span>
              )}
              {check?.error && (
                <div className="row small" style={{ color: 'var(--bad)' }}>
                  <AlertTriangle size={16} /> {check.error}
                </div>
              )}
              {check?.result && <CheckResult r={check.result} s={s} />}
            </>
          )}
          <div className="field">
            <label>{t('hdm.methods')}</label>
            <div className="row wrap" style={{ gap: 16 }}>
              {['card', 'easypay', 'transfer'].map((m) => (
                <label key={m} className="check">
                  <input type="checkbox" checked={(s.methods || []).includes(m)} onChange={() => toggleMethod(m)} />
                  {t(`method.${m}`)}
                </label>
              ))}
            </div>
            {device && <div className="hint">{t('hdm.methodsDeviceHint')}</div>}
          </div>
          <div className="grid-2">
            <Field label={t('hdm.champProductName')} hint={t('hdm.champHint')}>
              <input className="input" value={s.champProductName ?? ''} placeholder="Ուսումնամարզական ծառայություն առաջնության թիմ" onChange={(e) => set({ champProductName: e.target.value })} />
            </Field>
            <Field label={t('hdm.champProductCode')}>
              <input className="input" value={s.champProductCode ?? ''} placeholder="1.7.7" onChange={(e) => set({ champProductCode: e.target.value })} />
            </Field>
          </div>
          <Field label={t('hdm.discountFormat')} hint={t('hdm.discountFormatHint')}>
            <select className="select" style={{ maxWidth: 320 }} value={s.discountFormat || 'percent'} onChange={(e) => set({ discountFormat: e.target.value })}>
              <option value="percent">{t('hdm.discountPercent')}</option>
              <option value="amount">{t('hdm.discountAmount')}</option>
            </select>
          </Field>
          {!device && (
            <div className="row">
              <Button
                icon={Printer}
                onClick={() => hdm.print({ items: [{ label: t('hdm.testItem'), amount: 100 }], method: (s.methods || ['card'])[0] || 'card', practice: true })}
              >
                {t('hdm.testPrint')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// What «Ստուգել կապը» found: the device's operators and departments, and whether the operator signed in.
function CheckResult({ r, s }) {
  const t = useT();
  const good = { color: 'var(--good)' };
  const bad = { color: 'var(--bad)' };
  const op = r.operators.find((o) => String(o.id) === String(s.cashier));
  const depOk = r.deps.some((d) => String(d.id) === String(s.dep)) && (!op || !op.deps.length || op.deps.map(String).includes(String(s.dep)));
  return (
    <div className="cloud-box small">
      <div className="row" style={good}>
        <CheckCircle2 size={15} /> {t('hdm.connected')}
      </div>
      <div>
        <span className="strong">{t('hdm.operators')}:</span> {r.operators.map((o) => `${o.id} — ${o.name}`).join(', ') || '—'}
      </div>
      <div>
        <span className="strong">{t('hdm.deps')}:</span> {r.deps.map((d) => `${d.id} — ${d.name}`).join(', ') || '—'}
      </div>
      <div className="row" style={depOk ? good : bad}>
        {depOk ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />} {t(depOk ? 'hdm.depOk' : 'hdm.depMissing', { dep: s.dep || '—' })}
      </div>
      {r.login && (
        <div className="row" style={r.login === 'ok' ? good : bad}>
          {r.login === 'ok' ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          {r.login === 'ok' ? t('hdm.loginOk') : t(`error.${r.login}`)}
        </div>
      )}
    </div>
  );
}

