import { useEffect, useRef, useState } from 'react';
import { Users, Wallet, AlertTriangle, CalendarCheck, Plus, ChevronRight, FileClock, FileSpreadsheet, MessageCircle } from 'lucide-react';
import { useT, monthName } from '../i18n';
import { useCan } from '../components/Auth';
import { MessageButton, useMessenger } from '../components/Messenger';
import { useRpc, rpc, compactMoney, fmtDate, fmtDateTime, money, todayIso } from '../lib';
import { Avatar, Button, Empty, Loading, Money, useClub } from '../components/ui';
import { chargeLabel, MethodTag } from './Payments';
import { ReportsModal } from '../components/Reports';

export default function Dashboard({ nav }) {
  const t = useT();
  const { currency } = useClub();
  const { data } = useRpc('dashboard.summary');
  const [exporting, setExporting] = useState(false);
  const [chartMode, setChartMode] = useState('paid'); // 'paid': by payment date · 'fees': by the month the fee is for
  if (!data) return <Loading />;

  const m = data.monthlyThisPeriod;
  const pct = m.expected ? Math.round((m.paid / m.expected) * 100) : 0;
  const delta = data.collectedThisMonth - data.collectedLastMonth;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav.dashboard')}</h1>
          <div className="sub">{t('dash.subtitle', { date: fmtDate(todayIso()) })}</div>
        </div>
        <div className="spacer" />
        <Button variant="primary" icon={FileSpreadsheet} onClick={() => setExporting(true)}>
          {t('reportsx.title')}
        </Button>
      </div>
      {exporting && <ReportsModal onClose={() => setExporting(false)} />}

      <div className="stats">
        <div className="card stat">
          <div className="stat-top">
            {t('dash.activeStudents')}
            <div className="stat-icon">
              <Users size={18} />
            </div>
          </div>
          <div className="stat-value">{data.activeStudents.toLocaleString('en-US')}</div>
          <div className="stat-sub">{t('dash.newThisMonth', { n: data.newThisMonth })}</div>
        </div>
        <div className="card stat">
          <div className="stat-top">
            {t('dash.collectedThisMonth')}
            <div className="stat-icon info">
              <Wallet size={18} />
            </div>
          </div>
          <div className="stat-value">{money(data.collectedThisMonth, currency)}</div>
          <div className="stat-sub">
            {delta >= 0 ? '+' : '−'}
            {money(Math.abs(delta), currency)} {t('dash.vsLastMonth')}
          </div>
        </div>
        <div className="card stat click" style={{ cursor: 'pointer' }} onClick={() => nav('students', { debtOnly: true })}>
          <div className="stat-top">
            {t('dash.overdue')}
            <div className="stat-icon bad">
              <AlertTriangle size={18} />
            </div>
          </div>
          <div className="stat-value">{money(data.overdue.total, currency)}</div>
          <div className="stat-sub">{t('dash.overdueStudents', { n: data.overdue.students })}</div>
        </div>
        <div className="card stat">
          <div className="stat-top">
            {t('dash.attendanceToday')}
            <div className="stat-icon warn">
              <CalendarCheck size={18} />
            </div>
          </div>
          <div className="stat-value">
            {data.attendanceToday.present || 0}
            <span className="muted" style={{ fontSize: 16, fontWeight: 500 }}>
              {' '}
              / {data.attendanceToday.marked}
            </span>
          </div>
          <div className="stat-sub">{t('dash.presentOfMarked')}</div>
        </div>
      </div>

      <div className="dash-grid">
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <h3>{t('dash.monthlyFees', { month: monthName(t, data.collections.at(-1).period) })}</h3>
              <div className="spacer" />
              <span className="small muted">
                {t('dash.paidOf', { paid: m.paidCount || 0, total: m.count || 0 })}
              </span>
            </div>
            <div className="card-pad stack" style={{ gap: 8 }}>
              <div className="row">
                <span className="strong">{money(m.paid, currency)}</span>
                <span className="muted">/ {money(m.expected, currency)}</span>
                <div className="spacer grow" />
                <span className="strong">{pct}%</span>
              </div>
              <div className="progress">
                <div style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>{t(chartMode === 'fees' ? 'dash.feesPaid' : 'dash.collections')}</h3>
              <div className="spacer" />
              <div className="seg">
                {['paid', 'fees'].map((m) => (
                  <button key={m} className={chartMode === m ? 'on' : ''} onClick={() => setChartMode(m)}>
                    {t(`dash.chart_${m}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="small muted" style={{ padding: '0 18px' }}>{t(chartMode === 'fees' ? 'dash.feesPaidHint' : 'dash.collectionsHint')}</div>
            <CollectionsChart rows={chartMode === 'fees' ? data.feesPaid || data.collections : data.collections} currency={currency} />
          </div>

          <div className="card">
            <div className="card-head">
              <h3>{t('dash.recentPayments')}</h3>
            </div>
            {data.recentPayments.length === 0 ? (
              <Empty title={t('dash.noPayments')} />
            ) : (
              <div className="list">
                {data.recentPayments.map((p) => (
                  <div key={p.id} className="list-item click" onClick={() => nav('students', { id: p.student_id })}>
                    <Avatar first={p.first_name} last={p.last_name} seed={p.student_id} size={30} />
                    <div className="grow">
                      <div>
                        {p.first_name} {p.last_name}
                      </div>
                      <div className="small muted">
                        {chargeLabel(t, p)} · {fmtDate(p.paid_at)} · <MethodTag method={p.method} />
                      </div>
                    </div>
                    <Money value={p.amount} className="strong" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <h3>{t('dash.debtors')}</h3>
              <div className="spacer" />
              {data.debtors.length > 0 && <DebtorsMessageButton />}
              <Button size="sm" variant="ghost" onClick={() => nav('students', { debtOnly: true })}>
                {t('common.viewAll')} <ChevronRight size={15} />
              </Button>
            </div>
            {data.debtors.length === 0 ? (
              <Empty title={t('dash.noDebtors')} />
            ) : (
              <div className="list">
                {data.debtors.map((d) => (
                  <div key={d.id} className="list-item click" onClick={() => nav('students', { id: d.id })}>
                    <Avatar first={d.first_name} last={d.last_name} seed={d.id} size={30} />
                    <div className="grow">
                      <div>
                        {d.first_name} {d.last_name}
                      </div>
                      <div className="small muted">
                        {d.group_name || t('students.noGroup')} · {t('dash.since', { date: fmtDate(d.oldest) })}
                      </div>
                    </div>
                    <span className="strong num" style={{ color: 'var(--bad)' }}>
                      {money(d.debt, currency)}
                    </span>
                    <MessageButton studentIds={[d.id]} kind="reminder" variant="ghost" label="" />
                  </div>
                ))}
              </div>
            )}
          </div>

          {data.expiringContracts.length > 0 && (
            <div className="card">
              <div className="card-head">
                <FileClock size={17} />
                <h3>{t('dash.expiringContracts')}</h3>
              </div>
              <div className="list">
                {data.expiringContracts.map((c) => (
                  <div key={c.id} className="list-item click" onClick={() => nav('contracts', { openId: c.id })}>
                    <div className="grow">
                      {c.first_name} {c.last_name}
                      <div className="small muted">№ {c.number}</div>
                    </div>
                    <span className="small">{fmtDate(c.end_date)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <h3>{t('dash.activity')}</h3>
            </div>
            {data.activity.length === 0 ? (
              <Empty title={t('dash.noActivity')} />
            ) : (
              <div className="list">
                {data.activity.map((a) => (
                  <div key={a.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                    <div className="grow">
                      <div className="small">
                        <span className="strong">{t(`activity.${a.action}`)}</span>
                        {a.details && <span className="muted"> · {a.details}</span>}
                      </div>
                      <div className="small muted">
                        {fmtDateTime(a.at)}
                        {a.user && ` · ${a.user}`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// Single-series bar chart of money collected per month, with hover tooltip.
function CollectionsChart({ rows, currency }) {
  const t = useT();
  const [hover, setHover] = useState(null);
  // Draw at the card's real width with a fixed height, so the chart doesn't grow taller on wide windows.
  const box = useRef(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const H = 150;
  const pad = { l: 56, r: 8, t: 12, b: 26 };
  const max = Math.max(...rows.map((r) => r.total), 1);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / rows.length;
  const bw = Math.min(46, slot * 0.56);
  const y = (v) => pad.t + ih - (v / top) * ih;

  return (
    <div className="chart">
      <div style={{ position: 'relative' }} ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} height={H} role="img" aria-label={t('dash.collections')}>
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
            <text className="axis" x={pad.l - 8} y={y(v) + 4} textAnchor="end">
              {compactMoney(v, currency)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = pad.l + slot * i + (slot - bw) / 2;
          const h = Math.max(y(0) - y(r.total), r.total ? 2 : 0);
          const rad = Math.min(4, h / 2);
          return (
            <g key={r.period} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent" />
              {h > 0 && (
                <path
                  className={`bar ${hover != null && hover !== i ? 'dim' : ''}`}
                  d={`M${x},${y(0)} V${y(0) - h + rad} Q${x},${y(0) - h} ${x + rad},${y(0) - h} H${x + bw - rad} Q${x + bw},${y(0) - h} ${x + bw},${y(0) - h + rad} V${y(0)} Z`}
                />
              )}
              <text className="axis" x={x + bw / 2} y={H - 6} textAnchor="middle">
                {monthName(t, r.period, true)}
              </text>
            </g>
          );
        })}
      </svg>
      {hover != null && (
        <div
          className="chart-tip"
          style={{
            left: `${((pad.l + slot * hover + slot / 2) / W) * 100}%`,
            top: `calc(${(y(rows[hover].total) / H) * 100}% + 2px)`,
          }}
        >
          <div className="muted">{monthName(t, rows[hover].period)}</div>
          <div className="strong">{money(rows[hover].total, currency)}</div>
        </div>
      )}
      </div>
    </div>
  );
}

function niceStep(raw) {
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

// «Հիշեցնել բոլորին»: every student with an overdue payment, biggest debt first, one chat after another.
function DebtorsMessageButton() {
  const t = useT();
  const messenger = useMessenger();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      icon={MessageCircle}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const list = await rpc('students.list', { status: 'active' });
          const ids = list.filter((s) => s.overdue > 0).sort((a, b) => b.overdue - a.overdue).map((s) => s.id);
          messenger?.open(ids, 'reminder');
        } finally {
          setBusy(false);
        }
      }}
    >
      {t('messenger.remindAll')}
    </Button>
  );
}
