// Edit locks (kept by the main computer): only one window edits a record at a time.
// useEditLock takes the lock while a form is open (or, lazily, at the first change), keeps it alive and
// gives it back when the form closes. Someone else's lock makes the form read-only with a banner; admins
// can take it over. LocksProvider shows who is editing what (the small ✎ markers in lists).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Lock, PencilLine } from 'lucide-react';
import { useT } from '../i18n';
import { rpc } from '../lib';
import { useAuth } from './Auth';
import { Button, useConfirm } from './ui';

const HEARTBEAT_MS = 20 * 1000;
const RETRY_MS = 8 * 1000; // a busy form checks this often whether the record became free
const LIST_MS = 8 * 1000;

const call = (method, params) => rpc(method, params).catch(() => null);
const timeOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const holderName = (h) => (h ? (h.pc && h.pc !== h.user ? `${h.user} (${h.pc})` : h.user || h.pc || '—') : '—');

/**
 * keys: a lock key or a list (null/empty: no lock).
 * lazy: take the lock only at the first change (call `ensure()`); idleMs: give it back after that long
 * without a change (lazy locks only). onGranted: called when a busy record becomes ours (reload its data).
 */
export function useEditLock(keys, { lazy = false, idleMs = 0, onGranted, keepWhile } = {}) {
  const t = useT();
  const auth = useAuth();
  const confirm = useConfirm();
  const list = useMemo(() => (Array.isArray(keys) ? keys : [keys]).filter(Boolean), [JSON.stringify(keys)]);
  const sig = list.join('|');
  const [st, setState] = useState({ status: list.length ? (lazy ? 'idle' : 'pending') : 'off', holder: null, tookOver: null });
  const statusRef = useRef(st.status);
  const setSt = (v) => {
    statusRef.current = v.status;
    setState(v);
  };
  const blocked = () => statusRef.current === 'busy' || statusRef.current === 'lost';
  const held = useRef(false);
  const lastUse = useRef(Date.now());
  const granted = useRef(onGranted);
  granted.current = onGranted;
  const keep = useRef(keepWhile); // e.g. unsaved changes: don't give the lock back for being idle
  keep.current = keepWhile;

  const acquire = useCallback(
    async (force = false) => {
      if (!list.length) return true;
      const r = await call('locks.acquire', { keys: list, force });
      if (!r) return true; // main computer unreachable: the save itself will tell
      if (r.granted) {
        const wasBlocked = blocked();
        held.current = true;
        setSt({ status: 'mine', holder: null, tookOver: r.tookOver || null });
        // The record was someone else's until now: its data may have changed meanwhile.
        if (wasBlocked) granted.current?.();
        return true;
      }
      held.current = false;
      setSt({ status: 'busy', holder: r.holder, tookOver: null });
      return false;
    },
    [sig]
  );

  // Take the lock (eager forms), keep it alive, retry while busy, give it back on close.
  useEffect(() => {
    if (!list.length) return;
    let stop = false;
    if (!lazy) acquire();
    const beat = setInterval(async () => {
      if (stop) return;
      if (held.current) {
        if (keep.current?.()) lastUse.current = Date.now();
        if (lazy && idleMs && Date.now() - lastUse.current > idleMs) {
          held.current = false;
          call('locks.release', { keys: list });
          setSt({ status: 'idle', holder: null, tookOver: null });
          return;
        }
        const r = await call('locks.heartbeat', { keys: list });
        const lost = r?.lost?.find((l) => l.holder);
        if (lost) {
          held.current = false;
          setSt({ status: 'lost', holder: lost.holder, tookOver: null });
        } else if (r?.lost?.length) acquire(); // expired (e.g. the PC slept): take it again if free
      }
    }, HEARTBEAT_MS);
    const retry = setInterval(() => {
      if (!stop && !held.current && blocked()) acquire();
    }, RETRY_MS);
    return () => {
      stop = true;
      clearInterval(beat);
      clearInterval(retry);
      if (held.current) call('locks.release', { keys: list });
      held.current = false;
    };
  }, [sig]);

  // Lazy locks: call before a change; false when someone else is editing.
  const ensure = useCallback(async () => {
    lastUse.current = Date.now();
    if (!list.length || held.current) return true;
    return acquire();
  }, [sig, acquire]);

  const isAdmin = !auth?.required || !!auth?.user?.is_admin;
  const takeOver = async () => {
    const ok = await confirm({
      title: t('lock.takeOverTitle'),
      text: t('lock.takeOverText', { who: holderName(st.holder) }),
      confirmLabel: t('lock.takeOver'),
    });
    if (ok) {
      lastUse.current = Date.now();
      await acquire(true);
    }
  };

  const readOnly = st.status === 'busy' || st.status === 'lost';
  const banner = readOnly ? (
    <div className={`lock-banner ${st.status}`}>
      <Lock size={16} />
      <div className="grow">
        {st.status === 'lost'
          ? t('lock.lost', { who: holderName(st.holder) })
          : t('lock.busy', { who: holderName(st.holder), time: timeOf(st.holder?.since) })}
        <div className="small muted">{t(st.status === 'lost' ? 'lock.lostHint' : 'lock.busyHint')}</div>
      </div>
      {isAdmin && (
        <Button size="sm" onClick={takeOver}>
          {t('lock.takeOver')}
        </Button>
      )}
    </div>
  ) : null;
  return { status: st.status, holder: st.holder, readOnly, banner, ensure, takeOver, isAdmin };
}

// ---------------------------------------------------------------- who is editing what (markers)
const LocksCtx = createContext({});

export function LocksProvider({ children }) {
  const [byKey, setByKey] = useState({});
  useEffect(() => {
    let live = true;
    const load = async () => {
      const r = await call('locks.list');
      if (live && Array.isArray(r)) setByKey(Object.fromEntries(r.filter((l) => !l.mine).map((l) => [l.key, l])));
    };
    load();
    const id = setInterval(load, LIST_MS);
    const off = window.fc.onDataChanged?.(load);
    return () => {
      live = false;
      clearInterval(id);
      off?.();
    };
  }, []);
  return <LocksCtx.Provider value={byKey}>{children}</LocksCtx.Provider>;
}

// Someone else editing this key right now (or null).
export const useLockHolder = (key) => useContext(LocksCtx)[key] || null;
export const useLocks = () => useContext(LocksCtx);

// The small marker: ✎ Աննա
export function EditingMark({ holder }) {
  const t = useT();
  if (!holder) return null;
  return (
    <span className="editing-mark" title={t('lock.markTitle', { who: holderName(holder), time: timeOf(holder.since) })}>
      <PencilLine size={11} />
      {holder.user || holder.pc}
    </span>
  );
}

// A save refused because someone else changed the record meanwhile: who, and a reload button.
export function ConflictBanner({ conflict, onReload }) {
  const t = useT();
  if (!conflict) return null;
  return (
    <div className="lock-banner lost">
      <Lock size={16} />
      <div className="grow">
        {t('lock.conflict', { who: conflict.who || '—', at: conflict.at ? conflict.at.slice(11, 16) : '' })}
        <div className="small muted">{t('lock.conflictHint')}</div>
      </div>
      <Button size="sm" onClick={onReload}>
        {t('lock.reload')}
      </Button>
    </div>
  );
}

// Monday of a date's week (YYYY-MM-DD) — the timetable is locked a week at a time.
export function mondayOf(date) {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(date);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
