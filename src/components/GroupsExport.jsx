// «Արտահանել խմբերը»: all groups to Excel — one sheet per year (2012-1, 2012-2 → sheet «2012»), each
// group a block with a coloured title (group · coach · assistant) and its students, in the columns
// the user picks here (ticked and ordered; remembered on this PC).
import { useState } from 'react';
import { ChevronUp, ChevronDown, Download, RotateCcw } from 'lucide-react';
import { useT } from '../i18n';
import { rpc, money, seasonMonths, todayIso } from '../lib';
import { useCan } from './Auth';
import { Button, Modal, useAction, useClub } from './ui';
import { MONTH_MARK, monthStatus } from '../pages/Students';

const GROUPS_PREF_KEY = 'fc.groupsExport.columns';
// Sheet colours (Excel ARGB), one per year in turn.
const SHEET_COLORS = ['FF1BAF7A', 'FF2A78D6', 'FFEB6834', 'FF6250D6', 'FFEDA100', 'FFE34948', 'FF008300', 'FFE87BA4', 'FF0E7490', 'FF8B5CF6'];

function useColumnDefs(flat) {
  const t = useT();
  const canPay = useCan('payments');
  const parent = (k) => `${t('students.parent')} · ${t(k)}`;
  return [
    { id: 'index', label: '№', type: 'index', width: 5, on: true },
    { id: 'fullName', label: t('groupsExport.fullName'), width: 34, on: true, get: (s) => [s.first_name, s.last_name, s.patronymic].filter(Boolean).join(' ') },
    // One list of everyone (no group titles): the group is a column.
    flat && { id: 'group', label: t('students.group'), width: 14, on: true, get: (s) => s.group_name || '' },
    flat && { id: 'coach', label: t('students.coach'), width: 22, get: (s) => s.group_coach || '' },
    { id: 'firstName', label: t('students.firstName'), width: 16, get: (s) => s.first_name },
    { id: 'lastName', label: t('students.lastName'), width: 18, get: (s) => s.last_name },
    { id: 'patronymic', label: t('students.patronymic'), width: 16, get: (s) => s.patronymic },
    { id: 'birthDate', label: t('students.birthDate'), type: 'date', width: 13, on: true, get: (s) => s.birth_date },
    { id: 'documentNo', label: t('students.documentNo'), width: 20, get: (s) => s.document_no },
    { id: 'contractNo', label: t('students.contractNo'), width: 14, on: true, get: (s) => s.contract_no },
    { id: 'medical', label: t('students.medicalDoc'), width: 16, on: true, get: (s) => t(s.medical_doc ? 'medicalDoc.provided' : 'medicalDoc.missing') },
    { id: 'category', label: t('students.category'), width: 20, get: (s) => (s.category ? t(`category.${s.category}`) : '') },
    { id: 'service', label: t('students.service'), width: 18, get: (s) => s.service },
    canPay && { id: 'fee', label: t('students.monthlyFee'), type: 'money', width: 13, get: (s) => s.monthly_fee },
    { id: 'joinDate', label: t('students.joinDate'), type: 'date', width: 13, get: (s) => s.join_date },
    { id: 'status', label: t('students.status'), width: 14, on: true, get: (s) => t(`status.${s.status}`) },
    { id: 'leaveDate', label: t('students.leaveDate'), type: 'date', width: 13, get: (s) => s.leave_date },
    { id: 'parentName', label: t('students.parent'), width: 24, on: true, get: (s) => s.parent_name },
    { id: 'parentPhone', label: parent('parent.phone'), width: 16, on: true, get: (s) => s.parent_phone },
    { id: 'parentMessenger', label: parent('parent.messenger'), width: 16, get: (s) => s.parent_messenger },
    { id: 'parentEmail', label: parent('parent.email'), width: 24, get: (s) => s.parent_email },
    { id: 'parentSsn', label: parent('parent.ssn'), width: 14, get: (s) => s.parent_ssn },
    { id: 'parentDoc', label: parent('parent.docNo'), width: 16, get: (s) => s.parent_doc_no },
    { id: 'parentAddress', label: parent('parent.address'), width: 30, get: (s) => s.parent_address },
    { id: 'notes', label: t('students.notes'), width: 30, get: (s) => s.notes },
    canPay && { id: 'months', label: t('groupsExport.months') },
  ].filter(Boolean);
}

function loadPref(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

// flat: «Բոլոր սաները» — everyone on one sheet, sorted by group and name (instead of a sheet per year).
export function GroupsExportModal({ groups, onClose, flat = false }) {
  const t = useT();
  const act = useAction();
  const { currency } = useClub();
  // All students: every detail by default (the full name covers first / last name / patronymic).
  const defs = useColumnDefs(flat)
    .filter(Boolean)
    .map((d) => (flat ? { ...d, on: !['firstName', 'lastName', 'patronymic', 'coach'].includes(d.id) } : d));
  const PREF_KEY = flat ? 'fc.studentsExport.columns' : GROUPS_PREF_KEY;
  const byId = Object.fromEntries(defs.map((d) => [d.id, d]));
  const ids = defs.map((d) => d.id);
  const [pref, setPref] = useState(() => {
    const p = loadPref(PREF_KEY);
    if (!p) return { order: ids, on: defs.filter((d) => d.on).map((d) => d.id) };
    // Columns added later go at the end, off.
    return { order: [...p.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !p.order.includes(id))], on: p.on.filter((id) => ids.includes(id)) };
  });
  const save = (next) => {
    setPref(next);
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(next));
    } catch {
      /* this session only */
    }
  };
  const toggle = (id) => save({ ...pref, on: pref.on.includes(id) ? pref.on.filter((x) => x !== id) : [...pref.on, id] });
  const move = (i, to) => {
    if (to < 0 || to >= pref.order.length) return;
    const order = [...pref.order];
    const [x] = order.splice(i, 1);
    order.splice(to, 0, x);
    save({ ...pref, order });
  };
  const reset = () => {
    try {
      localStorage.removeItem(PREF_KEY);
    } catch {
      /* ignore */
    }
    setPref({ order: ids, on: defs.filter((d) => d.on).map((d) => d.id) });
  };
  const chosen = pref.order.filter((id) => pref.on.includes(id));
  const list = (groups || []).filter((g) => !g.archived);

  const run = () =>
    act(async () => {
      const months = seasonMonths();
      const students = await rpc('students.list', { status: null, monthsFrom: months[0], monthsTo: months[months.length - 1] });
      // Excel columns (the months item becomes the season's 12 month columns).
      const columns = chosen.flatMap((id) =>
        id === 'months'
          ? months.map((p) => ({ key: `m:${p}`, header: `${t(`month.s${Number(p.slice(5))}`)} ${p.slice(2, 4)}`, type: 'month', width: 8 }))
          : [{ key: id, header: byId[id].label, type: byId[id].type || 'text', width: byId[id].width }]
      );
      const rowOf = (s, i) => {
        const byMonth = Object.fromEntries((s.months || []).map((m) => [m.period, m]));
        const row = { _inactive: s.status !== 'active' };
        for (const c of columns) {
          if (c.type === 'month') {
            const p = c.key.slice(2);
            const st = monthStatus(byMonth[p], p, s.join_date);
            // A paid month shows the amount paid (✓ only if no amount was entered); the others their mark.
            const m = byMonth[p];
            const paid = st === 'paid' && m?.amount > 0;
            row[c.key] = {
              mark: paid ? m.amount : st === 'none' ? '' : MONTH_MARK[st] ?? '',
              status: st,
              // For the totals under the group: paid amounts, and amounts still owed (overdue or not yet due).
              paid: st === 'paid' ? m.amount || 0 : 0,
              debt: st === 'overdue' || st === 'unpaid' ? m.amount || 0 : 0,
            };
          } else if (c.key === 'index') row.index = i + 1;
          else row[c.key] = byId[c.key].get(s) ?? '';
        }
        return row;
      };
      const yearOf = (name) => (String(name).match(/^\s*((?:19|20)\d{2})/) || [])[1] || null;
      const other = t('groupsExport.other');
      const bySheet = new Map();
      const block = (title, members, name = title) => ({ title, name, rows: members.map(rowOf) });
      for (const g of list) {
        const sheet = yearOf(g.name) || other;
        if (!bySheet.has(sheet)) bySheet.set(sheet, []);
        bySheet.get(sheet).push(block([g.name, g.coach, g.assistant].filter(Boolean).join('   •   '), students.filter((s) => s.group_id === g.id), g.name));
      }
      const loose = students.filter((s) => !s.group_id || !list.some((g) => g.id === s.group_id));
      if (loose.length) {
        if (!bySheet.has(other)) bySheet.set(other, []);
        bySheet.get(other).push(block(t('students.noGroup'), loose));
      }
      const names = [...bySheet.keys()].sort((a, b) => (a === other) - (b === other) || a.localeCompare(b, 'hy', { numeric: true }));
      const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'hy', { numeric: true, sensitivity: 'base' });
      const everyone = [...students].sort(
        (a, b) => !a.group_name - !b.group_name || cmp(a.group_name, b.group_name) || cmp(a.last_name, b.last_name) || cmp(a.first_name, b.first_name)
      );
      const sheets = flat
        ? [{ name: t('nav.students'), color: SHEET_COLORS[0], groups: [block(t('groupsExport.allTitle', { n: everyone.length, date: todayIso().split('-').reverse().join('/') }), everyone)] }]
        : names.map((name, i) => ({ name, color: SHEET_COLORS[i % SHEET_COLORS.length], groups: bySheet.get(name) }));
      const r = await window.fc.saveXlsx({
        kind: 'groups',
        defaultName: `${flat ? 'students' : 'groups'}-${todayIso()}.xlsx`,
        currencySymbol: money(0, currency).replace(/[\d,.\s]/g, '') || currency,
        emptyText: t('groupsExport.noStudents'),
        labels: {
          paid: t('groupsExport.totalPaid'),
          debt: t('groupsExport.totalDebt'),
          grandSheet: t('groupsExport.grandSheet'),
          grandTitle: t('groupsExport.grandTitle'),
          grandTotal: t('groupsExport.grandTotal'),
          group: t('students.group'),
          noGrand: flat, // one list: its totals are under it, no summary sheet
        },
        columns,
        sheets,
      });
      if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error, detail: r.detail });
      onClose();
    }, t('groupsExport.saved'));

  return (
    <Modal
      title={t(flat ? 'groupsExport.allButton' : 'groupsExport.title')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={Download} onClick={run} disabled={!chosen.length || (!flat && !list.length)}>
            {t('groupsExport.run')}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        <div className="muted small">{t(flat ? 'groupsExport.allHint' : 'groupsExport.hint')}</div>
        <div className="row">
          <span className="strong grow">{t('groupsExport.columns', { n: chosen.length })}</span>
          <button className="link-btn small" onClick={reset}>
            <RotateCcw size={13} /> {t('columns.reset')}
          </button>
        </div>
        <div className="columns-list" style={{ maxHeight: 380 }}>
          {pref.order.map((id, i) => (
            <div key={id} className="columns-item">
              <label className="check grow">
                <input type="checkbox" checked={pref.on.includes(id)} onChange={() => toggle(id)} />
                {byId[id].label}
              </label>
              <button className="icon-btn" disabled={i === 0} onClick={() => move(i, i - 1)} title={t('columns.up')}>
                <ChevronUp size={14} />
              </button>
              <button className="icon-btn" disabled={i === pref.order.length - 1} onClick={() => move(i, i + 1)} title={t('columns.down')}>
                <ChevronDown size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
