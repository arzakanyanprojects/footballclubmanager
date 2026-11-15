import { useEffect, useMemo, useRef, useState } from 'react';
import { Columns3, ChevronUp, ChevronDown, GripVertical, RotateCcw } from 'lucide-react';
import { useT } from '../i18n';
import { Button } from './ui';
import { useAuth } from './Auth';

/**
 * Lets the user pick which columns a table shows and in what order. Saved on this computer, per user.
 *
 * defs: [{ id, label, head: () => <th>…</th>, cell: (row) => <td>…</td>,
 *          fixed?: always shown, never moved   defaultHidden?: off until the user turns it on
 *          available?: false hides it completely (e.g. no rights) }]
 * Returns { columns: the visible defs in order, button: the "Columns" button }.
 */
export function useColumns(viewId, defs) {
  const auth = useAuth();
  const key = `fc.columns.${viewId}.${auth.user?.id || 0}`;
  const [pref, setPref] = useState(() => load(key));
  useEffect(() => setPref(load(key)), [key]);

  const avail = defs.filter((d) => d.available !== false);
  const ids = avail.map((d) => d.id);
  const save = (next) => {
    setPref(next);
    try {
      if (next) localStorage.setItem(key, JSON.stringify(next));
      else localStorage.removeItem(key);
    } catch {
      /* storage unavailable: keep it for this session only */
    }
  };

  // Saved order first; columns added in a later version go next to their default neighbour.
  const order = useMemo(() => {
    const saved = (pref?.order || []).filter((id) => ids.includes(id));
    const out = [...saved];
    ids.forEach((id, i) => {
      if (out.includes(id)) return;
      const before = ids.slice(0, i).reverse().find((x) => out.includes(x));
      out.splice(before ? out.indexOf(before) + 1 : 0, 0, id);
    });
    return out;
  }, [pref, ids.join('|')]);

  const known = new Set(pref?.known || []);
  const isHidden = (d) => (known.has(d.id) ? (pref.hidden || []).includes(d.id) : !!d.defaultHidden);
  const byId = Object.fromEntries(avail.map((d) => [d.id, d]));
  // Fixed columns keep their default place.
  const movable = order.filter((id) => !byId[id].fixed);
  const arranged = [];
  let m = 0;
  for (const id of ids) arranged.push(byId[id].fixed ? id : movable[m++]);
  const columns = arranged.map((id) => byId[id]).filter((d) => d.fixed || !isHidden(d));

  const state = () => ({
    order: movable,
    hidden: avail.filter((d) => !d.fixed && isHidden(d)).map((d) => d.id),
    known: ids,
  });
  const toggle = (id) => {
    const s = state();
    s.hidden = s.hidden.includes(id) ? s.hidden.filter((x) => x !== id) : [...s.hidden, id];
    save(s);
  };
  const move = (id, to) => {
    const s = state();
    const from = s.order.indexOf(id);
    if (to < 0 || to >= s.order.length || from === to) return;
    s.order.splice(from, 1);
    s.order.splice(to, 0, id);
    save(s);
  };

  const button = (
    <ColumnsButton
      items={movable.map((id) => ({ id, label: byId[id].label, hidden: isHidden(byId[id]) }))}
      onToggle={toggle}
      onMove={move}
      onReset={() => save(null)}
    />
  );
  return { columns, button };
}

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function ColumnsButton({ items, onToggle, onMove, onReset }) {
  const t = useT();
  const [pos, setPos] = useState(null);
  const [drag, setDrag] = useState(null);
  const panel = useRef(null);

  useEffect(() => {
    if (!pos) return;
    const close = (e) => panel.current && !panel.current.contains(e.target) && setPos(null);
    const esc = (e) => e.key === 'Escape' && setPos(null);
    setTimeout(() => document.addEventListener('mousedown', close), 0);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [pos]);

  const open = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const width = 290;
    setPos({ left: Math.max(12, Math.min(r.right - width, window.innerWidth - width - 12)), top: r.bottom + 6, width });
  };

  return (
    <>
      <Button icon={Columns3} onClick={(e) => (pos ? setPos(null) : open(e))}>
        {t('columns.button')}
      </Button>
      {pos && (
        <div className="columns-panel" ref={panel} style={pos}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="strong grow">{t('columns.title')}</span>
            <button className="link-btn small" onClick={onReset}>
              <RotateCcw size={13} /> {t('columns.reset')}
            </button>
          </div>
          <div className="small muted" style={{ marginBottom: 8 }}>{t('columns.hint')}</div>
          <div className="columns-list">
            {items.map((it, i) => (
              <div
                key={it.id}
                className={`columns-item ${drag === it.id ? 'dragging' : ''}`}
                draggable
                onDragStart={() => setDrag(it.id)}
                onDragEnd={() => setDrag(null)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (drag && drag !== it.id) onMove(drag, i);
                }}
              >
                <GripVertical size={14} className="muted grip" />
                <label className="check grow">
                  <input type="checkbox" checked={!it.hidden} onChange={() => onToggle(it.id)} />
                  {it.label}
                </label>
                <button className="icon-btn" disabled={i === 0} onClick={() => onMove(it.id, i - 1)} title={t('columns.up')}>
                  <ChevronUp size={14} />
                </button>
                <button className="icon-btn" disabled={i === items.length - 1} onClick={() => onMove(it.id, i + 1)} title={t('columns.down')}>
                  <ChevronDown size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
