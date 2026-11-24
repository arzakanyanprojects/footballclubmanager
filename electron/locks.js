// Edit locks, kept by the main computer: one person (one app window) edits a record at a time.
// A lock is held while its window keeps saying "still here" (every ~20 s); without that it frees itself
// after TTL, so a crashed or disconnected computer can never leave a record stuck.
// Keys: student:<id> · group:<id> · attendance:<groupId>:<YYYY-MM> · schedule:week:<monday> ·
//       schedule:base · schedule:pitches · settings:club
const TTL = 90 * 1000;

function createLocks({ ttl = TTL, now = () => Date.now() } = {}) {
  const map = new Map(); // key → { key, owner, user, pc, since, seen }
  const alive = (l) => l && now() - l.seen < ttl;
  const get = (key) => {
    const l = map.get(key);
    if (l && !alive(l)) {
      map.delete(key);
      return null;
    }
    return l || null;
  };
  const pub = (l) => ({ key: l.key, user: l.user, pc: l.pc, since: new Date(l.since).toISOString() });
  const clean = (keys) => [...new Set((Array.isArray(keys) ? keys : [keys]).map(String).filter(Boolean))].slice(0, 50);

  // who: { owner, user, pc }. force (admins): take it over from whoever holds it.
  function acquire(keys, who, force = false) {
    keys = clean(keys);
    const busy = keys.map(get).find((l) => l && l.owner !== who.owner) || null;
    if (busy && !force) return { granted: false, holder: pub(busy) };
    const t = now();
    for (const key of keys) {
      const cur = get(key);
      if (cur && cur.owner === who.owner) cur.seen = t;
      else map.set(key, { key, owner: who.owner, user: who.user, pc: who.pc, since: t, seen: t });
    }
    return { granted: true, tookOver: busy ? pub(busy) : null };
  }

  // Keeps the window's locks; returns those it no longer holds (expired, or taken over → holder).
  function heartbeat(keys, owner) {
    const t = now();
    const lost = [];
    for (const key of clean(keys)) {
      const l = get(key);
      if (l && l.owner === owner) l.seen = t;
      else lost.push({ key, holder: l ? pub(l) : null });
    }
    return { lost };
  }

  function release(keys, owner) {
    for (const key of clean(keys)) {
      const l = map.get(key);
      if (l && l.owner === owner) map.delete(key);
    }
    return true;
  }

  const releaseOwner = (owner) => {
    for (const [key, l] of map) if (l.owner === owner) map.delete(key);
  };

  // Who else holds one of these keys (null: free, or held by this window).
  function heldByOther(keys, owner) {
    for (const key of clean(keys)) {
      const l = get(key);
      if (l && l.owner !== owner) return pub(l);
    }
    return null;
  }

  const list = (owner) => [...map.values()].filter(alive).map((l) => ({ ...pub(l), mine: l.owner === owner }));

  return { acquire, heartbeat, release, releaseOwner, heldByOther, list };
}

// Monday of a date's week (YYYY-MM-DD), for the timetable's week locks.
function mondayOf(date) {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(date);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

module.exports = { createLocks, mondayOf };
