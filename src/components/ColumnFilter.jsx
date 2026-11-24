// Excel-style column filters: a small button in a column header opens a menu with sorting (A→Z / Z→A),
// a search box and the column's values as a tick list (with how many rows have each).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownAZ, ArrowUpZA, ChevronDown, Filter, Search } from 'lucide-react';
import { useT } from '../i18n';
import { Button } from './ui';

const collator = new Intl.Collator('hy', { numeric: true, sensitivity: 'base' });
// Compares two sort values: numbers as numbers, text in Armenian alphabet order; empty values last.
export function compareValues(a, b) {
  const ea = a === '' || a == null;
  const eb = b === '' || b == null;
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/**
 * Filters and sorts rows by the columns' filters.
 * defs: { [id]: { value: (row) => string, sort?: (row) => any } }
 * filters: { [id]: string[] (the values shown) }, sort: { id, dir: 1 | -1 } | null
 */
export function applyColumnFilters(rows, defs, filters, sort) {
  const active = Object.entries(filters).filter(([id]) => defs[id]);
  let out = active.length
    ? rows.filter((r) => active.every(([id, allowed]) => allowed.includes(defs[id].value(r) ?? '')))
    : rows;
  if (sort && defs[sort.id]) {
    const d = defs[sort.id];
    const key = d.sort || d.value;
    out = [...out].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      const ea = ka === '' || ka == null;
      const eb = kb === '' || kb == null;
      if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1; // empty last in both directions
      return compareValues(ka, kb) * sort.dir;
    });
  }
  return out;
}

// The header button: highlighted when the column is filtered or sorted.
export function FilterButton({ active, sorted, onOpen, title }) {
  const ref = useRef(null);
  return (
    <button
      ref={ref}
      type="button"
      className={`th-filter ${active ? 'on' : ''} ${sorted ? 'sorted' : ''}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(ref.current.getBoundingClientRect());
      }}
    >
      {active ? <Filter size={11} /> : <ChevronDown size={12} />}
      {sorted ? <span className="th-sort">{sorted > 0 ? '↑' : '↓'}</span> : null}
    </button>
  );
}

const LIST_MAX = 400; // values drawn at once (search narrows long lists such as names)

/**
 * The menu. values: [{ value, label, count, sort }] of the rows the other filters leave;
 * selected: string[] | undefined (undefined = everything shown).
 */
export function FilterMenu({ rect, values, selected, sortDir, onSort, onApply, onClose }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Set(selected || values.map((v) => v.value)));
  const box = useRef(null);
  const [pos, setPos] = useState({ left: rect.left, top: rect.bottom + 4 });

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - w - 8)),
      top: rect.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, rect.top - h - 4) : rect.bottom + 4,
    });
  }, [rect]);
  useEffect(() => {
    const down = (e) => !box.current?.contains(e.target) && onClose();
    const key = (e) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('mousedown', down), 0);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? values.filter((v) => v.label.toLowerCase().includes(s)) : values;
  }, [values, q]);
  const allOn = shown.length > 0 && shown.every((v) => picked.has(v.value));
  const toggleAll = () => {
    const next = new Set(picked);
    for (const v of shown) allOn ? next.delete(v.value) : next.add(v.value);
    setPicked(next);
  };
  const toggle = (v) => {
    const next = new Set(picked);
    next.has(v) ? next.delete(v) : next.add(v);
    setPicked(next);
  };
  const apply = () => {
    // With a search, like Excel: only the ticked values that match the search.
    const chosen = q.trim() ? shown.filter((v) => picked.has(v.value)).map((v) => v.value) : values.filter((v) => picked.has(v.value)).map((v) => v.value);
    onApply(chosen.length === values.length ? undefined : chosen);
  };

  return createPortal(
    <div ref={box} className="filter-menu" style={{ left: pos.left, top: pos.top }} onClick={(e) => e.stopPropagation()}>
      <button className={`filter-sort ${sortDir === 1 ? 'on' : ''}`} onClick={() => onSort(sortDir === 1 ? 0 : 1)}>
        <ArrowDownAZ size={15} /> {t('colFilter.sortAsc')}
      </button>
      <button className={`filter-sort ${sortDir === -1 ? 'on' : ''}`} onClick={() => onSort(sortDir === -1 ? 0 : -1)}>
        <ArrowUpZA size={15} /> {t('colFilter.sortDesc')}
      </button>
      <div className="filter-sep" />
      <div className="search filter-search">
        <Search size={14} />
        <input className="input" autoFocus value={q} placeholder={t('colFilter.search')} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} />
      </div>
      <div className="filter-list">
        <label className="check filter-item strong">
          <input type="checkbox" checked={allOn} onChange={toggleAll} />
          <span className="grow">{t(q.trim() ? 'colFilter.selectFound' : 'colFilter.selectAll')}</span>
        </label>
        {shown.slice(0, LIST_MAX).map((v) => (
          <label key={v.value} className="check filter-item">
            <input type="checkbox" checked={picked.has(v.value)} onChange={() => toggle(v.value)} />
            <span className="grow">{v.value === '' ? <span className="muted">{t('colFilter.blank')}</span> : v.label}</span>
            <span className="muted small num">{v.count}</span>
          </label>
        ))}
        {shown.length > LIST_MAX && <div className="small muted filter-item">{t('colFilter.more', { n: shown.length - LIST_MAX })}</div>}
        {!shown.length && <div className="small muted filter-item">{t('colFilter.none')}</div>}
      </div>
      <div className="filter-foot">
        <Button size="sm" onClick={() => onApply(undefined)} disabled={!selected}>
          {t('colFilter.clear')}
        </Button>
        <div className="grow" />
        <Button size="sm" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" onClick={apply} disabled={!picked.size}>
          OK
        </Button>
      </div>
    </div>,
    document.body
  );
}

// The values of one column, with counts, for the menu (in the column's sort order).
export function columnValues(rows, def) {
  const map = new Map();
  for (const r of rows) {
    const v = def.value(r) ?? '';
    const cur = map.get(v);
    if (cur) cur.count++;
    else map.set(v, { value: v, label: def.label ? def.label(v, r) : v, count: 1, sort: def.sort ? def.sort(r) : v });
  }
  return [...map.values()].sort((a, b) => compareValues(a.sort, b.sort));
}
