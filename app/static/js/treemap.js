// Squarified cushion treemap (van Wijk & van de Wetering), the look known from WinDirStat.

const LIGHT = (() => { const l = Math.hypot(-1, -1, 10); return [-1 / l, -1 / l, 10 / l]; })();
const AMBIENT = 0.16;
const H0 = 0.4;       // ridge height of the top level
const F = 0.88;       // height scale factor per level
const HEADER = 16;    // dataset label strip height in CSS px

/**
 * Node shape: { id, label, value, color:[r,g,b], kind:'dataset'|'snapshot'|'shared', children?:Node[], ref }
 */
export class Treemap {
  constructor(wrap, canvas, overlay, handlers = {}) {
    this.wrap = wrap;
    this.canvas = canvas;
    this.overlay = overlay;
    this.h = handlers;
    this.root = null;
    this.leaves = [];
    this.groups = [];
    this.hover = null;
    this.selectedId = null;
    this.marked = new Set();
    this._pending = 0;

    new ResizeObserver(() => this.scheduleRender()).observe(wrap);
    overlay.addEventListener('mousemove', e => this._onMove(e));
    overlay.addEventListener('mouseleave', () => { this._setHover(null); this.h.onHover?.(null); });
    overlay.addEventListener('click', e => this._onClick(e));
    overlay.addEventListener('dblclick', e => this._onDblClick(e));
    overlay.addEventListener('contextmenu', e => { e.preventDefault(); this.h.onZoomOut?.(); });
  }

  setData(root) {
    this.root = root;
    this.scheduleRender();
  }

  setSelected(id) {
    this.selectedId = id;
    this._drawOverlay();
  }

  /** ids of snapshots picked for deletion */
  setMarked(ids) {
    this.marked = ids;
    this._drawOverlay();
  }

  scheduleRender() {
    cancelAnimationFrame(this._pending);
    this._pending = requestAnimationFrame(() => this.render());
  }

  render() {
    const rect = this.wrap.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(rect.width * dpr);
    const H = Math.round(rect.height * dpr);
    for (const c of [this.canvas, this.overlay]) {
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    }
    this.dpr = dpr;
    this.leaves = [];
    this.groups = [];

    const ctx = this.canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    // background stays black (gaps between groups)
    const data = img.data;
    for (let i = 3; i < data.length; i += 4) data[i] = 255;

    if (this.root && this.root.value > 0) {
      this._layout(this.root, 0, 0, W, H, H0, [0, 0, 0, 0], 0, data, W);
    }
    ctx.putImageData(img, 0, 0);
    this._drawLabels(ctx);
    this._drawOverlay();
  }

  // ---- layout + cushion rendering (all coordinates in device pixels) ----

  _layout(node, x, y, w, h, height, surface, depth, data, W) {
    const s = surface.slice();
    addRidge(x, x + w, height, s, 0);
    addRidge(y, y + h, height, s, 2);

    const kids = node.children;
    if (!kids || kids.length === 0) {
      this.leaves.push({ node, x, y, w, h });
      renderCushion(data, W, x, y, w, h, s, node.color);
      return;
    }

    let ix = x, iy = y, iw = w, ih = h;
    let header = 0;
    if (depth > 0) {
      const hdr = HEADER * this.dpr;
      if (w > 70 * this.dpr && h > 40 * this.dpr) header = hdr;
      const pad = w > 6 && h > 6 ? Math.max(1, Math.round(this.dpr)) : 0;
      ix += pad; iy += pad + header; iw -= 2 * pad; ih -= 2 * pad + header;
      this.groups.push({ node, x, y, w, h, header });
    }
    if (iw <= 0 || ih <= 0) return;

    const items = kids.filter(k => k.value > 0).sort((a, b) => b.value - a.value);
    const rects = squarify(items.map(k => k.value), ix, iy, iw, ih);
    for (let i = 0; i < items.length; i++) {
      const r = rects[i];
      if (r.w < 0.5 || r.h < 0.5) {
        // too small to draw, but keep for hit testing of huge lists
        continue;
      }
      this._layout(items[i], r.x, r.y, r.w, r.h, height * F, s, depth + 1, data, W);
    }
  }

  _drawLabels(ctx) {
    const dpr = this.dpr;
    ctx.save();
    ctx.textBaseline = 'middle';
    // dataset headers
    for (const g of this.groups) {
      if (!g.header) continue;
      ctx.fillStyle = 'rgba(18,22,26,0.88)';
      ctx.fillRect(g.x, g.y, g.w, g.header + 1);
      ctx.fillStyle = '#e8edf2';
      ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
      const label = `${g.node.label}  ·  ${g.node.sizeLabel ?? ''}`;
      ctx.fillText(fit(ctx, label, g.w - 8 * dpr), g.x + 4 * dpr, g.y + g.header / 2 + 0.5);
    }
    // large leaves get their name
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,0.75)';
    ctx.shadowBlur = 3 * dpr;
    for (const l of this.leaves) {
      if (l.w < 70 * dpr || l.h < 20 * dpr) continue;
      ctx.fillStyle = '#fff';
      const cy = l.y + l.h / 2;
      if (l.h > 36 * dpr && l.node.sizeLabel) {
        ctx.fillText(fit(ctx, l.node.label, l.w - 10 * dpr), l.x + 5 * dpr, cy - 7 * dpr);
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillText(fit(ctx, l.node.sizeLabel, l.w - 10 * dpr), l.x + 5 * dpr, cy + 7 * dpr);
      } else {
        ctx.fillText(fit(ctx, l.node.label, l.w - 10 * dpr), l.x + 5 * dpr, cy);
      }
    }
    ctx.restore();
  }

  _drawOverlay() {
    const ctx = this.overlay.getContext('2d');
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const dpr = this.dpr || 1;
    if (this.marked.size) {
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = '#ff3b5c';
      ctx.fillStyle = 'rgba(255,59,92,0.28)';
      for (const l of this.leaves) {
        if (!this.marked.has(l.node.id)) continue;
        ctx.fillRect(l.x, l.y, l.w, l.h);
        if (l.w > 4 * dpr && l.h > 4 * dpr) ctx.strokeRect(l.x + dpr, l.y + dpr, l.w - 2 * dpr, l.h - 2 * dpr);
      }
    }
    const sel = this.selectedId && this.leaves.find(l => l.node.id === this.selectedId);
    if (sel) {
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(sel.x + 1.5 * dpr, sel.y + 1.5 * dpr, Math.max(sel.w - 3 * dpr, 1), Math.max(sel.h - 3 * dpr, 1));
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = '#000';
      ctx.strokeRect(sel.x + 3.5 * dpr, sel.y + 3.5 * dpr, Math.max(sel.w - 7 * dpr, 1), Math.max(sel.h - 7 * dpr, 1));
    }
    const hv = this.hover;
    if (hv) {
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = hv.isGroup ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.95)';
      if (hv.isGroup) ctx.setLineDash([5 * dpr, 3 * dpr]);
      ctx.strokeRect(hv.x + dpr, hv.y + dpr, Math.max(hv.w - 2 * dpr, 1), Math.max(hv.h - 2 * dpr, 1));
      ctx.setLineDash([]);
    }
  }

  // ---- interaction ----

  _hit(e) {
    const r = this.overlay.getBoundingClientRect();
    const x = (e.clientX - r.left) * this.dpr;
    const y = (e.clientY - r.top) * this.dpr;
    for (let i = this.groups.length - 1; i >= 0; i--) {
      const g = this.groups[i];
      if (g.header && x >= g.x && x < g.x + g.w && y >= g.y && y < g.y + g.header) return { ...g, isGroup: true };
    }
    for (let i = this.leaves.length - 1; i >= 0; i--) {
      const l = this.leaves[i];
      if (x >= l.x && x < l.x + l.w && y >= l.y && y < l.y + l.h) return { ...l, isGroup: false };
    }
    return null;
  }

  _groupAt(e) {
    const r = this.overlay.getBoundingClientRect();
    const x = (e.clientX - r.left) * this.dpr;
    const y = (e.clientY - r.top) * this.dpr;
    // innermost dataset group containing the point
    for (let i = this.groups.length - 1; i >= 0; i--) {
      const g = this.groups[i];
      if (x >= g.x && x < g.x + g.w && y >= g.y && y < g.y + g.h) return g;
    }
    return null;
  }

  _setHover(hit) {
    const prev = this.hover;
    if (prev?.node === hit?.node) return;
    this.hover = hit;
    this._drawOverlay();
  }

  _onMove(e) {
    const hit = this._hit(e);
    this._setHover(hit);
    this.h.onHover?.(hit ? hit.node : null, e);
  }

  _onClick(e) {
    const hit = this._hit(e);
    if (!hit) return;
    if (hit.isGroup) this.h.onZoom?.(hit.node);
    else this.h.onClick?.(hit.node, e);
  }

  _onDblClick(e) {
    const hit = this._hit(e);
    if (hit?.isGroup) return;
    // zoom into the dataset that contains the leaf
    const leaf = hit?.node;
    if (leaf?.parentDataset) this.h.onZoom?.(leaf.parentDataset);
    else {
      const g = this._groupAt(e);
      if (g) this.h.onZoom?.(g.node);
    }
  }
}

function addRidge(a, b, h, s, off) {
  const d = b - a;
  if (d <= 0) return;
  s[off + 1] += (4 * h * (b + a)) / d;
  s[off] -= (4 * h) / d;
}

function renderCushion(data, W, x, y, w, h, s, color) {
  const x0 = Math.round(x), x1 = Math.round(x + w);
  const y0 = Math.round(y), y1 = Math.round(y + h);
  if (x1 <= x0 || y1 <= y0) return;
  const [lx, ly, lz] = LIGHT;
  const [cr, cg, cb] = color;
  const sx2 = s[0], sx1 = s[1], sy2 = s[2], sy1 = s[3];
  const diffuse = 1 - AMBIENT;
  for (let py = y0; py < y1; py++) {
    const yc = py + 0.5;
    const ny = -(2 * sy2 * yc + sy1);
    let idx = (py * W + x0) * 4;
    for (let px = x0; px < x1; px++) {
      const xc = px + 0.5;
      const nx = -(2 * sx2 * xc + sx1);
      let cos = (nx * lx + ny * ly + lz) / Math.sqrt(nx * nx + ny * ny + 1);
      if (cos < 0) cos = 0;
      const k = (AMBIENT + diffuse * cos) * 1.18;
      data[idx] = cr * k > 255 ? 255 : cr * k;
      data[idx + 1] = cg * k > 255 ? 255 : cg * k;
      data[idx + 2] = cb * k > 255 ? 255 : cb * k;
      idx += 4;
    }
  }
}

/** Squarified layout. values must be sorted descending. Returns rects in the same order. */
export function squarify(values, x, y, w, h) {
  const out = new Array(values.length);
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => ({ x, y, w: 0, h: 0 }));
  const scale = (w * h) / total;
  let i = 0;
  while (i < values.length) {
    const short = Math.min(w, h);
    if (short <= 0) {
      for (; i < values.length; i++) out[i] = { x, y, w: 0, h: 0 };
      break;
    }
    // grow the row while the worst aspect ratio improves
    let j = i;
    let sum = 0, min = Infinity, max = 0;
    let worst = Infinity;
    while (j < values.length) {
      const a = values[j] * scale;
      const nsum = sum + a;
      const nmin = Math.min(min, a), nmax = Math.max(max, a);
      const s2 = short * short;
      const nworst = Math.max((s2 * nmax) / (nsum * nsum), (nsum * nsum) / (s2 * nmin));
      if (j > i && nworst > worst) break;
      sum = nsum; min = nmin; max = nmax; worst = nworst; j++;
    }
    // lay out values[i..j) along the short side
    const thick = sum / short;
    let off = 0;
    for (let k = i; k < j; k++) {
      const len = (values[k] * scale) / thick;
      out[k] = w >= h
        ? { x, y: y + off, w: thick, h: len }
        : { x: x + off, y, w: len, h: thick };
      off += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    i = j;
  }
  return out;
}

function fit(ctx, text, maxW) {
  if (maxW <= 0) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '';
}
