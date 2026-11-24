// The customer's receipt on the thermal (roll) printer — e.g. «Termo», 80 mm, set per computer
// in Settings → This computer. Printed straight to that printer, no print dialog.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Printer, RefreshCw } from 'lucide-react';
import { useT, monthName } from '../i18n';
import { rpc, money, fmtDate, todayIso, currentPeriod } from '../lib';
import { Button, Field, useClub, useToast } from './ui';

// This computer's receipt printer settings, for printing after a payment and the «Թերմո կտրոն» button.
const ThermalCtx = createContext(null);
export const ThermalProvider = ({ settings, operator, children }) => (
  <ThermalCtx.Provider value={settings?.enabled && settings.printer ? { ...settings, operator } : null}>{children}</ThermalCtx.Provider>
);
export const useThermal = () => useContext(ThermalCtx);

// The receipt's header, as the club prints it; editable in Settings → This computer.
export const HEADER = { name: 'Փյունիկ ՖԱ', address: 'Ծիծեռնակաբերդի խճ. 4/3', tin: '02562579' };
const headerOf = (s = {}) => ({
  name: s.headerName ?? HEADER.name,
  address: s.headerAddress ?? HEADER.address,
  tin: s.headerTin ?? HEADER.tin,
});

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Everything the receipt shows: the payment and the student's details.
 * pay: { studentId, items: [{ id?, label, amount }], method, paidAt, hdm: { receiptNo, fiscalNo }, cashier }
 */
export async function receiptData(t, club, pay) {
  const d = pay.studentId ? await rpc('students.get', { id: pay.studentId }) : null;
  const s = d?.student || {};
  const ids = pay.items.map((i) => i.id).filter(Boolean);
  return {
    no: ids.length ? String(Math.min(...ids)).padStart(6, '0') : '',
    student: [s.first_name, s.last_name, s.patronymic].filter(Boolean).join(' ') || pay.student || '',
    birth: s.birth_date,
    group: s.group_name,
    coach: s.group_coach,
    contract: s.contract_no,
    category: s.category ? t(`category.${s.category}`) : '',
    items: pay.items,
    method: pay.method,
    paidAt: pay.paidAt,
    hdm: pay.hdm,
    cashier: pay.cashier,
  };
}

// The receipt page (80 mm roll by default; the printable width is 72 mm).
export function thermalHtml(t, club, r, widthMm = 80, opts = {}) {
  const total = r.items.reduce((s, i) => s + Number(i.amount || 0), 0);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${fmtDate(r.paidAt || todayIso())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const m = (v) => money(v, club.currency);
  const line = (a, b, cls = '') => `<div class="l ${cls}"><span>${esc(a)}</span><span>${esc(b)}</span></div>`;
  const kv = (a, b) => (b ? `<div class="kv"><span class="k">${esc(a)}՝</span> ${esc(b)}</div>` : '');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #000; }
    body { width: ${widthMm - 8}mm; padding: 2mm 1mm 6mm; font: 12px/1.35 Arial, sans-serif; }
    .c { text-align: center; }
    .b { font-weight: bold; }
    .big { font-size: 15px; }
    .small { font-size: 10.5px; }
    .sep { border-top: 1px dashed #000; margin: 6px 0; }
    .l { display: flex; justify-content: space-between; gap: 8px; }
    .l span:last-child { text-align: right; white-space: nowrap; }
    .kv .k { color: #000; font-weight: bold; }
    .tot { font-size: 15px; font-weight: bold; margin: 2px 0; }
    img { display: block; margin: 0 auto 4px; max-width: 26mm; max-height: 20mm; filter: grayscale(1) contrast(1.3); }
  </style></head><body>
    ${opts.logo && club.club_logo ? `<img src="${club.club_logo}">` : ''}
    <div class="c b big">${esc(opts.header?.name || club.club_name || 'FC Manager')}</div>
    ${opts.header?.address ? `<div class="c">${esc(opts.header.address)}</div>` : ''}
    ${opts.header?.tin ? `<div class="c">${esc(t('thermal.tin'))} ${esc(opts.header.tin)}</div>` : ''}
    <div class="sep"></div>
    <div class="c b">${esc(t('thermal.title'))}${r.no ? ` № ${esc(r.no)}` : ''}</div>
    <div class="c small">${esc(stamp)}</div>
    <div class="sep"></div>
    ${kv(t('payments.student'), r.student)}
    ${kv(t('students.birthDate'), r.birth ? fmtDate(r.birth) : '')}
    ${kv(t('students.group'), [r.group, r.coach].filter(Boolean).join(' · '))}
    ${kv(t('students.contractNo'), r.contract)}
    ${kv(t('students.category'), r.category)}
    <div class="sep"></div>
    <div class="b">${esc(t('thermal.paidFor'))}</div>
    ${r.items.map((i) => line(i.label, m(i.amount))).join('')}
    <div class="sep"></div>
    ${line(t('hdm.total'), m(total), 'tot')}
    ${r.method ? line(t('payments.method'), t(`method.${r.method}`)) : ''}
    ${r.hdm?.receiptNo ? line(t('thermal.hdmReceipt'), /^\d+$/.test(r.hdm.receiptNo) ? r.hdm.receiptNo.padStart(8, '0') : r.hdm.receiptNo) : ''}
    ${r.hdm?.fiscalNo ? line(t('thermal.fiscalNo'), r.hdm.fiscalNo) : ''}
    <div class="sep"></div>
    <div class="c">${esc(t('thermal.thanks'))}</div>
  </body></html>`;
}

export async function printThermal(t, club, data, widthMm, opts) {
  const r = await window.fc.thermalPrint({ html: thermalHtml(t, club, data, widthMm, opts) });
  if (!r?.ok) throw Object.assign(new Error(r?.error || 'PRINT_FAILED'), { code: r?.error || 'PRINT_FAILED', detail: r?.detail });
  return true;
}

// The message for a failed print, with the printer's address when the network print failed.
const errorText = (t, err) => {
  const key = `error.${err.code}`;
  return `${t(key) === key ? err.message : t(key)}${err.detail ? ` (${err.detail})` : ''}`;
};

// Builds and prints the customer receipt for a payment; returns false (with a message) if it failed.
export function useCustomerReceipt() {
  const t = useT();
  const club = useClub();
  const toast = useToast();
  const thermal = useThermal();
  const print = useCallback(
    async (pay) => {
      if (!thermal) return false;
      try {
        await printThermal(t, club, await receiptData(t, club, { cashier: thermal.operator, ...pay }), thermal.width, { logo: thermal.logo, header: headerOf(thermal) });
        return true;
      } catch (err) {
        toast.error(`${t('thermal.failed')} ${errorText(t, err)}`);
        return false;
      }
    },
    [thermal, t, club, toast]
  );
  return {
    available: !!thermal,
    print,
    // After a payment: prints only when «print after every payment» is on.
    afterPayment: (pay) => (thermal?.auto ? print(pay) : Promise.resolve(false)),
  };
}

// Settings → This computer: the receipt printer.
export function ThermalSettings({ settings, onChange }) {
  const t = useT();
  const toast = useToast();
  const club = useClub();
  const [s, setS] = useState(settings || {});
  const [printers, setPrinters] = useState(null);
  const load = () => window.fc.printers().then(setPrinters).catch(() => setPrinters([]));
  useEffect(() => {
    load();
  }, []);
  // The chosen printer's network address (Standard TCP/IP port), for printing straight to it.
  const [found, setFound] = useState(undefined);
  useEffect(() => {
    setFound(undefined);
    if (!s.printer || !window.fc.printerAddress) return;
    let live = true;
    window.fc
      .printerAddress(s.printer)
      .then((a) => live && setFound(a || null))
      .catch(() => live && setFound(null));
    return () => {
      live = false;
    };
  }, [s.printer]);
  const mode = s.mode || (s.host || found ? 'net' : 'image');
  const set = (patch) => {
    const next = { ...s, ...patch };
    setS(next);
    onChange(next);
  };
  const test = async () => {
    try {
      await printThermal(t, club, sample(t, club), s.width, { logo: s.logo, header: headerOf(s) });
      toast.success(t('thermal.sent', { printer: s.printer }));
    } catch (err) {
      toast.error(errorText(t, err));
    }
  };
  return (
    <div className="stack">
      <label className="check">
        <input type="checkbox" checked={!!s.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span className="strong">{t('thermal.enable')}</span>
      </label>
      <div className="small muted">{t('thermal.hint')}</div>
      {s.enabled && (
        <>
          <div className="grid-2">
            <Field label={t('thermal.printer')}>
              <div className="row nowrap">
                <select className="select grow" value={s.printer || ''} onChange={(e) => set({ printer: e.target.value })}>
                  <option value="">{printers ? t('thermal.choose') : '…'}</option>
                  {(printers || []).map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.displayName}
                      {p.isDefault ? ` (${t('thermal.default')})` : ''}
                    </option>
                  ))}
                </select>
                <Button icon={RefreshCw} title={t('thermal.refresh')} onClick={load} />
              </div>
            </Field>
            <Field label={t('thermal.width')}>
              <select className="select" value={s.width || 80} onChange={(e) => set({ width: Number(e.target.value) })}>
                <option value={80}>80 mm</option>
                <option value={58}>58 mm</option>
              </select>
            </Field>
            <Field label={t('thermal.mode')} className="span-2">
              <select className="select" value={mode} onChange={(e) => set({ mode: e.target.value })}>
                {['net', 'image', 'imageA', 'text'].map((m) => (
                  <option key={m} value={m}>
                    {t(`thermal.mode_${m}`)}
                  </option>
                ))}
              </select>
              <div className="small muted" style={{ marginTop: 4 }}>{t('thermal.modeHint')}</div>
            </Field>
            {mode === 'net' && (
              <>
                <Field label={t('thermal.host')}>
                  <input
                    className="input"
                    value={s.host || ''}
                    placeholder={found ? found.host : found === undefined ? '…' : '192.168.1.100'}
                    onChange={(e) => set({ host: e.target.value.trim() })}
                  />
                </Field>
                <Field label={t('thermal.port')}>
                  <input className="input" value={s.port || ''} placeholder={String(found?.port || 9100)} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} />
                </Field>
                <div className="span-2 small muted">
                  {s.host ? t('thermal.hostManual') : found ? t('thermal.hostFound', { host: `${found.host}:${found.port}` }) : found === null ? t('thermal.hostMissing') : ''}
                </div>
              </>
            )}
          </div>
          <div className="grid-2">
            <Field label={t('thermal.headerName')}>
              <input className="input" value={headerOf(s).name} onChange={(e) => set({ headerName: e.target.value })} />
            </Field>
            <Field label={t('thermal.tin')}>
              <input className="input" value={headerOf(s).tin} onChange={(e) => set({ headerTin: e.target.value.trim() })} />
            </Field>
            <Field label={t('thermal.headerAddress')} className="span-2">
              <input className="input" value={headerOf(s).address} onChange={(e) => set({ headerAddress: e.target.value })} />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={!!s.auto} onChange={(e) => set({ auto: e.target.checked })} />
            {t('thermal.auto')}
          </label>
          <label className="check">
            <input type="checkbox" checked={!!s.logo} onChange={(e) => set({ logo: e.target.checked })} />
            {t('thermal.logo')}
          </label>
          <div className="row">
            <Button icon={Printer} onClick={test} disabled={!s.printer}>
              {t('thermal.test')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// A made-up receipt for the test print.
function sample(t, club) {
  const p = currentPeriod();
  return {
    no: '000123',
    student: t('thermal.sampleStudent'),
    birth: '2012-01-20',
    group: '2012-1',
    coach: t('thermal.sampleCoach'),
    contract: '26-08-80',
    category: '',
    items: [{ label: `${t('charge.monthly')} · ${monthName(t, p)}`, amount: 30000 }],
    method: 'card',
    paidAt: todayIso(),
    hdm: { receiptNo: '123', fiscalNo: '40382455' },
    cashier: t('thermal.sampleCashier'),
  };
}
