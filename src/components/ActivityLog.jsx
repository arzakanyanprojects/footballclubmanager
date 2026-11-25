import { useEffect, useState } from 'react';
import { FileSpreadsheet, FilterX, History } from 'lucide-react';
import { useT, useLang } from '../i18n';
import { dictionaries } from '../locales';
import { rpc, fmtDateTime, todayIso, money } from '../lib';
import { Button, Empty, Loading, SearchBox, useAction, useClub } from './ui';
import { HistoryRow, historyText } from './StudentExtras';

const PAGE = 100;
export const LOG_SECTIONS = ['students', 'payments', 'attendance', 'groups', 'contracts', 'notes', 'users', 'system'];
const EMPTY = { q: '', section: '', user: '', from: '', to: '' };
// Kept while moving around the app (e.g. into a student and back).
let kept = EMPTY;

// Settings → «Գործողությունների մատյան»: everything done in the app, kept for good. Search (names, details,
// what changed, action names), filter by section, user and dates, page through it, export what is found.
export default function ActivityLog({ nav }) {
  const t = useT();
  const lang = useLang();
  const act = useAction();
  const club = useClub();
  const [f, setF] = useState(kept);
  const [q, setQ] = useState(kept.q); // typed; applied a moment later
  const [data, setData] = useState(null); // { rows, total, users }
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((x) => (kept = { ...x, [k]: v }));

  useEffect(() => {
    const id = setTimeout(() => set('q')(q), 300);
    return () => clearTimeout(id);
  }, [q]);

  // Action names in the current language that contain the searched words (so «վճար» finds the payments).
  const actionsFor = (text) => {
    const s = text.trim().toLowerCase();
    if (!s) return [];
    const dict = dictionaries[lang] || dictionaries.en;
    return Object.entries(dict)
      .filter(([k, v]) => /^(activity|history)\./.test(k) && String(v).toLowerCase().includes(s))
      .map(([k]) => k.replace(/^(activity|history)\./, ''));
  };
  const params = (offset, limit = PAGE) => ({ ...f, actions: actionsFor(f.q), offset, limit });

  const load = async (offset = 0) => {
    setBusy(true);
    try {
      const r = await rpc('activity.list', params(offset));
      setData((d) => (offset && d ? { ...r, rows: [...d.rows, ...r.rows], users: d.users } : r));
    } finally {
      setBusy(false);
    }
  };
  const key = JSON.stringify(f);
  useEffect(() => {
    load(0).catch(() => setData({ rows: [], total: 0, users: [] }));
  }, [key]);

  const filtered = !!(f.q || f.section || f.user || f.from || f.to);
  const clear = () => {
    setQ('');
    setF((kept = EMPTY));
  };

  const exportFile = () =>
    act(async () => {
      const all = await rpc('activity.list', params(0, 20000));
      const r = await window.fc.saveXlsx({
        kind: 'table',
        defaultName: `${t('activity.log')} ${todayIso()}.xlsx`.replace(/[\\/:*?"<>|]/g, '_'),
        sheetName: t('activity.log'),
        title: `${club.club_name || 'FC Manager'} — ${t('activity.log')}`,
        subtitle: [f.from || f.to ? `${f.from || '…'} – ${f.to || '…'}` : '', f.user, f.section ? t(`logSection.${f.section}`) : '', f.q ? `«${f.q}»` : '', t('reportsx.rows', { n: all.rows.length })]
          .filter(Boolean)
          .join(' · '),
        columns: [
          { key: 'at', header: t('activity.when'), width: 18 },
          { key: 'user', header: t('activity.who'), width: 18 },
          { key: 'what', header: t('activity.what'), width: 28 },
          { key: 'student', header: t('payments.student'), width: 26 },
          { key: 'details', header: t('logSection.details'), width: 70, wrap: true },
        ],
        rows: all.rows.map((e) => {
          const h = historyText(t, e, (v) => money(v, club.currency));
          return {
            at: fmtDateTime(e.at),
            user: e.user || '',
            what: h.label,
            student: e.student_name || '',
            details: [h.detail, ...h.changes].filter(Boolean).join('\n'),
          };
        }),
        currencySymbol: money(0, club.currency).replace(/[\d,.\s]/g, '') || club.currency,
      });
      if (!r.ok) throw Object.assign(new Error(r.detail || r.error), { code: r.error, detail: r.detail });
      return r;
    }, t('reports.saved'));

  const users = data?.users || [];
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <SearchBox value={q} onChange={setQ} placeholder={t('logSection.search')} width={300} />
        <select className="select" value={f.section} onChange={(e) => set('section')(e.target.value)}>
          <option value="">{t('logSection.all')}</option>
          {LOG_SECTIONS.map((s) => (
            <option key={s} value={s}>
              {t(`logSection.${s}`)}
            </option>
          ))}
        </select>
        <select className="select" value={f.user} onChange={(e) => set('user')(e.target.value)}>
          <option value="">{t('logSection.allUsers')}</option>
          {users.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <span className="small muted">{t('logSection.from')}</span>
        <input className="input" type="date" style={{ width: 150 }} value={f.from} max={f.to || undefined} onChange={(e) => set('from')(e.target.value)} />
        <span className="small muted">{t('logSection.to')}</span>
        <input className="input" type="date" style={{ width: 150 }} value={f.to} min={f.from || undefined} onChange={(e) => set('to')(e.target.value)} />
        {filtered && (
          <Button variant="ghost" icon={FilterX} onClick={clear}>
            {t('sheet.clearFilters')}
          </Button>
        )}
        <div className="grow" />
        <Button icon={FileSpreadsheet} onClick={exportFile} disabled={!data?.total}>
          Excel
        </Button>
      </div>
      <div className="small muted">
        {data ? t(filtered ? 'logSection.found' : 'logSection.total', { n: data.total.toLocaleString('en-US') }) : ''} · {t('logSection.keptForever')}
      </div>
      {!data ? (
        <Loading />
      ) : data.rows.length === 0 ? (
        <div className="card">
          <Empty icon={History} title={t(filtered ? 'logSection.noMatch' : 'logSection.empty')} />
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table activity-table">
              <thead>
                <tr>
                  <th>{t('activity.when')}</th>
                  <th>{t('activity.who')}</th>
                  <th>{t('payments.student')}</th>
                  <th>{t('activity.what')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((e) => (
                  <HistoryRow
                    key={e.id}
                    e={e}
                    studentCell={
                      e.student_id && e.student_name ? (
                        <button className="link-btn" onClick={() => nav?.('students', { id: e.student_id })}>
                          {e.student_name}
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
          {data.rows.length < data.total && (
            <div className="row" style={{ justifyContent: 'center' }}>
              <Button onClick={() => load(data.rows.length)} disabled={busy}>
                {t('logSection.more', { n: Math.min(PAGE, data.total - data.rows.length), left: (data.total - data.rows.length).toLocaleString('en-US') })}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
