// Timeline: one lane per dataset, one bubble per snapshot (x = creation, area = size).

import { fmtAge, fmtBytes, fmtDate, escapeHtml, rgb } from './util.js';
import { getLang } from './i18n.js';

const LABEL_W = 250;
const AXIS_H = 30;
const LANE_H = 24;
const PAD_R = 24;
const R_MAX = 11;

export class Timeline {
  constructor(wrap, canvas, handlers = {}) {
    this.wrap = wrap;
    this.canvas = canvas;
    this.h = handlers;
    this.data = null;
    this.selectedId = null;
    this.marked = new Set();
    this.hover = null;
    new ResizeObserver(() => this.scheduleRender()).observe(wrap);
    canvas.addEventListener('mousemove', e => this._onMove(e));
    canvas.addEventListener('mouseleave', () => { this.hover = null; this.h.onHover?.(null); this.render(); });
    canvas.addEventListener('click', e => {
      const hit = this._hit(e);
      if (hit?.snap) this.h.onClick?.(hit.snap, e);
      else if (hit?.lane) this.h.onLaneClick?.(hit.lane.name);
    });
  }

  /** data: { lanes:[{name, snaps}], now, metric, colorOf(snap), log } */
  setData(data) {
    this.data = data;
    this.scheduleRender();
  }

  setSelected(id) { this.selectedId = id; this.scheduleRender(); }

  setMarked(ids) { this.marked = ids; this.scheduleRender(); }

  scheduleRender() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this.render());
  }

  _x(ts) {
    const { now, tmin, log } = this.d;
    const pw = this.cssW - LABEL_W - PAD_R;
    if (log) {
      const maxAge = Math.max(now - tmin, 3600);
      const age = Math.max(now - ts, 0);
      return LABEL_W + (1 - Math.log1p(age / 3600) / Math.log1p(maxAge / 3600)) * pw;
    }
    return LABEL_W + ((ts - tmin) / Math.max(now - tmin, 1)) * pw;
  }

  render() {
    const data = this.data;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(this.wrap.clientWidth, 500);
    const lanes = data?.lanes ?? [];
    const cssH = AXIS_H + Math.max(lanes.length, 1) * LANE_H + 12;
    this.cssW = cssW;
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const css = getComputedStyle(document.documentElement);
    const text = css.getPropertyValue('--text').trim();
    const muted = css.getPropertyValue('--muted').trim();
    const border = css.getPropertyValue('--border').trim();
    const stripe = css.getPropertyValue('--panel-2').trim();

    if (!data || lanes.length === 0) { this.layout = []; return; }

    let tmin = Infinity, vmax = 0;
    for (const l of lanes) for (const s of l.snaps) {
      if (s.creation != null && s.creation < tmin) tmin = s.creation;
      const v = s[data.metric] ?? 0;
      if (v > vmax) vmax = v;
    }
    if (!isFinite(tmin)) tmin = data.now - 86400;
    this.d = { now: data.now, tmin, log: data.log };

    // axis + grid
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    const ticks = data.log ? this._logTicks() : this._linTicks(tmin, data.now);
    for (const tk of ticks) {
      const x = Math.round(this._x(tk.ts)) + 0.5;
      if (x < LABEL_W - 1 || x > cssW - PAD_R + 1) continue;
      ctx.beginPath(); ctx.moveTo(x, AXIS_H - 6); ctx.lineTo(x, cssH); ctx.stroke();
      ctx.fillStyle = muted;
      ctx.textAlign = 'center';
      ctx.fillText(tk.label, x, AXIS_H / 2 - 2);
    }

    // lanes
    this.layout = [];
    lanes.forEach((lane, i) => {
      const y0 = AXIS_H + i * LANE_H;
      if (i % 2 === 0) { ctx.fillStyle = stripe; ctx.globalAlpha = 0.55; ctx.fillRect(0, y0, cssW, LANE_H); ctx.globalAlpha = 1; }
      ctx.fillStyle = text;
      ctx.textAlign = 'left';
      ctx.fillText(ellipsize(ctx, lane.name, LABEL_W - 16), 8, y0 + LANE_H / 2);
      const cy = y0 + LANE_H / 2;
      const pts = lane.snaps
        .map(s => ({ snap: s, x: this._x(s.creation ?? data.now), r: radius(s[data.metric] ?? 0, vmax) }))
        .sort((a, b) => b.r - a.r);
      for (const p of pts) {
        const c = data.colorOf(p.snap);
        ctx.beginPath();
        ctx.arc(p.x, cy, p.r, 0, Math.PI * 2);
        ctx.fillStyle = rgb(c, 0.78);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgb(c.map(v => v * 0.6));
        ctx.stroke();
        if (this.marked.has(p.snap.id)) {
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = '#ff3b5c';
          ctx.beginPath(); ctx.arc(p.x, cy, p.r + 2, 0, Math.PI * 2); ctx.stroke();
        }
        if (p.snap.id === this.selectedId || p.snap === this.hover) {
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = text;
          ctx.beginPath(); ctx.arc(p.x, cy, p.r + 3, 0, Math.PI * 2); ctx.stroke();
        }
      }
      this.layout.push({ lane, y0, cy, pts });
    });
  }

  _linTicks(tmin, now) {
    const span = now - tmin;
    const out = [];
    const d0 = new Date(tmin * 1000);
    const lang = getLang();
    let step; // in months or days
    if (span > 5 * 365 * 86400) step = { m: 12 };
    else if (span > 2 * 365 * 86400) step = { m: 6 };
    else if (span > 300 * 86400) step = { m: 3 };
    else if (span > 100 * 86400) step = { m: 1 };
    else if (span > 30 * 86400) step = { d: 7 };
    else if (span > 6 * 86400) step = { d: 1 };
    else step = { h: 6 };
    let cur;
    if (step.m) cur = new Date(d0.getFullYear(), Math.floor(d0.getMonth() / step.m) * step.m, 1);
    else if (step.d) cur = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate());
    else cur = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 0);
    for (let guard = 0; guard < 400 && cur.getTime() / 1000 <= now; guard++) {
      const ts = cur.getTime() / 1000;
      if (ts >= tmin) {
        let label;
        if (step.m >= 12) label = String(cur.getFullYear());
        else if (step.m) label = cur.toLocaleDateString(lang, { month: 'short', year: '2-digit' });
        else if (step.d) label = cur.toLocaleDateString(lang, { day: '2-digit', month: '2-digit' });
        else label = cur.toLocaleString(lang, { day: '2-digit', month: '2-digit', hour: '2-digit' });
        out.push({ ts, label });
      }
      if (step.m) cur = new Date(cur.getFullYear(), cur.getMonth() + step.m, 1);
      else if (step.d) cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + step.d);
      else cur = new Date(cur.getTime() + step.h * 3600 * 1000);
    }
    return out;
  }

  _logTicks() {
    const now = this.d.now;
    const ages = [3600, 6 * 3600, 86400, 3 * 86400, 7 * 86400, 30 * 86400, 90 * 86400, 182 * 86400, 365 * 86400, 2 * 365 * 86400, 5 * 365 * 86400];
    return [{ ts: now, label: 'now' }, ...ages.filter(a => now - a >= this.d.tmin).map(a => ({ ts: now - a, label: fmtAge(a) }))];
  }

  _hit(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const row = this.layout?.find(l => y >= l.y0 && y < l.y0 + LANE_H);
    if (!row) return null;
    let best = null, bestD = Infinity;
    for (const p of row.pts) {
      const d = Math.hypot(p.x - x, row.cy - y) - p.r;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best && bestD <= 4) return { snap: best.snap, lane: row.lane };
    return x < LABEL_W ? { lane: row.lane } : null;
  }

  _onMove(e) {
    const hit = this._hit(e);
    const snap = hit?.snap ?? null;
    this.canvas.style.cursor = hit ? 'pointer' : 'default';
    if (snap !== this.hover) { this.hover = snap; this.render(); }
    this.h.onHover?.(snap, e);
  }
}

function radius(v, vmax) {
  if (!vmax || v <= 0) return 1.5;
  return Math.max(1.5, Math.sqrt(v / vmax) * R_MAX);
}

function ellipsize(ctx, s, max) {
  if (ctx.measureText(s).width <= max) return s;
  // keep the end of dataset paths, it is the most specific part
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText('…' + s.slice(s.length - mid)).width <= max) lo = mid; else hi = mid - 1;
  }
  return '…' + s.slice(s.length - lo);
}

/** SVG bar chart of size per creation period. */
export function histogramSvg(snaps, metric, now, colorOfAge, labels) {
  const valid = snaps.filter(s => s.creation != null);
  if (!valid.length) return `<div class="empty">${escapeHtml(labels.empty)}</div>`;
  const tmin = Math.min(...valid.map(s => s.creation));
  const span = now - tmin;
  const lang = getLang();
  let keyOf, labelOf, mid;
  if (span > 150 * 86400) {
    keyOf = ts => { const d = new Date(ts * 1000); return d.getFullYear() * 12 + d.getMonth(); };
    labelOf = k => new Date(Math.floor(k / 12), k % 12, 1).toLocaleDateString(lang, { month: 'short', year: '2-digit' });
    mid = k => new Date(Math.floor(k / 12), k % 12, 15).getTime() / 1000;
  } else if (span > 21 * 86400) {
    keyOf = ts => Math.floor((ts / 86400 + 3) / 7);
    labelOf = k => new Date((k * 7 - 3) * 86400 * 1000).toLocaleDateString(lang, { day: '2-digit', month: '2-digit' });
    mid = k => (k * 7 - 3 + 3.5) * 86400;
  } else {
    keyOf = ts => { const d = new Date(ts * 1000); return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000); };
    labelOf = k => new Date(k * 86400000).toLocaleDateString(lang, { day: '2-digit', month: '2-digit' });
    mid = k => k * 86400 + 43200;
  }
  const buckets = new Map();
  for (const s of valid) {
    const k = keyOf(s.creation);
    const b = buckets.get(k) || { size: 0, count: 0 };
    b.size += s[metric] ?? 0;
    b.count++;
    buckets.set(k, b);
  }
  const k0 = keyOf(tmin), k1 = keyOf(now);
  const keys = [];
  for (let k = k0; k <= k1 && keys.length < 400; k++) keys.push(k);
  const max = Math.max(...keys.map(k => buckets.get(k)?.size ?? 0), 1);
  // Bars live in an SVG stretched to the container width (preserveAspectRatio="none" is fine for rects);
  // text is HTML positioned in percent so it never gets distorted on wide or narrow screens.
  const W = 1000, H = 132;
  const bw = W / keys.length;
  const every = Math.ceil(keys.length / 14);
  let bars = '', xl = '';
  keys.forEach((k, i) => {
    const b = buckets.get(k);
    const x = i * bw;
    if (b && b.size > 0) {
      const h = Math.max(1.5, (b.size / max) * H);
      const c = colorOfAge(now - mid(k));
      bars += `<rect x="${(x + bw * 0.12).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(bw * 0.76, 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${rgb(c)}"><title>${escapeHtml(labelOf(k))}: ${escapeHtml(fmtBytes(b.size))} · ${b.count} snapshots</title></rect>`;
    } else if (b) {
      bars += `<rect x="${(x + bw * 0.12).toFixed(1)}" y="${H - 1.5}" width="${Math.max(bw * 0.76, 1).toFixed(1)}" height="1.5" fill="currentColor" opacity=".35"><title>${escapeHtml(labelOf(k))}: ${b.count} snapshots</title></rect>`;
    }
    if (i % every === 0) xl += `<span style="left:${((x + bw / 2) / W * 100).toFixed(2)}%">${escapeHtml(labelOf(k))}</span>`;
  });
  return `<div class="hist">
    <div class="hist-max">${escapeHtml(fmtBytes(max))}</div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">${bars}
      <line x1="0" x2="${W}" y1="${H}" y2="${H}" stroke="currentColor" opacity=".25" vector-effect="non-scaling-stroke"/></svg>
    <div class="hist-x">${xl}</div>
  </div>`;
}

export function snapTooltip(s, now, t) {
  return `<b>${escapeHtml(s.dataset)}@${escapeHtml(s.name)}</b>
    <div class="tt-grid">
      <span>${t('d_created')}</span><span>${escapeHtml(fmtDate(s.creation))} (${escapeHtml(fmtAge(now - s.creation))})</span>
      <span>${t('d_used')}</span><span>${escapeHtml(fmtBytes(s.used))}</span>
      <span>${t('d_written')}</span><span>${escapeHtml(fmtBytes(s.written))}</span>
      <span>${t('d_referenced')}</span><span>${escapeHtml(fmtBytes(s.referenced))}</span>
    </div>`;
}
