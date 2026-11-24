import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Download, Users, Paperclip, Camera, Trash2, UserRound, FileText, Wallet, StickyNote, FilterX, FileSignature } from 'lucide-react';
import { useT, monthName } from '../i18n';
import { useCan } from '../components/Auth';
import { useColumns } from '../components/Columns';
import { FilterButton, FilterMenu, applyColumnFilters, columnValues } from '../components/ColumnFilter';
import { ConflictBanner, EditingMark, useEditLock, useLocks } from '../components/Locks';
import { useRpc, rpc, fmtDate, saveCsv, todayIso, resizeImage, seasonMonths, money, readFileBase64 } from '../lib';
import { Avatar, Badge, Button, Empty, Field, Loading, Modal, Money, SearchBox, Segmented, useAction, useClub } from '../components/ui';
import { PayModal } from './Payments';
import { ContractReadyModal } from './Contracts';

export const CATEGORIES = ['siblings', 'half', 'war', 'staff', 'orphan'];

// The club's services, as listed in its records (Armenian only).
export const SERVICES = [
  'Առաջնություն անվճար',
  'Առաջնություն զեղչված',
  'Առաջնություն վճարովի',
  'Դարպասապահ 12',
  'Դարպասապահ 16',
  'Դարպասապահ 4',
  'Դարպասապահ 8',
  'Մարզահագուստ (ամառային)',
  'Մարզահագուստ (ձմեռային)',
  'Ուսումնամարզական',
  'Ուսումնամարզական %',
  'Ուսումնամարզական անվճար',
  'Ֆուտբոլ անհ. 4',
  'Ֆուտբոլ անհ. 8',
  'Ֆուտբոլ անհ.12',
  'Ֆուտբոլ անհ.16',
];

export const MONTH_MARK = { paid: '✓', overdue: '✕', unpaid: '•', waived: '—', excused: '✓', notyet: '' };

// Status of one monthly fee: paid, overdue, unpaid (not yet due), waived, notyet (before the student's
// join month: not contracted yet — a grey square), or none (no fee for that month).
export function monthStatus(m, period, joinDate) {
  if (!m) return period && joinDate && period < joinDate.slice(0, 7) ? 'notyet' : 'none';
  if (m.status === 'waived' && m.excused_by) return 'excused';
  if (m.status !== 'unpaid') return m.status;
  return m.due_date && m.due_date < todayIso() ? 'overdue' : 'unpaid';
}

export default function Students({ nav, route }) {
  const act = useAction();
  const canEdit = useCan('students');
  const canPay = useCan('payments');
  const t = useT();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const [groupId, setGroupId] = useState(route.groupId ? String(route.groupId) : '');
  const [debtOnly, setDebtOnly] = useState(!!route.debtOnly);
  const [category, setCategory] = useState(''); // '' all · 'none' without a category · a category key
  const [editing, setEditing] = useState(route.create ? {} : null);
  const [paying, setPaying] = useState(null);
  const { currency } = useClub();
  const months = useMemo(() => seasonMonths(), []);
  const { data: groups } = useRpc('groups.list');
  const locks = useLocks(); // who else is editing which student (✎ markers)
  const { data, loading } = useRpc('students.list', {
    search,
    status: status || null,
    groupId: groupId ? Number(groupId) : null,
    monthsFrom: months[0],
    monthsTo: months[months.length - 1],
  });

  const baseRows = useMemo(
    () =>
      (data || [])
        .filter((s) => !debtOnly || s.overdue > 0)
        .filter((s) => !category || (category === 'none' ? !s.category : s.category === category))
        .map((s) => ({ ...s, byMonth: Object.fromEntries(s.months.map((m) => [m.period, m])) })),
    [data, debtOnly, category]
  );

  // Excel-style filters in the column headers: { columnId: values shown }, and one sorted column.
  const [colFilters, setColFilters] = useState({});
  const [sort, setSort] = useState(null); // { id, dir: 1 | -1 }
  const [menu, setMenu] = useState(null); // { id, rect }
  const fdefs = useMemo(() => {
    const plainDef = (get, sortBy) => ({ value: (s) => String(get(s) ?? ''), ...(sortBy ? { sort: sortBy } : {}) });
    const STATUS_ORDER = ['paid', 'excused', 'overdue', 'unpaid', 'waived', 'notyet', 'none'];
    const defs = {
      name: plainDef((s) => [s.first_name, s.last_name, s.patronymic].filter(Boolean).join(' ')),
      group: plainDef((s) => s.group_name),
      parent: plainDef((s) => s.parent_name),
      medical: plainDef((s) => t(s.medical_doc ? 'medicalDoc.provided' : 'medicalDoc.missing')),
      fee: plainDef((s) => (s.monthly_fee ? money(s.monthly_fee, currency) : ''), (s) => Number(s.monthly_fee) || ''),
      debt: plainDef((s) => (s.overdue > 0 ? money(s.overdue, currency) : ''), (s) => Number(s.overdue) || ''),
      status: plainDef((s) => t(`status.${s.status}`)),
      birthDate: plainDef((s) => fmtDate(s.birth_date), (s) => s.birth_date || ''),
      joinDate: plainDef((s) => fmtDate(s.join_date), (s) => s.join_date || ''),
      category: plainDef((s) => (s.category ? t(`category.${s.category}`) : '')),
      service: plainDef((s) => s.service),
      contractNo: plainDef((s) => s.contract_no),
      parentPhone: plainDef((s) => s.parent_phone),
      parentMessenger: plainDef((s) => s.parent_messenger),
      parentEmail: plainDef((s) => s.parent_email),
      parentSsn: plainDef((s) => s.parent_ssn),
      parentDoc: plainDef((s) => s.parent_doc_no),
      parentAddress: plainDef((s) => s.parent_address),
      inactiveReason: plainDef((s) => s.inactive_reason),
    };
    for (const p of months) {
      const st = (s) => monthStatus(s.byMonth[p], p, s.join_date);
      defs[`m:${p}`] = {
        value: (s) => (st(s) === 'none' ? '' : t(`chargeStatus.${st(s)}`)),
        sort: (s) => (st(s) === 'none' ? '' : STATUS_ORDER.indexOf(st(s))),
      };
    }
    return defs;
  }, [months, t, currency]);
  const rows = useMemo(() => applyColumnFilters(baseRows, fdefs, colFilters, sort), [baseRows, fdefs, colFilters, sort]);
  // The header button of a column.
  const fb = (id, label) => (
    <FilterButton
      active={!!colFilters[id]}
      sorted={sort?.id === id ? sort.dir : 0}
      title={t('colFilter.title', { column: label })}
      onOpen={(rect) => setMenu({ id, rect })}
    />
  );
  const headLabel = (id, label) => (
    <span className="th-in">
      {label}
      {fb(id, label)}
    </span>
  );


  // Big lists draw in steps: the first rows right away, more as the list is scrolled to its end.
  const STEP = 150;
  const [limit, setLimit] = useState(STEP);
  useEffect(() => setLimit(STEP), [rows]);
  const moreRef = useRef(null);
  useEffect(() => {
    const el = moreRef.current;
    if (!el || limit >= rows.length) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setLimit((l) => l + STEP * 2), {
      root: el.closest('.table-wrap'),
      rootMargin: '600px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [limit, rows.length]);

  // «Ցուցադրված է 2 սան 97-ից»: the students shown with the filters, of all students in this tab (active / inactive / all).
  const { data: counts } = useRpc('students.summary');
  const totalHere = counts ? Number(status === 'active' ? counts.active : status === 'inactive' ? counts.inactive : counts.total) || 0 : null;
  const shownText =
    totalHere != null && rows.length !== totalHere
      ? t('students.shownOf', { n: rows.length, total: totalHere })
      : t('students.count', { n: rows.length });

  // Any filter differing from the default (active students, everything else off) → «Մաքրել ֆիլտրերը».
  const filtered = !!(search.trim() || groupId || category || debtOnly || status !== 'active' || Object.keys(colFilters).length || sort);
  const clearFilters = () => {
    setColFilters({});
    setSort(null);
    setSearch('');
    setGroupId('');
    setCategory('');
    setDebtOnly(false);
    setStatus('active');
  };

  const text = (v) => v || <span className="muted">—</span>;
  const plain = (id, label, get, opts = {}) => ({
    id,
    label,
    head: () => <th className={opts.num ? 'num' : ''}>{headLabel(id, label)}</th>,
    cell: (s) => <td className={opts.num ? 'num' : opts.nowrap ? 'nowrap' : ''}>{text(get(s))}</td>,
    ...opts,
  });
  const { columns, button: columnsButton } = useColumns('students', [
    {
      id: 'name',
      label: t('students.name'),
      fixed: true,
      head: () => <th className="sticky-col">{headLabel('name', t('students.name'))}</th>,
      cell: (s) => (
        <td className="sticky-col">
          <div className="cell-person">
            <Avatar first={s.first_name} last={s.last_name} seed={s.id} size={28} />
            <div>
              <div className="name nowrap">
                {s.first_name} {s.last_name}
                {s.patronymic ? ` ${s.patronymic}` : ''}
                <EditingMark holder={locks[`student:${s.id}`]} />
              </div>
            </div>
          </div>
        </td>
      ),
    },
    {
      id: 'group',
      label: t('students.group'),
      head: () => <th>{headLabel('group', t('students.group'))}</th>,
      cell: (s) => (
        <td>
          {s.group_name ? (
            <>
              <span className="row nowrap" style={{ gap: 7 }}>
                <span className="dot" style={{ background: s.group_color || undefined }} />
                {s.group_name}
              </span>
              {s.group_coach && <div className="small muted nowrap" title={t('students.coach')}>{s.group_coach}</div>}
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      ),
    },
    {
      id: 'parent',
      label: t('students.parent'),
      head: () => <th>{headLabel('parent', t('students.parent'))}</th>,
      cell: (s) => (
        <td>
          <div className="parent-name" title={s.parent_name || ''}>{s.parent_name || '—'}</div>
          <div className="small muted">{s.parent_phone}</div>
        </td>
      ),
    },
    {
      id: 'medical',
      label: t('students.medicalDoc'),
      head: () => <th title={t('students.medicalDoc')}>{headLabel('medical', t('students.medicalShort'))}</th>,
      cell: (s) => (
        <td title={`${t('students.medicalDoc')}: ${t(s.medical_doc ? 'medicalDoc.provided' : 'medicalDoc.missing')}`}>
          <Badge tone={s.medical_doc ? 'good' : 'warn'}>{s.medical_doc ? '✓' : '✕'}</Badge>
        </td>
      ),
    },
    {
      id: 'fee',
      label: t('students.monthlyFee'),
      available: canPay,
      head: () => <th className="num">{headLabel('fee', t('students.monthlyFee'))}</th>,
      cell: (s) => (
        <td className="num">
          <Money value={s.monthly_fee} />
        </td>
      ),
    },
    {
      id: 'months',
      label: t('columns.months'),
      available: canPay,
      head: () =>
        months.map((p) => (
          <th key={p} className={`mcol ${colFilters[`m:${p}`] || sort?.id === `m:${p}` ? 'filtered' : ''}`} title={monthName(t, p)}>
            {t(`month.s${Number(p.slice(5))}`)}
            <div style={{ fontWeight: 400 }}>{p.slice(2, 4)}</div>
            {fb(`m:${p}`, monthName(t, p))}
          </th>
        )),
      cell: (s) =>
        months.map((p) => {
          const m = s.byMonth[p];
          const st = monthStatus(m, p, s.join_date);
          const tip = m ? `${monthName(t, p)} · ${money(m.amount, currency)} · ${t(`chargeStatus.${st}`)}` : monthName(t, p);
          const payable = canPay && (st === 'overdue' || st === 'unpaid');
          return (
            <td key={p} className="mcol">
              <span
                className={`pay-cell ${st} ${payable ? 'payable' : ''}`}
                title={payable ? `${tip} — ${t('payments.pay')}` : tip}
                onClick={(e) => {
                  if (!payable) return;
                  e.stopPropagation();
                  setPaying([{ ...m, kind: 'monthly', student_id: s.id, first_name: s.first_name, last_name: s.last_name }]);
                }}
              >
                {MONTH_MARK[st] ?? '·'}
              </span>
            </td>
          );
        }),
    },
    {
      id: 'debt',
      label: t('columns.debt'),
      available: canPay,
      defaultHidden: true,
      head: () => <th className="num">{headLabel('debt', t('columns.debt'))}</th>,
      cell: (s) => (
        <td className="num">{s.overdue > 0 ? <Money value={s.overdue} className="strong" /> : <span className="muted">—</span>}</td>
      ),
    },
    {
      id: 'status',
      label: t('students.status'),
      // Only with «Բոլորը»: when the list shows active (or inactive) students only, the column says the same on every row.
      available: status === '',
      head: () => <th>{headLabel('status', t('students.status'))}</th>,
      cell: (s) => (
        <td>
          <Badge tone={s.status === 'active' ? 'accent' : ''}>{t(`status.${s.status}`)}</Badge>
        </td>
      ),
    },
    plain('birthDate', t('students.birthDate'), (s) => fmtDate(s.birth_date), { defaultHidden: true, nowrap: true }),
    plain('joinDate', t('students.joinDate'), (s) => fmtDate(s.join_date), { defaultHidden: true, nowrap: true }),
    plain('category', t('students.category'), (s) => (s.category ? t(`category.${s.category}`) : ''), { defaultHidden: true }),
    plain('service', t('students.service'), (s) => s.service, { defaultHidden: true }),
    plain('contractNo', t('students.contractNo'), (s) => s.contract_no, { defaultHidden: true, nowrap: true }),
    plain('parentPhone', `${t('students.parent')} · ${t('parent.phone')}`, (s) => s.parent_phone, { defaultHidden: true, nowrap: true }),
    plain('parentMessenger', `${t('students.parent')} · ${t('parent.messenger')}`, (s) => s.parent_messenger, { defaultHidden: true, nowrap: true }),
    plain('parentEmail', `${t('students.parent')} · ${t('parent.email')}`, (s) => s.parent_email, { defaultHidden: true }),
    plain('parentSsn', `${t('students.parent')} · ${t('parent.ssn')}`, (s) => s.parent_ssn, { defaultHidden: true, nowrap: true }),
    plain('parentDoc', `${t('students.parent')} · ${t('parent.docNo')}`, (s) => s.parent_doc_no, { defaultHidden: true, nowrap: true }),
    plain('parentAddress', `${t('students.parent')} · ${t('parent.address')}`, (s) => s.parent_address, { defaultHidden: true }),
    plain('inactiveReason', t('students.inactiveReason'), (s) => s.inactive_reason, { defaultHidden: true }),
  ]);

  const exportCsv = () =>
    saveCsv(`students-${todayIso()}.csv`, [
      [t('students.firstName'), t('students.lastName'), t('students.patronymic'), t('students.birthDate'), t('students.group'), t('students.coach'),
        t('parent.firstName'), t('parent.lastName'), t('parent.ssn'), t('parent.docNo'), t('parent.docIssuer'), t('parent.docDate'),
        t('parent.phone'), t('parent.messenger'), t('parent.email'), t('parent.address'), t('students.medicalDoc'), t('students.category'), t('students.service'), t('students.contractNo'), t('students.monthlyFee'), t('students.joinDate'), t('students.status'), t('students.inactiveReason'),
        ...months.map((p) => monthName(t, p))],
      ...rows.map((s) => [s.first_name, s.last_name, s.patronymic, fmtDate(s.birth_date), s.group_name, s.group_coach,
        s.parent_first_name, s.parent_last_name, s.parent_ssn, s.parent_doc_no, s.parent_doc_issuer, fmtDate(s.parent_doc_date),
        s.parent_phone, s.parent_messenger, s.parent_email, s.parent_address,
        t(s.medical_doc ? 'medicalDoc.provided' : 'medicalDoc.missing'), s.category ? t(`category.${s.category}`) : '', s.service, s.contract_no, s.monthly_fee, fmtDate(s.join_date), t(`status.${s.status}`), s.inactive_reason,
        ...months.map((p) => {
          const st = monthStatus(s.byMonth[p], p, s.join_date);
          return st === 'none' ? '' : t(`chargeStatus.${st}`);
        })]),
    ]);

  return (
    // The page fills the window: title, filters and column headers stay; only the rows scroll.
    <div className="fill-page">
      <div className="page-head">
        <div>
          <h1>{t('nav.students')}</h1>
          <div className="sub">{data ? shownText : ' '}</div>
        </div>
        <div className="spacer" />
        {columnsButton}
        <Button icon={Download} onClick={exportCsv} disabled={!rows.length}>
          {t('common.exportCsv')}
        </Button>
        {canEdit && (
          <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
            {t('students.add')}
          </Button>
        )}
      </div>

      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder={t('students.searchPlaceholder')} />
        <select className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">{t('students.allGroups')}</option>
          {(groups || []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 'auto', maxWidth: 240 }} value={category} onChange={(e) => setCategory(e.target.value)} title={t('students.category')}>
          <option value="">{t('students.allCategories')}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`category.${c}`)}
            </option>
          ))}
          <option value="none">{t('students.noCategory')}</option>
        </select>
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: t('status.active') },
            { value: 'inactive', label: t('status.inactive') },
            { value: '', label: t('common.all') },
          ]}
        />
        {canPay && (
          <label className="check">
            <input type="checkbox" checked={debtOnly} onChange={(e) => setDebtOnly(e.target.checked)} />
            {t('students.withDebt')}
          </label>
        )}
        {filtered && (
          <Button variant="ghost" icon={FilterX} onClick={clearFilters}>
            {t('students.clearFilters')}
          </Button>
        )}
        <div className="grow" />
        {canPay && columns.some((c) => c.id === 'months') && (
          <span className="small muted row" style={{ gap: 6 }}>
            {['paid', 'excused', 'overdue', 'unpaid', 'waived'].map((k) => `${MONTH_MARK[k]} ${t(`chargeStatus.${k}`)}`).join(' · ')} ·
            <span className="pay-cell notyet legend" /> {t('chargeStatus.notyet')}
          </span>
        )}
      </div>

      {loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="card">
          <Empty
            icon={Users}
            title={t('students.empty')}
            text={filtered ? t('common.tryFilters') : t('students.emptyText')}
            action={
              filtered ? (
                <Button icon={FilterX} onClick={clearFilters}>
                  {t('students.clearFilters')}
                </Button>
              ) : (
                canEdit && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>{t('students.add')}</Button>
              )
            }
          />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table students-table">
            <thead>
              <tr>{columns.map((c) => <Fragment key={c.id}>{c.head()}</Fragment>)}</tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((s) => (
                <tr key={s.id} className="click" onClick={() => nav('students', { id: s.id })}>
                  {columns.map((c) => <Fragment key={c.id}>{c.cell(s)}</Fragment>)}
                </tr>
              ))}
            </tbody>
          </table>
          {limit < rows.length && <div ref={moreRef} className="table-foot small muted">…</div>}
          <div className="table-foot small muted">{shownText}</div>
        </div>
      )}

      {menu && fdefs[menu.id] && (
        <FilterMenu
          key={menu.id}
          rect={menu.rect}
          // Like Excel: the values left by the other columns' filters.
          values={columnValues(applyColumnFilters(baseRows, fdefs, Object.fromEntries(Object.entries(colFilters).filter(([k]) => k !== menu.id)), null), fdefs[menu.id])}
          selected={colFilters[menu.id]}
          sortDir={sort?.id === menu.id ? sort.dir : 0}
          onSort={(dir) => {
            setSort(dir ? { id: menu.id, dir } : null);
            setMenu(null);
          }}
          onApply={(vals) => {
            setColFilters((f) => {
              const next = { ...f };
              if (vals) next[menu.id] = vals;
              else delete next[menu.id];
              return next;
            });
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}

      {paying && <PayModal charges={paying} onClose={() => setPaying(null)} onDone={() => setPaying(null)} />}

      {editing && (
        <StudentForm
          student={editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            if (!editing.id) nav('students', { id });
          }}
        />
      )}
    </div>
  );
}

export function StudentForm({ student, onClose, onSaved }) {
  const t = useT();
  const act = useAction();
  const { data: groups } = useRpc('groups.list');
  const fileRef = useRef(null);
  const docRef = useRef(null);
  const [medicalFile, setMedicalFile] = useState(null); // picked, uploaded on save
  const init = (student) => ({
    first_name: '',
    last_name: '',
    patronymic: '',
    category: '',
    contract_no: '',
    service: '',
    inactive_reason: '',
    birth_date: '',
    gender: '',
    phone: '',
    email: '',
    address: '',
    document_no: '',
    parent_first_name: '',
    parent_last_name: '',
    parent_doc_no: '',
    parent_doc_issuer: '',
    parent_doc_date: '',
    parent_ssn: '',
    parent_address: '',
    parent_email: '',
    parent_phone: '',
    parent_messenger: '',
    medical_doc: 0,
    group_id: '',
    monthly_fee: '',
    join_date: todayIso(),
    status: 'active',
    notes: '',
    photo: null,
    ...Object.fromEntries(Object.entries(student).map(([k, v]) => [k, v ?? ''])),
  });
  const [f, setF] = useState(() => init(student));
  // The latest saved data (after someone else's change), replacing what is in the form.
  const [conflict, setConflict] = useState(null);
  const reload = async () => {
    if (!student.id) return;
    const fresh = await rpc('students.get', { id: student.id }).catch(() => null);
    if (fresh?.student) setF(init(fresh.student));
    setConflict(null);
  };
  // One person edits a student at a time (the form, payments, applications…).
  const lock = useEditLock(student.id ? `student:${student.id}` : null, { onGranted: reload });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e?.target ? e.target.value : e }));

  const pickPhoto = async (e) => {
    const file = e.target.files?.[0];
    if (file) setF((s) => ({ ...s, photo: null }));
    if (file) {
      const data = await resizeImage(file);
      setF((s) => ({ ...s, photo: data }));
    }
    e.target.value = '';
  };

  // A new student is saved together with their contract (filled from the Word template, ready to print).
  const canContracts = useCan('contracts');
  const { data: templates } = useRpc('docTemplates.list', {}, { skip: !!student.id || !canContracts });
  const withContract = !student.id && canContracts && templates?.length > 0;
  const [templateId, setTemplateId] = useState(() => {
    try {
      return localStorage.getItem('fc.newStudent.template') || '';
    } catch {
      return '';
    }
  });
  const tplId = (templates || []).some((tp) => String(tp.id) === templateId) ? templateId : String(templates?.[0]?.id || '');
  const [ready, setReady] = useState(null); // { contractId, studentId, number }

  const save = async () => {
    setConflict(null);
    const r = await act(async () => {
      const res = await rpc('students.save', f).catch((err) => {
        if (err.code !== 'CONFLICT') throw err;
        setConflict(err.detail || {});
        throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
      });
      if (medicalFile && f.medical_doc) await rpc('files.upload', { studentId: res.id, kind: 'medical', ...medicalFile });
      return res;
    }, withContract ? null : t('common.saved'));
    if (!r) return;
    if (!withContract) return onSaved(r.id);
    // The student is saved; now the contract, kept under the student (its documents).
    const c = await act(() =>
      rpc('contracts.create', { studentId: r.id, docTemplateId: Number(tplId), contractDate: todayIso(), startDate: f.join_date || todayIso() })
    );
    if (!c) return onSaved(r.id); // the student stays saved; the contract can be made from their page
    try {
      localStorage.setItem('fc.newStudent.template', tplId);
    } catch {
      /* per-PC convenience only */
    }
    setReady({ contractId: c.id, studentId: r.id, number: f.contract_no });
  };

  if (ready)
    return (
      <ContractReadyModal
        contractId={ready.contractId}
        number={ready.number}
        studentName={[f.first_name, f.last_name, f.patronymic].filter(Boolean).join(' ')}
        onClose={() => onSaved(ready.studentId)}
      />
    );

  return (
    <Modal
      title={student.id ? t('students.edit') : t('students.add')}
      onClose={onClose}
      width={760}
      lock={lock}
      footer={
        <>
          {withContract && templates.length > 1 && (
            <select className="select left" style={{ width: 'auto', maxWidth: 260 }} value={tplId} onChange={(e) => setTemplateId(e.target.value)} title={t('contracts.template')}>
              {templates.map((tp) => (
                <option key={tp.id} value={tp.id}>
                  {tp.name}
                </option>
              ))}
            </select>
          )}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            icon={withContract ? FileSignature : undefined}
            onClick={save}
            disabled={!f.first_name.trim() || !f.last_name.trim() || (withContract && !tplId)}
          >
            {withContract ? t('students.createContract') : t('common.save')}
          </Button>
        </>
      }
    >
      <ConflictBanner conflict={conflict} onReload={reload} />
      <div className="stack" style={{ gap: 0 }}>
        <FormSection icon={UserRound} title={t('form.student')}>
          <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
            <div className="stack" style={{ gap: 6, alignItems: 'center' }}>
              <div className="photo-pick" onClick={() => fileRef.current.click()} title={t('students.photo')}>
                {f.photo ? <img src={f.photo} alt="" /> : <Camera size={26} />}
              </div>
              {f.photo && (
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => set('photo')(null)}>
                  {t('common.remove')}
                </Button>
              )}
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickPhoto} />
            </div>
            <div className="grid-3 grow">
              <Field label={`${t('students.firstName')} *`}>
                <input className="input" value={f.first_name} onChange={set('first_name')} autoFocus />
              </Field>
              <Field label={`${t('students.lastName')} *`}>
                <input className="input" value={f.last_name} onChange={set('last_name')} />
              </Field>
              <Field label={t('students.patronymic')}>
                <input className="input" value={f.patronymic} onChange={set('patronymic')} />
              </Field>
              <Field label={t('students.birthDate')}>
                <input className="input" type="date" value={f.birth_date} onChange={set('birth_date')} />
              </Field>
            </div>
          </div>
        </FormSection>

        <FormSection icon={FileText} title={t('form.documents')}>
          <div className="grid-3">
            <Field label={t('students.documentNo')}>
              <input className="input" value={f.document_no} onChange={set('document_no')} />
            </Field>
            <Field label={t('students.contractNo')}>
              <input className="input" value={f.contract_no} onChange={set('contract_no')} />
            </Field>
            <Field label={t('students.medicalDoc')}>
              <select className="select" value={f.medical_doc ? '1' : '0'} onChange={(e) => set('medical_doc')(Number(e.target.value))}>
                <option value="0">{t('medicalDoc.missing')}</option>
                <option value="1">{t('medicalDoc.provided')}</option>
              </select>
            </Field>
            {!!f.medical_doc && (
              <Field label={t('files.medicalUpload')} hint={student.id ? t('files.medicalUploadHintEdit') : t('files.medicalUploadHint')} className="span-3">
                <div className="row wrap">
                  <Button icon={Paperclip} onClick={() => docRef.current.click()}>
                    {medicalFile ? t('files.otherFile') : t('files.choose')}
                  </Button>
                  {medicalFile && (
                    <>
                      <span className="small strong">{medicalFile.name}</span>
                      <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setMedicalFile(null)} />
                    </>
                  )}
                  <input
                    ref={docRef}
                    type="file"
                    accept="image/*,application/pdf,.doc,.docx"
                    hidden
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) setMedicalFile(await readFileBase64(file));
                    }}
                  />
                </div>
              </Field>
            )}
          </div>
        </FormSection>

        <FormSection icon={Users} title={t('form.parent')}>
          <div className="grid-3">
            <Field label={t('parent.firstName')}>
              <input className="input" value={f.parent_first_name} onChange={set('parent_first_name')} />
            </Field>
            <Field label={t('parent.lastName')}>
              <input className="input" value={f.parent_last_name} onChange={set('parent_last_name')} />
            </Field>
            <Field label={t('parent.ssn')}>
              <input className="input" value={f.parent_ssn} onChange={set('parent_ssn')} />
            </Field>
            <Field label={t('parent.docNo')}>
              <input className="input" value={f.parent_doc_no} onChange={set('parent_doc_no')} />
            </Field>
            <Field label={t('parent.docIssuer')}>
              <input className="input" value={f.parent_doc_issuer} onChange={set('parent_doc_issuer')} />
            </Field>
            <Field label={t('parent.docDate')}>
              <input className="input" type="date" value={f.parent_doc_date} onChange={set('parent_doc_date')} />
            </Field>
            <Field label={t('parent.phone')}>
              <input className="input" value={f.parent_phone} onChange={set('parent_phone')} />
            </Field>
            <Field label={t('parent.messenger')}>
              <input className="input" value={f.parent_messenger} onChange={set('parent_messenger')} />
            </Field>
            <Field label={t('parent.email')}>
              <input className="input" value={f.parent_email} onChange={set('parent_email')} />
            </Field>
            <Field label={t('parent.address')} className="span-3">
              <input className="input" value={f.parent_address} onChange={set('parent_address')} />
            </Field>
          </div>
        </FormSection>

        <FormSection icon={Wallet} title={t('form.training')}>
          <div className="grid-3">
            <Field label={t('students.group')}>
              <select className="select" value={f.group_id} onChange={set('group_id')}>
                <option value="">{t('students.noGroup')}</option>
                {(groups || []).filter((g) => !g.archived || g.id === Number(f.group_id)).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.coach ? `${g.name} — ${g.coach}` : g.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('students.monthlyFee')} hint={t('students.monthlyFeeHint')}>
              <input className="input" type="number" min="0" step="500" value={f.monthly_fee} onChange={set('monthly_fee')} />
            </Field>
            <Field label={`${t('students.joinDate')} *`}>
              <input className="input" type="date" value={f.join_date} onChange={set('join_date')} />
            </Field>
            <Field label={t('students.service')}>
              <select className="select" value={f.service || ''} onChange={set('service')}>
                <option value="">—</option>
                {SERVICES.map((sv) => (
                  <option key={sv} value={sv}>
                    {sv}
                  </option>
                ))}
                {f.service && !SERVICES.includes(f.service) && <option value={f.service}>{f.service}</option>}
              </select>
            </Field>
            <Field label={t('students.category')}>
              <select className="select" value={f.category || ''} onChange={set('category')}>
                <option value="">—</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`category.${c}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('students.status')}>
              <select className="select" value={f.status} onChange={set('status')}>
                <option value="active">{t('status.active')}</option>
                <option value="inactive">{t('status.inactive')}</option>
              </select>
            </Field>
            {f.status === 'inactive' && (
              <Field label={t('students.inactiveReason')}>
                <input className="input" value={f.inactive_reason || ''} onChange={set('inactive_reason')} autoFocus />
              </Field>
            )}
          </div>
        </FormSection>

        <FormSection icon={StickyNote} title={t('students.notes')}>
          <textarea className="textarea" rows={3} value={f.notes} onChange={set('notes')} />
        </FormSection>
      </div>
    </Modal>
  );
}

export function FormSection({ icon: Icon, title, children }) {
  return (
    <section className="form-section">
      <h4>
        <Icon size={16} />
        {title}
      </h4>
      {children}
    </section>
  );
}
