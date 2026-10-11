import { getLang } from './i18n.js';

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

export function fmtBytes(n, digits) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '–';
  if (n === 0) return '0 B';
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  const d = digits ?? (v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2);
  return `${n < 0 ? '-' : ''}${v.toLocaleString(getLang(), { maximumFractionDigits: d, minimumFractionDigits: d })} ${UNITS[i]}`;
}

export function fmtNum(n) {
  return n == null ? '–' : n.toLocaleString(getLang());
}

export function fmtPct(x) {
  if (!Number.isFinite(x)) return '–';
  return (x * 100).toLocaleString(getLang(), { maximumFractionDigits: x < 0.1 ? 1 : 0 }) + ' %';
}

export function fmtAge(seconds) {
  if (seconds == null) return '–';
  const s = Math.max(0, seconds);
  const de = getLang() === 'de';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  const d = s / 86400;
  if (d < 60) return `${Math.round(d)} ${de ? 'T' : 'd'}`;
  if (d < 730) return `${Math.round(d / 30.44)} ${de ? 'Mon' : 'mo'}`;
  return `${(d / 365.25).toLocaleString(getLang(), { maximumFractionDigits: 1 })} ${de ? 'J' : 'y'}`;
}

export function fmtDate(ts, withTime = true) {
  if (ts == null) return '–';
  const opts = withTime
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' };
  return new Date(ts * 1000).toLocaleString(getLang(), opts);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Turn "auto-daily-2026-10-11_00-00" into "auto-daily-‹date›" so periodic tasks group together. */
export function schemaOf(name) {
  return name
    .replace(/\d{4}[-_.]?\d{2}[-_.]?\d{2}(?:[_T.\- ]?\d{2}[-:.]?\d{2}(?:[-:.]?\d{2})?)?/g, '‹date›')
    .replace(/\d+/g, '#');
}

/* ---------------- colors ---------------- */

// fresh -> old: green, yellow-green, amber, orange, red
const AGE_STOPS = [
  [0.0, [56, 176, 110]],
  [0.3, [162, 196, 64]],
  [0.55, [242, 190, 48]],
  [0.78, [240, 120, 48]],
  [1.0, [196, 40, 52]],
];

function lerpStops(stops, t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
    }
  }
  return stops[stops.length - 1][1];
}

/** Map an age in seconds to an RGB triple, log scaled up to maxAge. */
export function ageColor(ageSec, maxAgeSec) {
  const d = Math.max(0, ageSec) / 86400;
  const m = Math.max(2, maxAgeSec / 86400);
  return lerpStops(AGE_STOPS, Math.log1p(d) / Math.log1p(m));
}

export function ageGradientCss() {
  return `linear-gradient(90deg, ${AGE_STOPS.map(([t, c]) => `rgb(${c.join(',')}) ${t * 100}%`).join(', ')})`;
}

// distinct, reasonably bright palette for categorical coloring (cushion shading darkens them)
const PALETTE = [
  [66, 133, 244], [234, 67, 53], [251, 188, 5], [52, 168, 83], [171, 71, 188],
  [0, 172, 193], [255, 112, 67], [158, 157, 36], [92, 107, 192], [240, 98, 146],
  [38, 166, 154], [141, 110, 99], [120, 144, 156], [212, 225, 87], [255, 167, 38],
];

export function paletteColor(i) {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export function rgb(c, a) {
  return a == null ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

export const SHARED_COLOR = [150, 156, 164];

export function debounce(fn, ms) {
  let h;
  return (...args) => { clearTimeout(h); h = setTimeout(() => fn(...args), ms); };
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
