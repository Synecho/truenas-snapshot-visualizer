// Search box query language. Space-separated terms, all must match:
//   text          substring of dataset@snapshot (case-insensitive), -text excludes
//   >10g <=500m   size of the current metric; 5m..1g is a range, =10g means "about 10 GiB"
//   used>1g written<100m ref>=2t     size of a specific metric
//   age>30d age<2w age:7d..30d       age (h, d, w, mo, y; plain number = days)
//   held          only snapshots with a zfs hold
//   /regex/       the whole query as a regular expression on dataset@snapshot
// No imports so it can be unit-tested with plain node.

const SIZE_UNITS = { '': 1, b: 1, k: 2 ** 10, m: 2 ** 20, g: 2 ** 30, t: 2 ** 40, p: 2 ** 50 };
const AGE_UNITS = { '': 86400, h: 3600, d: 86400, w: 7 * 86400, mo: 30.44 * 86400, m: 30.44 * 86400, y: 365.25 * 86400 };
const METRICS = { used: 'used', written: 'written', ref: 'referenced', referenced: 'referenced' };

const TERM = /^(?:(size|used|written|ref|referenced|age)\s*)?(>=|<=|>|<|=|:)?(.+)$/i;
const SIZE = /^(\d+(?:[.,]\d+)?)([kmgtp]?)(?:i?b)?$/;
const AGE = /^(\d+(?:[.,]\d+)?)(h|d|w|mo|m|y)?$/;

/** "10g", "1.5GiB", "500mb", "7b" -> { value: bytes, unit: bytes per unit }; null if not a size */
export function parseSize(s) {
  const m = s.toLowerCase().match(SIZE);
  return m ? { value: parseFloat(m[1].replace(',', '.')) * SIZE_UNITS[m[2]], unit: SIZE_UNITS[m[2]] } : null;
}

/** "30d", "2w", "6mo", "1y", "12h", "30" -> { value: seconds, unit: seconds per unit }; null if not an age */
export function parseAge(s) {
  const m = s.toLowerCase().match(AGE);
  const unit = m && AGE_UNITS[m[2] ?? ''];
  return m ? { value: parseFloat(m[1].replace(',', '.')) * unit, unit } : null;
}

/** One structured term -> predicate; null if it is plain text; 'invalid' if it looks structured but isn't. */
function structured(term, metric) {
  const m = term.match(TERM);
  const field = m?.[1]?.toLowerCase();
  const op = m?.[2];
  const parts = m ? m[3].split('..') : [];
  if (!m || (!field && !op && parts.length === 1)) return null; // plain word like "daily" or "2026-07"
  const isAge = field === 'age';
  const parse = isAge ? parseAge : parseSize;
  const vals = parts.map(parse);
  if (vals.some(v => !v)) {
    // "agent", "reference", "used" are words, not broken filters, when nothing marks them as one
    return field && !op && parts.length === 1 ? null : 'invalid';
  }
  if (parts.length > 2 || (parts.length === 2 && op && op !== '=' && op !== ':')) return 'invalid';
  const key = isAge ? 'age' : (METRICS[field] ?? metric);
  let lo, hi;
  if (parts.length === 2) {
    [lo, hi] = [Math.min(vals[0].value, vals[1].value), Math.max(vals[0].value, vals[1].value)];
  } else if (!op || op === '=' || op === ':') {
    // "about": within the precision of what was typed, 10g = 9.5 .. 10.5 GiB, age:30d = 29.5 .. 30.5 days
    [lo, hi] = [vals[0].value - vals[0].unit / 2, vals[0].value + vals[0].unit / 2];
  } else {
    const v = vals[0].value;
    const cmp = { '>': x => x > v, '>=': x => x >= v, '<': x => x < v, '<=': x => x <= v }[op];
    return s => s[key] != null && cmp(s[key]);
  }
  return s => s[key] != null && s[key] >= lo && s[key] <= hi;
}

/**
 * @param {string} q        search box text
 * @param {string} metric   current size metric ('used' | 'written' | 'referenced')
 * @returns {{ match: ((s) => boolean) | null, invalid: string[] }}
 */
export function parseQuery(q, metric = 'used') {
  q = (q || '').trim();
  if (!q) return { match: null, invalid: [] };
  const re = q.match(/^\/(.+)\/([i]*)$/);
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2] || 'i');
      return { match: s => rx.test(s.id), invalid: [] };
    } catch {
      return { match: null, invalid: [q] };
    }
  }
  const tests = [];
  const invalid = [];
  for (const term of q.split(/\s+/)) {
    const neg = term.length > 1 && term.startsWith('-');
    const body = neg ? term.slice(1) : term;
    let test;
    if (body.toLowerCase() === 'held') {
      test = s => s.holds > 0;
    } else {
      const st = structured(body, metric);
      if (st === 'invalid') { invalid.push(term); continue; }
      const word = body.toLowerCase();
      test = st ?? (s => s.lower.includes(word));
    }
    tests.push(neg ? s => !test(s) : test);
  }
  return { match: tests.length ? s => tests.every(t => t(s)) : null, invalid };
}
