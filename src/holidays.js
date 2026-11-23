// Holidays → the share of the monthly fee each month costs. The fee works in half-months
// (I: days 1–15, II: 16 – end of month); a half that is at least half covered by a holiday is free.
// Example: 15.12 – 15.01 → December 50% (its 2nd half), January 50% (its 1st half).
// The same logic is in electron/holidays.js for the server.

const pad = (n) => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(y, m, 0).getDate();
const toDay = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;

// "YYYY-MM" → Set of the halves (1, 2) the date ranges cover.
function freeHalves(holidays) {
  const halves = new Map();
  for (const h of Array.isArray(holidays) ? holidays : []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h?.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(h?.to || '') || h.to < h.from) continue;
    const a = toDay(h.from);
    const b = toDay(h.to);
    let y = Number(h.from.slice(0, 4));
    let m = Number(h.from.slice(5, 7));
    for (let i = 0; i < 36; i++) {
      const period = `${y}-${pad(m)}`;
      if (period > h.to.slice(0, 7)) break;
      const last = daysIn(y, m);
      for (const [half, d1, d2] of [[1, 1, 15], [2, 16, last]]) {
        const s = toDay(`${period}-${pad(d1)}`);
        const e = toDay(`${period}-${pad(d2)}`);
        const overlap = Math.min(b, e) - Math.max(a, s) + 1;
        if (overlap * 2 >= e - s + 1) {
          if (!halves.has(period)) halves.set(period, new Set());
          halves.get(period).add(half);
        }
      }
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
  }
  return halves;
}

function feeShares(holidays) {
  return Object.fromEntries([...freeHalves(holidays)].map(([p, set]) => [p, 100 - 50 * set.size]));
}

const parseHolidays = (raw) => {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export { feeShares, freeHalves, parseHolidays };
