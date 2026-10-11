import { initLang, setLang, getLang, t, applyStatic } from './i18n.js';
import {
  fmtBytes, fmtNum, fmtPct, fmtAge, fmtDate, escapeHtml, schemaOf,
  ageColor, ageGradientCss, paletteColor, rgb, SHARED_COLOR, debounce,
} from './util.js';
import { Treemap } from './treemap.js';
import { Timeline, histogramSvg, snapTooltip } from './timeline.js';

const $ = sel => document.querySelector(sel);

const state = {
  raw: null,           // last JSON from the server
  imported: false,
  snaps: [],           // all snapshots (objects)
  datasets: new Map(), // name -> dataset object (+ snaps, children)
  filtered: [],
  view: 'overview',
  zoom: null,          // dataset name the treemap is zoomed into
  selected: null,      // snapshot id shown in the details panel
  selection: new Set(), // snapshot ids picked for deletion
  caps: { allow_delete: false, delete_supported: false },
  sort: { key: 'used', dir: -1 },
  dsSort: { key: 'usedbysnapshots', dir: -1 },
  now: Date.now() / 1000,
  maxAge: 86400,
  schemaColors: new Map(),
  dsColors: new Map(),
};

const filters = { search: '', dataset: '', age: '', minsize: 0, metric: 'used', color: 'age' };

const HIDE_KEY = 'snapviz.hideSystem';
let hideSystem = true;
try { hideSystem = localStorage.getItem(HIDE_KEY) !== '0'; } catch { /* ignore */ }

/** Glob (`*`, `?`, matched against the full dataset name) -> predicate. */
function excludeMatcher(patterns) {
  if (!patterns?.length) return () => false;
  const esc = s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^(?:' + patterns.map(p => esc(p).replace(/\*/g, '.*').replace(/\?/g, '.')).join('|') + ')$');
  return name => re.test(name);
}

/* ======================= data loading ======================= */

async function load(force = false) {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    const res = await fetch('/api/snapshots' + (force ? '?refresh=1' : ''));
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
    state.imported = false;
    ingest(body);
  } catch (err) {
    showBanner(t('banner_error', { msg: err.message }), 'error', { label: t('retry'), fn: () => load(true) });
    $('#loading').hidden = true;
    if (!state.raw) $('#loading').hidden = true;
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

function ingest(body) {
  state.raw = body;
  state.now = Date.now() / 1000;
  const f = body.snapshot_fields;
  const idx = Object.fromEntries(f.map((k, i) => [k, i]));
  const system = excludeMatcher(body.exclude_patterns);
  const hidden = hideSystem ? system : () => false;
  state.datasets = new Map();
  for (const d of body.datasets) {
    if (hidden(d.name)) continue;
    state.datasets.set(d.name, { ...d, snaps: [], children: [], pool: d.name.split('/')[0] });
  }
  const rows = body.snapshots.filter(r => !hidden(r[idx.dataset]));
  state.systemSnaps = body.snapshots.reduce((n, r) => n + system(r[idx.dataset]), 0);
  state.snaps = rows.map(r => {
    const s = {
      dataset: r[idx.dataset],
      name: r[idx.name],
      creation: r[idx.creation],
      used: r[idx.used],
      referenced: r[idx.referenced],
      written: r[idx.written],
      holds: r[idx.holds] || 0,
    };
    s.id = `${s.dataset}@${s.name}`;
    s.pool = s.dataset.split('/')[0];
    s.age = s.creation != null ? state.now - s.creation : null;
    s.schema = schemaOf(s.name);
    s.lower = s.id.toLowerCase();
    let ds = state.datasets.get(s.dataset);
    if (!ds) {
      ds = { name: s.dataset, snaps: [], children: [], pool: s.pool };
      state.datasets.set(s.dataset, ds);
    }
    ds.snaps.push(s);
    return s;
  });
  for (const ds of state.datasets.values()) {
    const parent = ds.name.includes('/') ? ds.name.slice(0, ds.name.lastIndexOf('/')) : null;
    ds.parent = parent;
    if (parent && state.datasets.has(parent)) state.datasets.get(parent).children.push(ds);
    ds.snapUsed = ds.snaps.reduce((a, s) => a + (s.used || 0), 0);
    ds.shared = ds.usedbysnapshots != null ? Math.max(0, ds.usedbysnapshots - ds.snapUsed) : 0;
  }
  state.maxAge = Math.max(86400 * 2, ...state.snaps.map(s => s.age ?? 0));

  // stable colors: top-level children of each pool get a palette slot
  state.dsColors = new Map();
  let ci = 0;
  for (const ds of [...state.datasets.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const parts = ds.name.split('/');
    const key = parts.slice(0, Math.min(parts.length, 2)).join('/');
    if (!state.dsColors.has(key)) state.dsColors.set(key, paletteColor(ci++));
  }
  const schemaSizes = new Map();
  for (const s of state.snaps) schemaSizes.set(s.schema, (schemaSizes.get(s.schema) || 0) + (s.used || 0));
  state.schemaColors = new Map([...schemaSizes.entries()].sort((a, b) => b[1] - a[1]).map(([k], i) => [k, paletteColor(i)]));

  if (state.zoom && !state.datasets.has(state.zoom)) state.zoom = null;
  const ids = new Set(state.snaps.map(s => s.id));
  state.selection = new Set([...state.selection].filter(id => ids.has(id)));
  if (state.imported) state.selection.clear();

  fillDatasetSelect();
  updateHeader();
  $('#loading').hidden = true;
  applyFilters();
}

function updateHeader() {
  const b = state.raw;
  const badge = $('#source-badge');
  badge.textContent = state.imported ? 'import' : b.source === 'truenas' ? (b.host || 'TrueNAS') : b.source;
  badge.className = 'badge' + (b.source === 'demo' ? ' demo' : '');
  badge.title = state.imported ? '' : b.connection || '';
  $('#fetched-info').textContent = state.imported ? '' : t('fetched', {
    when: new Date(b.fetched_at * 1000).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' }),
    sec: b.duration?.toLocaleString(getLang(), { maximumFractionDigits: 1 }) ?? '–',
  });
  if (state.imported) {
    showBanner(t('banner_import', { n: fmtNum(state.snaps.length) }), 'info', { label: t('banner_back'), fn: () => load() });
  } else if (b.source === 'demo') {
    showBanner(t('banner_demo'), 'info');
  } else if (b.warnings?.length) {
    showBanner(b.warnings.join(' · '), 'info');
  } else {
    hideBanner();
  }
  const patterns = b.exclude_patterns ?? [];
  $('#f-hide-wrap').hidden = !state.systemSnaps;
  $('#f-hide-wrap').title = t('f_hide_system_title', { patterns: patterns.join(', ') });
  $('#f-hide-count').textContent = `(${fmtNum(state.systemSnaps)})`;
}

function showBanner(text, kind, action) {
  const el = $('#banner');
  el.className = 'banner' + (kind === 'error' ? ' error' : '');
  el.textContent = text;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = action.label;
    btn.onclick = action.fn;
    el.append(btn);
  }
  el.hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }

function fillDatasetSelect() {
  const sel = $('#f-dataset');
  const cur = filters.dataset;
  sel.innerHTML = '';
  sel.append(new Option(t('all_datasets'), ''));
  const names = [...state.datasets.keys()].sort();
  for (const n of names) {
    const ds = state.datasets.get(n);
    const total = countSnaps(ds);
    if (!total) continue;
    const depth = n.split('/').length - 1;
    const opt = new Option(`${'\u00a0\u00a0'.repeat(depth)}${depth ? n.slice(n.lastIndexOf('/') + 1) : n}  (${total})`, n);
    sel.append(opt);
  }
  sel.value = state.datasets.has(cur) ? cur : '';
  filters.dataset = sel.value;
}

function countSnaps(ds) {
  return ds.snaps.length + ds.children.reduce((a, c) => a + countSnaps(c), 0);
}

/* ======================= filtering ======================= */

function buildMatcher(q) {
  q = q.trim();
  if (!q) return null;
  const m = q.match(/^\/(.+)\/([i]*)$/);
  if (m) {
    try { const re = new RegExp(m[1], m[2] || 'i'); return s => re.test(s.id); } catch { /* fall through */ }
  }
  const words = q.toLowerCase().split(/\s+/);
  return s => words.every(w => s.lower.includes(w));
}

function applyFilters() {
  const match = buildMatcher(filters.search);
  const ds = filters.dataset;
  let ageTest = null;
  if (filters.age) {
    const [op, d] = filters.age.split(':');
    const sec = +d * 86400;
    ageTest = op === 'lt' ? a => a != null && a < sec : a => a != null && a > sec;
  }
  const minsize = +filters.minsize || 0;
  const metric = filters.metric;
  state.filtered = state.snaps.filter(s =>
    (!ds || s.dataset === ds || s.dataset.startsWith(ds + '/')) &&
    (!ageTest || ageTest(s.age)) &&
    (!minsize || (s[metric] || 0) >= minsize) &&
    (!match || match(s)));
  state.filterActive = !!(match || ageTest || minsize);
  const n = state.filtered.length, total = state.snaps.length;
  $('#filter-summary').textContent = t('count_of', { n: fmtNum(n), total: fmtNum(total) });
  renderView();
  updateSelectionUI();
}

/* ======================= colors ======================= */

function colorOf(s) {
  switch (filters.color) {
    case 'dataset': {
      const parts = s.dataset.split('/');
      return state.dsColors.get(parts.slice(0, Math.min(parts.length, 2)).join('/')) || [128, 128, 128];
    }
    case 'schema': return state.schemaColors.get(s.schema) || [128, 128, 128];
    default: return s.age == null ? [128, 128, 128] : ageColor(s.age, state.maxAge);
  }
}

function legendHtml() {
  if (filters.color === 'age') {
    return `<span>${t('col_age')}:</span><span>0</span><span class="gradient" style="background:${ageGradientCss()}"></span><span>${fmtAge(state.maxAge)}</span>`;
  }
  const map = filters.color === 'schema' ? state.schemaColors : state.dsColors;
  const present = new Map();
  for (const s of state.filtered) {
    const key = filters.color === 'schema' ? s.schema : s.dataset.split('/').slice(0, 2).join('/');
    present.set(key, (present.get(key) || 0) + (s[filters.metric] || 0));
  }
  const top = [...present.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return top.map(([k]) => `<span><span class="swatch" style="background:${rgb(map.get(k) || [128, 128, 128])}"></span>${escapeHtml(k)}</span>`).join('')
    + (present.size > 8 ? `<span>+${present.size - 8} ${t('others')}</span>` : '');
}

/* ======================= views ======================= */

function renderView() {
  for (const v of ['overview', 'treemap', 'timeline', 'datasets', 'snapshots']) {
    $(`#view-${v}`).hidden = v !== state.view || !state.raw;
  }
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  if (location.hash.slice(1) !== state.view) history.replaceState(null, '', '#' + state.view);
  if (!state.raw) return;
  ({ overview: renderOverview, treemap: renderTreemap, timeline: renderTimeline, datasets: renderDatasets, snapshots: renderSnapshots })[state.view]();
}

/* ---------- overview ---------- */

function relevantDatasets() {
  const ds = filters.dataset;
  return [...state.datasets.values()].filter(d => !ds || d.name === ds || d.name.startsWith(ds + '/'));
}

function renderOverview() {
  const snaps = state.filtered;
  const dsets = relevantDatasets();
  const snapSpace = dsets.reduce((a, d) => a + (d.usedbysnapshots || 0), 0);
  const unique = snaps.reduce((a, s) => a + (s.used || 0), 0);
  const sharedTotal = dsets.reduce((a, d) => a + (d.shared || 0), 0);
  const roots = dsets.filter(d => !dsets.some(o => o.name === d.parent));
  const totalUsed = roots.reduce((a, d) => a + (d.used || 0), 0);
  const withSnaps = new Set(snaps.map(s => s.dataset)).size;
  const oldest = snaps.reduce((o, s) => (s.creation != null && (!o || s.creation < o.creation) ? s : o), null);
  const largest = snaps.reduce((o, s) => (!o || (s.used || 0) > (o.used || 0) ? s : o), null);
  const held = snaps.filter(s => s.holds > 0).length;

  const kpi = (label, value, sub, id) => `<div class="kpi"${id ? ` data-snap="${escapeHtml(id)}" style="cursor:pointer"` : ''}><div class="label">${label}</div><div class="value">${value}</div><div class="sub" title="${escapeHtml(sub)}">${escapeHtml(sub)}</div></div>`;
  $('#kpis').innerHTML = [
    kpi(t('k_snapshots'), fmtNum(snaps.length), state.filterActive ? t('count_of', { n: fmtNum(snaps.length), total: fmtNum(state.snaps.length) }) : ''),
    state.filterActive ? '' : kpi(t('k_snapspace'), fmtBytes(snapSpace), totalUsed ? t('k_snapspace_sub', { pct: fmtPct(snapSpace / totalUsed) }) : ''),
    kpi(t('k_unique'), fmtBytes(unique), t('k_unique_sub')),
    state.filterActive ? '' : kpi(t('k_shared'), fmtBytes(sharedTotal), t('k_shared_sub')),
    kpi(t('k_datasets'), fmtNum(withSnaps), t('k_datasets_sub', { n: fmtNum(dsets.length) })),
    oldest ? kpi(t('k_oldest'), fmtAge(oldest.age), oldest.id, oldest.id) : '',
    largest ? kpi(t('k_largest'), fmtBytes(largest.used), largest.id, largest.id) : '',
    held ? kpi(t('k_held'), fmtNum(held), t('k_held_sub')) : '',
  ].join('');

  // age buckets
  const B = [
    ['< 1 d', 86400], ['1–7 d', 7 * 86400], ['7–30 d', 30 * 86400], ['1–3 mo', 91 * 86400],
    ['3–6 mo', 182 * 86400], ['6–12 mo', 365 * 86400], ['1–2 y', 730 * 86400], ['> 2 y', Infinity],
  ];
  const ages = B.map(([label, lim], i) => ({ label, lim, lo: i ? B[i - 1][1] : 0, size: 0, count: 0 }));
  for (const s of snaps) {
    const b = ages.find(b => (s.age ?? 0) < b.lim);
    b.size += s[filters.metric] || 0; b.count++;
  }
  const maxA = Math.max(...ages.map(a => a.size), 1);
  $('#ov-age').innerHTML = `<div class="hbars">${ages.map(a => {
    const c = ageColor(Math.min(a.lo * 1.5 + 3600, state.maxAge), state.maxAge);
    return `<div class="hbar"><span class="hbar-label">${a.label} <span class="muted">· ${fmtNum(a.count)}</span></span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${(a.size / maxA) * 100}%;background:${rgb(c)}"></span></span>
      <span class="hbar-value">${fmtBytes(a.size)}</span></div>`;
  }).join('')}</div>`;

  // datasets by snapshot space (stacked unique/shared of filtered snapshots)
  const perDs = new Map();
  for (const s of snaps) perDs.set(s.dataset, (perDs.get(s.dataset) || 0) + (s[filters.metric] || 0));
  const rows = [...perDs.entries()].map(([name, v]) => {
    const d = state.datasets.get(name);
    const shared = !state.filterActive && filters.metric === 'used' ? d?.shared || 0 : 0;
    return { name, v, shared, tot: v + shared };
  }).sort((a, b) => b.tot - a.tot).slice(0, 12);
  const maxD = Math.max(...rows.map(r => r.tot), 1);
  $('#ov-datasets').innerHTML = rows.length ? `<div class="hbars">${rows.map(r => `
    <div class="hbar clickable" data-ds="${escapeHtml(r.name)}" title="${escapeHtml(r.name)}">
      <span class="hbar-label">${escapeHtml(r.name)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${(r.v / maxD) * 100}%;background:var(--bar-snap)"></span><span class="hbar-fill" style="width:${(r.shared / maxD) * 100}%;background:var(--bar-shared)"></span></span>
      <span class="hbar-value">${fmtBytes(r.tot)}</span></div>`).join('')}</div>
    ${filters.metric === 'used' && !state.filterActive ? `<p class="small muted"><span class="legend-inline" style="color:var(--bar-snap)">■</span> ${t('col_unique')} &nbsp; <span style="color:var(--bar-shared)">■</span> ${t('col_shared')}</p>` : ''}`
    : `<div class="empty">${t('no_data')}</div>`;

  // largest snapshots
  const top = [...snaps].sort((a, b) => (b[filters.metric] || 0) - (a[filters.metric] || 0)).slice(0, 12);
  const maxL = Math.max(...top.map(s => s[filters.metric] || 0), 1);
  $('#ov-largest').innerHTML = top.length ? `<div class="hbars">${top.map(s => `
    <div class="hbar clickable" data-snap="${escapeHtml(s.id)}" title="${escapeHtml(s.id)}">
      <span class="hbar-label">${escapeHtml(s.id)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${((s[filters.metric] || 0) / maxL) * 100}%;background:${rgb(colorOf(s))}"></span></span>
      <span class="hbar-value">${fmtBytes(s[filters.metric])} · ${fmtAge(s.age)}</span></div>`).join('')}</div>`
    : `<div class="empty">${t('no_data')}</div>`;

  // schemas
  const sch = new Map();
  for (const s of snaps) {
    const e = sch.get(s.schema) || { size: 0, count: 0, oldest: Infinity, newest: 0 };
    e.size += s[filters.metric] || 0; e.count++;
    if (s.creation != null) { e.oldest = Math.min(e.oldest, s.creation); e.newest = Math.max(e.newest, s.creation); }
    sch.set(s.schema, e);
  }
  const srows = [...sch.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 12);
  const maxS = Math.max(...srows.map(([, e]) => e.size), 1);
  $('#ov-schemas').innerHTML = srows.length ? `<div class="hbars">${srows.map(([k, e]) => `
    <div class="hbar clickable" data-schema="${escapeHtml(k)}" title="${escapeHtml(k)} · ${fmtAge(state.now - e.newest)} – ${fmtAge(state.now - e.oldest)}">
      <span class="hbar-label">${escapeHtml(k)} <span class="muted">· ${fmtNum(e.count)}</span></span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${(e.size / maxS) * 100}%;background:${rgb(state.schemaColors.get(k) || [128, 128, 128])}"></span></span>
      <span class="hbar-value">${fmtBytes(e.size)}</span></div>`).join('')}</div>`
    : `<div class="empty">${t('no_data')}</div>`;
}

/* ---------- treemap ---------- */

let treemap;

function buildTree() {
  const metric = filters.metric;
  const showShared = $('#tm-shared').checked && metric === 'used' && !state.filterActive;
  const bySet = new Map();
  for (const s of state.filtered) {
    if (!bySet.has(s.dataset)) bySet.set(s.dataset, []);
    bySet.get(s.dataset).push(s);
  }
  const build = ds => {
    const node = { id: 'ds:' + ds.name, label: ds.name.slice(ds.name.lastIndexOf('/') + 1), kind: 'dataset', ref: ds, children: [] };
    for (const c of ds.children) {
      const cn = build(c);
      if (cn.value > 0) node.children.push(cn);
    }
    const snaps = bySet.get(ds.name) || [];
    for (const s of snaps) {
      const v = s[metric] || 0;
      if (v > 0) node.children.push({ id: s.id, label: s.name, value: v, color: colorOf(s), kind: 'snapshot', ref: s, parentDataset: node, sizeLabel: fmtBytes(v) });
    }
    if (showShared && snaps.length && ds.shared > 0) {
      node.children.push({ id: 'shared:' + ds.name, label: t('shared_label'), value: ds.shared, color: SHARED_COLOR, kind: 'shared', ref: ds, parentDataset: node, sizeLabel: fmtBytes(ds.shared) });
    }
    node.value = node.children.reduce((a, c) => a + c.value, 0);
    node.sizeLabel = fmtBytes(node.value);
    // collapse chains like tank > backup > laptops into one header "tank/backup/laptops"
    if (node.children.length === 1 && node.children[0].kind === 'dataset') {
      const only = node.children[0];
      only.label = `${node.label}/${only.label}`;
      return only;
    }
    return node;
  };
  let roots;
  if (state.zoom) roots = [state.datasets.get(state.zoom)];
  else if (filters.dataset) roots = [state.datasets.get(filters.dataset)];
  else roots = [...state.datasets.values()].filter(d => !d.parent || !state.datasets.has(d.parent));
  const children = roots.filter(Boolean).map(build).filter(n => n.value > 0);
  if (children.length === 1) return children[0];
  return { id: 'root', label: '', kind: 'root', children, value: children.reduce((a, c) => a + c.value, 0) };
}

function renderTreemap() {
  if (!treemap) {
    treemap = new Treemap($('#tm-wrap'), $('#tm-canvas'), $('#tm-overlay'), {
      onHover: (node, e) => {
        if (!node) return hideTooltip();
        if (node.kind === 'snapshot') showTooltip(snapTooltip(node.ref, state.now, t), e);
        else if (node.kind === 'shared') showTooltip(`<b>${escapeHtml(node.ref.name)}</b><br>${escapeHtml(t('shared_label'))}: ${fmtBytes(node.value)}`, e);
        else showTooltip(`<b>${escapeHtml(node.ref.name)}</b><br>${fmtBytes(node.value)} · ${t('snapshots_n', { n: fmtNum(countLeaves(node)) })}`, e);
      },
      onClick: (node, e) => {
        if (node.kind === 'snapshot' && (e?.ctrlKey || e?.metaKey || e?.shiftKey)) toggleSelection([node.ref.id]);
        else if (node.kind === 'snapshot') select(node.ref);
        else if (node.kind === 'shared') showSharedDetails(node.ref);
      },
      onZoom: node => { if (node.ref?.name) zoomTo(node.ref.name); },
      onZoomOut: () => {
        if (!state.zoom) return;
        const p = state.datasets.get(state.zoom)?.parent;
        const base = filters.dataset;
        zoomTo(p && (!base || p === base || p.startsWith(base + '/')) && state.datasets.has(p) ? p : null);
      },
    });
  }
  const tree = buildTree();
  const crumbs = [];
  const base = filters.dataset || '';
  crumbs.push(`<a data-zoom="">${escapeHtml(base || t('all_datasets'))}</a>`);
  if (state.zoom && state.zoom !== base) {
    const parts = state.zoom.split('/');
    const start = base ? base.split('/').length : 0;
    for (let i = start; i < parts.length; i++) {
      const name = parts.slice(0, i + 1).join('/');
      crumbs.push(`<span class="sep">›</span><a data-zoom="${escapeHtml(name)}">${escapeHtml(parts[i])}</a>`);
    }
  }
  crumbs.push(`<span class="muted small">&nbsp;· ${fmtBytes(tree.value || 0)}</span>`);
  $('#tm-breadcrumb').innerHTML = crumbs.join('');
  $('#tm-legend').innerHTML = legendHtml();
  $('#tm-shared').disabled = filters.metric !== 'used' || state.filterActive;
  treemap.setData(tree);
  treemap.setSelected(state.selected);
}

function countLeaves(node) {
  if (!node.children) return node.kind === 'snapshot' ? 1 : 0;
  return node.children.reduce((a, c) => a + countLeaves(c), 0);
}

function zoomTo(name) {
  state.zoom = name || null;
  if (state.view !== 'treemap') state.view = 'treemap';
  renderView();
}

/* ---------- timeline ---------- */

let timeline;

function renderTimeline() {
  if (!timeline) {
    timeline = new Timeline($('#tl-wrap'), $('#tl-canvas'), {
      onHover: (s, e) => (s ? showTooltip(snapTooltip(s, state.now, t), e) : hideTooltip()),
      onClick: (s, e) => ((e?.ctrlKey || e?.metaKey || e?.shiftKey) ? toggleSelection([s.id]) : select(s)),
      onLaneClick: name => setDatasetFilter(name),
    });
  }
  const lanes = new Map();
  for (const s of state.filtered) {
    if (!lanes.has(s.dataset)) lanes.set(s.dataset, []);
    lanes.get(s.dataset).push(s);
  }
  const laneArr = [...lanes.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, snaps]) => ({ name, snaps }));
  $('#tl-legend').innerHTML = legendHtml();
  $('#tl-hist').innerHTML = histogramSvg(state.filtered, filters.metric, state.now,
    age => (filters.color === 'age' ? ageColor(age, state.maxAge) : [255, 138, 61]), { empty: t('no_data') });
  timeline.setData({ lanes: laneArr, now: state.now, metric: filters.metric, colorOf, log: $('#tl-log').checked });
  timeline.setSelected(state.selected);
}

/* ---------- datasets table ---------- */

function renderDatasets() {
  const metric = filters.metric;
  const perDs = new Map();
  for (const s of state.filtered) {
    const e = perDs.get(s.dataset) || { count: 0, sum: 0, oldest: Infinity, newest: 0 };
    e.count++; e.sum += s[metric] || 0;
    if (s.creation != null) { e.oldest = Math.min(e.oldest, s.creation); e.newest = Math.max(e.newest, s.creation); }
    perDs.set(s.dataset, e);
  }
  const rows = relevantDatasets()
    .filter(d => perDs.has(d.name) || (!state.filterActive && (d.usedbysnapshots || 0) > 0))
    .map(d => {
      const e = perDs.get(d.name) || { count: 0, sum: 0, oldest: Infinity, newest: 0 };
      return {
        name: d.name, d, count: e.count, sum: e.sum,
        usedbysnapshots: d.usedbysnapshots, shared: d.shared, usedbydataset: d.usedbydataset, used: d.used,
        oldest: isFinite(e.oldest) ? e.oldest : null, newest: e.newest || null,
      };
    });
  const { key, dir } = state.dsSort;
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'string') return dir * va.localeCompare(vb);
    return dir * ((va ?? -Infinity) - (vb ?? -Infinity));
  });
  const cols = [
    ['name', t('col_dataset'), false],
    ['count', t('col_count'), true],
    ['sum', `Σ ${t('m_' + metric)}`, true],
    ['usedbysnapshots', t('col_snapspace'), true],
    ['shared', t('col_shared'), true],
    ['usedbydataset', t('col_data'), true],
    ['ratio', t('col_ratio'), false],
    ['oldest', t('col_oldest'), true],
    ['newest', t('col_newest'), true],
  ];
  const head = `<thead><tr>${cols.map(([k, label, num]) => `<th data-k="${k}" class="${num ? 'num' : ''}">${label}${key === k ? `<span class="arrow">${dir < 0 ? '▼' : '▲'}</span>` : ''}</th>`).join('')}</tr></thead>`;
  const body = rows.map(r => {
    const data = r.usedbydataset || 0, snap = r.usedbysnapshots || 0, tot = data + snap || 1;
    const col = state.dsColors.get(r.name.split('/').slice(0, 2).join('/')) || [128, 128, 128];
    return `<tr class="clickable" data-ds="${escapeHtml(r.name)}">
      <td><span class="ds-name"><span class="dot" style="background:${rgb(col)}"></span>${escapeHtml(r.name)}${r.d.type === 'VOLUME' ? ' <span class="badge">zvol</span>' : ''}</span></td>
      <td class="num">${fmtNum(r.count)}</td>
      <td class="num">${fmtBytes(r.sum)}</td>
      <td class="num">${fmtBytes(r.usedbysnapshots)}</td>
      <td class="num">${fmtBytes(r.shared)}</td>
      <td class="num">${fmtBytes(r.usedbydataset)}</td>
      <td><span class="mini-bar" title="${fmtPct(snap / tot)} snapshots"><span style="width:${(data / tot) * 100}%;background:var(--bar-data)"></span><span style="width:${(snap / tot) * 100}%;background:var(--bar-snap)"></span></span></td>
      <td class="num" title="${escapeHtml(fmtDate(r.oldest))}">${r.oldest ? fmtAge(state.now - r.oldest) : '–'}</td>
      <td class="num" title="${escapeHtml(fmtDate(r.newest))}">${r.newest ? fmtAge(state.now - r.newest) : '–'}</td>
    </tr>`;
  }).join('');
  $('#ds-table').innerHTML = head + `<tbody>${body || `<tr><td colspan="${cols.length}" class="empty">${t('no_data')}</td></tr>`}</tbody>`;
}

/* ---------- snapshots table (virtualised) ---------- */

const ROW_H = 28;
let snRows = [];

function snapCols() {
  return [
    ['dataset', t('col_dataset'), false],
    ['name', t('col_snapshot'), false],
    ['creation', t('col_created'), true],
    ['age', t('col_age'), true],
    ['used', t('col_used'), true],
    ['written', t('col_written'), true],
    ['referenced', t('col_referenced'), true],
    ['holds', t('col_holds'), true],
  ];
}

function renderSnapshots() {
  const { key, dir } = state.sort;
  snRows = [...state.filtered].sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'string' || typeof vb === 'string') return dir * String(va ?? '').localeCompare(String(vb ?? ''));
    return dir * ((va ?? -Infinity) - (vb ?? -Infinity));
  });
  $('#sn-head').innerHTML = `<div class="cb"><input type="checkbox" id="sn-all" aria-label="${escapeHtml(t('d_select'))}"></div>`
    + snapCols().map(([k, label, num]) =>
      `<div data-k="${k}" class="${num ? 'num' : ''}">${label}${key === k ? `<span class="arrow">${dir < 0 ? ' ▼' : ' ▲'}</span>` : ''}</div>`).join('');
  syncSelectAll();
  $('#sn-count').textContent = t('count_of', { n: fmtNum(snRows.length), total: fmtNum(state.snaps.length) });
  $('#sn-spacer').style.height = snRows.length * ROW_H + 'px';
  if (!snRows.length) $('#sn-spacer').innerHTML = `<div class="empty">${t('no_data')}</div>`;
  drawSnapRows(true);
}

function drawSnapRows(force) {
  const body = $('#sn-body');
  const first = Math.max(0, Math.floor(body.scrollTop / ROW_H) - 10);
  const last = Math.min(snRows.length, Math.ceil((body.scrollTop + body.clientHeight) / ROW_H) + 10);
  if (!force && drawSnapRows.range === `${first}-${last}`) return;
  drawSnapRows.range = `${first}-${last}`;
  if (!snRows.length) return;
  let html = '';
  for (let i = first; i < last; i++) {
    const s = snRows[i];
    const picked = state.selection.has(s.id);
    html += `<div class="vrow${s.id === state.selected ? ' selected' : ''}${picked ? ' marked' : ''}" style="top:${i * ROW_H}px" data-i="${i}">
      <div class="cb"><input type="checkbox" data-pick="${i}"${picked ? ' checked' : ''} aria-label="${escapeHtml(t('d_select'))}"></div>
      <div title="${escapeHtml(s.dataset)}">${escapeHtml(s.dataset)}</div>
      <div title="${escapeHtml(s.name)}"><span class="age-dot" style="background:${rgb(colorOf(s))}"></span>${escapeHtml(s.name)}</div>
      <div class="num">${escapeHtml(fmtDate(s.creation))}</div>
      <div class="num">${fmtAge(s.age)}</div>
      <div class="num">${fmtBytes(s.used)}</div>
      <div class="num">${fmtBytes(s.written)}</div>
      <div class="num">${fmtBytes(s.referenced)}</div>
      <div class="num">${s.holds || ''}</div>
    </div>`;
  }
  $('#sn-spacer').innerHTML = html;
}

function exportCsv() {
  const cols = ['dataset', 'name', 'creation_iso', 'age_days', 'used', 'written', 'referenced', 'holds'];
  const q = v => (/[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const lines = [cols.join(',')];
  for (const s of snRows) {
    lines.push([s.dataset, s.name, s.creation != null ? new Date(s.creation * 1000).toISOString() : '',
      s.age != null ? (s.age / 86400).toFixed(2) : '', s.used ?? '', s.written ?? '', s.referenced ?? '', s.holds].map(q).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `snapshots-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ======================= details panel ======================= */

function select(s) {
  state.selected = s.id;
  showDetails(s);
  treemap?.setSelected(s.id);
  timeline?.setSelected(s.id);
  if (state.view === 'snapshots') drawSnapRows(true);
}

/** navigator.clipboard only exists in secure contexts (https/localhost); the app usually runs on http. */
async function copyText(text, pre) {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (!ok && pre) {
    // last resort: select the text so the user can press Ctrl+C
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return ok;
}

function copyBlock(cmd) {
  return `<div class="copy-row"><pre class="code">${escapeHtml(cmd)}</pre><button class="btn" data-copy="${escapeHtml(cmd)}">${t('copy')}</button></div>`;
}

function showDetails(s) {
  const ds = state.datasets.get(s.dataset);
  const neighbours = ds ? [...ds.snaps].sort((a, b) => (a.creation ?? 0) - (b.creation ?? 0)) : [];
  const i = neighbours.indexOf(s);
  const prev = neighbours[i - 1], next = neighbours[i + 1];
  $('#details-body').innerHTML = `
    <h4>${escapeHtml(s.name)}</h4>
    <div class="sub">${escapeHtml(s.dataset)}</div>
    <dl>
      <dt>${t('d_created')}</dt><dd>${escapeHtml(fmtDate(s.creation))}</dd>
      <dt>${t('d_age')}</dt><dd>${fmtAge(s.age)}</dd>
      <dt>${t('d_used')}</dt><dd>${fmtBytes(s.used)}</dd>
      <dt>${t('d_written')}</dt><dd>${fmtBytes(s.written)}</dd>
      <dt>${t('d_referenced')}</dt><dd>${fmtBytes(s.referenced)}</dd>
      ${s.holds ? `<dt>${t('d_holds')}</dt><dd>${s.holds}</dd>` : ''}
      ${ds?.usedbysnapshots != null ? `<dt>${t('col_snapspace')}</dt><dd>${fmtBytes(ds.usedbysnapshots)} (${t('snapshots_n', { n: ds.snaps.length })})</dd>` : ''}
    </dl>
    <p class="note">${t('d_used_note')}</p>
    <div class="small muted">${t('d_cmd_list')}</div>
    ${copyBlock(`zfs list -t snapshot -o name,used,written,refer,creation -s creation -r ${s.dataset}`)}
    <div class="small muted">${t('d_cmd_destroy')}</div>
    ${copyBlock(`zfs destroy -nv ${s.id}`)}
    ${prev && next ? copyBlock(`zfs destroy -nv ${s.dataset}@${prev.name}%${next.name}`) : ''}
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn" data-show-ds="${escapeHtml(s.dataset)}">${t('d_show_ds')}</button>
      <button class="btn" data-zoom-ds="${escapeHtml(s.dataset)}">${t('d_zoom')}</button>
      <button class="btn" data-pick-id="${escapeHtml(s.id)}">${state.selection.has(s.id) ? t('d_unselect') : t('d_select')}</button>
      ${deleteBlockedReason() ? '' : `<button class="btn btn-danger" data-delete-id="${escapeHtml(s.id)}">${t('d_delete')}</button>`}
    </div>`;
  $('#details').hidden = false;
}

function showSharedDetails(ds) {
  $('#details-body').innerHTML = `
    <h4>${escapeHtml(t('shared_label'))}</h4>
    <div class="sub">${escapeHtml(ds.name)}</div>
    <dl>
      <dt>${t('col_shared')}</dt><dd>${fmtBytes(ds.shared)}</dd>
      <dt>${t('col_snapspace')}</dt><dd>${fmtBytes(ds.usedbysnapshots)}</dd>
      <dt>${t('col_unique')}</dt><dd>${fmtBytes(ds.snapUsed)}</dd>
    </dl>
    <p class="note">${t('shared_desc')}</p>
    ${ds.snaps.length > 1 ? copyBlock(`zfs destroy -nv ${ds.name}@${oldestOf(ds).name}%${newestOf(ds).name}`) : ''}`;
  $('#details').hidden = false;
}

const oldestOf = ds => ds.snaps.reduce((o, s) => ((s.creation ?? 0) < (o.creation ?? 0) ? s : o));
const newestOf = ds => ds.snaps.reduce((o, s) => ((s.creation ?? 0) > (o.creation ?? 0) ? s : o));

/* ======================= tooltip ======================= */

function showTooltip(html, e) {
  const tt = $('#tooltip');
  tt.innerHTML = html;
  tt.hidden = false;
  const pad = 14;
  const r = tt.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  tt.style.left = Math.max(4, x) + 'px';
  tt.style.top = Math.max(4, y) + 'px';
}
function hideTooltip() { $('#tooltip').hidden = true; }

/* ======================= selection & deleting ======================= */

function deleteBlockedReason() {
  if (state.imported) return t('del_imported');
  if (!state.caps.delete_supported) return t('del_unsupported');
  if (!state.caps.allow_delete) return t('del_disabled');
  return null;
}

function setSelection(next) {
  state.selection = next;
  updateSelectionUI();
}

function toggleSelection(ids) {
  const next = new Set(state.selection);
  for (const id of ids) next.has(id) ? next.delete(id) : next.add(id);
  setSelection(next);
}

function syncSelectAll() {
  const all = $('#sn-all');
  if (!all) return;
  const n = snRows.filter(s => state.selection.has(s.id)).length;
  all.checked = n > 0 && n === snRows.length;
  all.indeterminate = n > 0 && n < snRows.length;
}

function closeEditMenu() {
  $('#edit-list').hidden = true;
  $('#btn-edit').setAttribute('aria-expanded', 'false');
}

function updateSelectionUI() {
  const n = state.selection.size;
  const byId = new Map(state.snaps.map(s => [s.id, s]));
  const size = [...state.selection].reduce((a, id) => a + (byId.get(id)?.used || 0), 0);
  const blocked = deleteBlockedReason();

  $('#mi-select').textContent = t('sel_filtered', { n: fmtNum(state.filtered.length) });
  $('#mi-select').disabled = !state.filtered.length || state.imported;
  $('#mi-clear').textContent = t('sel_clear');
  $('#mi-clear').disabled = !n;
  $('#mi-delete').textContent = t('sel_delete', { n: fmtNum(n) });
  $('#mi-delete').disabled = !n || !!blocked;
  $('#edit-note').textContent = blocked || (n ? '' : t('sel_hint'));

  $('#selbar').hidden = !n;
  $('#sel-info').textContent = t('sel_info', { n: fmtNum(n), size: fmtBytes(size) });
  $('#selbar-delete').disabled = !!blocked;
  $('#selbar-delete').title = blocked || '';

  treemap?.setMarked(state.selection);
  timeline?.setMarked(state.selection);
  if (state.view === 'snapshots') { drawSnapRows(true); syncSelectAll(); }
}

const deleteState = { ids: [], running: false, done: false };

function openDeleteDialog(ids) {
  if (deleteBlockedReason()) return;
  const byId = new Map(state.snaps.map(s => [s.id, s]));
  const snaps = ids.map(id => byId.get(id)).filter(Boolean);
  const held = snaps.filter(s => s.holds > 0);
  const todo = snaps.filter(s => !(s.holds > 0));
  const newest = todo.filter(s => {
    const ds = state.datasets.get(s.dataset);
    return ds && ds.snaps.every(o => (o.creation ?? 0) <= (s.creation ?? 0));
  });
  Object.assign(deleteState, { ids: todo.map(s => s.id), running: false, done: false });

  $('#del-title').textContent = todo.length === 1 ? t('del_title_one') : t('del_title', { n: fmtNum(todo.length) });
  $('#del-summary').textContent = todo.length
    ? t('del_summary', { size: fmtBytes(todo.reduce((a, s) => a + (s.used || 0), 0)) })
    : t('del_none');
  const shown = snaps.slice(0, 200);
  $('#del-list').innerHTML = shown.map(s =>
    `<li data-id="${escapeHtml(s.id)}" class="${s.holds > 0 ? 'skip' : ''}">${escapeHtml(s.id)} <span class="muted">· ${fmtBytes(s.used)} · ${fmtAge(s.age)}</span></li>`).join('')
    + (snaps.length > shown.length ? `<li class="muted">${escapeHtml(t('del_more', { n: fmtNum(snaps.length - shown.length) }))}</li>` : '');
  $('#del-warnings').innerHTML = [
    held.length ? `<div class="del-warn">${escapeHtml(t('del_held', { n: held.length }))}</div>` : '',
    newest.length ? `<div class="del-warn">${escapeHtml(t('del_newest', { n: newest.length }))}</div>` : '',
  ].join('');
  $('#del-confirm-wrap').hidden = !todo.length;
  $('#del-confirm-label').textContent = t('del_confirm', { n: todo.length });
  $('#del-confirm').value = '';
  $('#del-confirm').disabled = false;
  $('#del-result').textContent = '';
  $('#del-go').hidden = !todo.length;
  $('#del-go').disabled = true;
  $('#del-go').textContent = t('del_go');
  $('#del-cancel').textContent = t('cancel');
  $('#del-cancel').disabled = false;
  $('#delete-dialog').showModal();
  if (todo.length) $('#del-confirm').focus();
}

async function runDelete() {
  if (deleteState.running || deleteState.done || !deleteState.ids.length) return;
  deleteState.running = true;
  $('#del-go').disabled = true;
  $('#del-confirm').disabled = true;
  $('#del-cancel').disabled = true;
  $('#del-result').textContent = t('del_running');
  let body;
  try {
    const res = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Snapviz-Action': 'delete' },
      body: JSON.stringify({ snapshots: deleteState.ids }),
    });
    body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
  } catch (err) {
    $('#del-result').textContent = err.message;
    deleteState.running = false;
    $('#del-cancel').disabled = false;
    $('#del-confirm').disabled = false;
    return;
  }
  const next = new Set(state.selection);
  for (const r of body.results) {
    const li = document.querySelector(`#del-list li[data-id="${CSS.escape(r.id)}"]`);
    if (li) {
      li.className = r.ok ? 'done' : 'failed';
      if (!r.ok && r.error) li.insertAdjacentHTML('beforeend', ` <span>– ${escapeHtml(r.error)}</span>`);
    }
    if (r.ok) next.delete(r.id);
  }
  deleteState.running = false;
  deleteState.done = true;
  $('#del-result').textContent = t('del_done', { ok: fmtNum(body.deleted), failed: fmtNum(body.failed) });
  $('#del-go').hidden = true;
  $('#del-cancel').textContent = t('close');
  $('#del-cancel').disabled = false;
  if (body.results.some(r => r.ok && r.id === state.selected)) {
    $('#details').hidden = true;
    state.selected = null;
  }
  setSelection(next);
  load(true);
}

/* ======================= wiring ======================= */

function setDatasetFilter(name) {
  filters.dataset = name || '';
  $('#f-dataset').value = filters.dataset;
  state.zoom = null;
  applyFilters();
}

function importCommands() {
  return 'zfs list -Hp -t filesystem,volume -o name,type,used,usedbysnapshots,usedbydataset,usedbychildren,available,referenced > zfs.txt\n'
    + 'zfs list -Hp -t snapshot -o name,used,referenced,written,creation,userrefs >> zfs.txt';
}

function init() {
  initLang();
  $('#lang-select').value = getLang();
  applyStatic();

  const VIEWS = ['overview', 'treemap', 'timeline', 'datasets', 'snapshots'];
  const fromHash = () => {
    const v = location.hash.slice(1);
    if (VIEWS.includes(v) && v !== state.view) { state.view = v; renderView(); }
  };
  if (VIEWS.includes(location.hash.slice(1))) state.view = location.hash.slice(1);
  window.addEventListener('hashchange', fromHash);
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    renderView();
  }));

  const readFilters = () => {
    filters.search = $('#f-search').value;
    filters.age = $('#f-age').value;
    filters.minsize = $('#f-minsize').value;
    filters.metric = $('#f-metric').value;
    filters.color = $('#f-color').value;
  };
  // browsers restore <select> values on reload; adopt them so the UI and the applied filters agree
  readFilters();
  const onFilter = () => { readFilters(); applyFilters(); };
  $('#f-search').addEventListener('input', debounce(onFilter, 200));
  for (const id of ['#f-age', '#f-minsize', '#f-metric', '#f-color']) $(id).addEventListener('change', onFilter);
  $('#f-dataset').addEventListener('change', e => setDatasetFilter(e.target.value));
  $('#f-reset').addEventListener('click', () => {
    $('#f-search').value = ''; $('#f-age').value = ''; $('#f-minsize').value = '0';
    $('#f-metric').value = 'used'; $('#f-color').value = 'age';
    filters.dataset = ''; $('#f-dataset').value = '';
    state.zoom = null;
    onFilter();
  });
  $('#tm-shared').addEventListener('change', () => renderView());
  $('#tl-log').addEventListener('change', () => renderView());
  $('#f-hide-system').checked = hideSystem;
  $('#f-hide-system').addEventListener('change', e => {
    hideSystem = e.target.checked;
    try { localStorage.setItem(HIDE_KEY, hideSystem ? '1' : '0'); } catch { /* ignore */ }
    if (state.raw) ingest(state.raw);
  });

  $('#btn-refresh').addEventListener('click', () => load(true));
  $('#lang-select').addEventListener('change', e => {
    setLang(e.target.value);
    if (state.raw) { fillDatasetSelect(); updateHeader(); applyFilters(); }
  });

  // delegated clicks
  document.addEventListener('click', e => {
    if (e.target.closest('.vrow .cb, .vhead .cb')) return; // checkboxes are handled on 'change'
    const tgt = e.target.closest('[data-snap],[data-ds],[data-schema],[data-copy],[data-show-ds],[data-zoom-ds],[data-zoom],[data-k],[data-i],[data-act],[data-pick-id],[data-delete-id]');
    if (!tgt) return;
    if (tgt.dataset.act) {
      closeEditMenu();
      if (tgt.dataset.act === 'select-filtered') setSelection(new Set([...state.selection, ...state.filtered.map(s => s.id)]));
      else if (tgt.dataset.act === 'clear') setSelection(new Set());
      else if (tgt.dataset.act === 'delete') openDeleteDialog([...state.selection]);
    } else if (tgt.dataset.pickId != null) {
      toggleSelection([tgt.dataset.pickId]);
      tgt.textContent = state.selection.has(tgt.dataset.pickId) ? t('d_unselect') : t('d_select');
    } else if (tgt.dataset.deleteId != null) {
      openDeleteDialog([tgt.dataset.deleteId]);
    } else if (tgt.dataset.copy != null) {
      copyText(tgt.dataset.copy, tgt.previousElementSibling).then(ok => {
        tgt.textContent = ok ? t('copied') : t('copy_manual');
        setTimeout(() => { tgt.textContent = t('copy'); }, ok ? 1200 : 3000);
      });
    } else if (tgt.dataset.snap != null) {
      const s = state.snaps.find(x => x.id === tgt.dataset.snap);
      if (s) select(s);
    } else if (tgt.dataset.ds != null && tgt.closest('#ds-table, #ov-datasets')) {
      setDatasetFilter(tgt.dataset.ds);
      state.view = 'snapshots';
      renderView();
    } else if (tgt.dataset.schema != null) {
      const sch = tgt.dataset.schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/‹date›/g, '.+').replace(/#/g, '\\d+');
      $('#f-search').value = `/@${sch}$/`;
      filters.search = $('#f-search').value;
      state.view = 'snapshots';
      applyFilters();
    } else if (tgt.dataset.showDs != null) {
      setDatasetFilter(tgt.dataset.showDs);
      state.view = 'snapshots';
      renderView();
    } else if (tgt.dataset.zoomDs != null) {
      zoomTo(tgt.dataset.zoomDs);
    } else if (tgt.dataset.zoom != null) {
      zoomTo(tgt.dataset.zoom || null);
    } else if (tgt.dataset.k && tgt.closest('#ds-table')) {
      const k = tgt.dataset.k;
      if (k === 'ratio') return;
      state.dsSort = { key: k, dir: state.dsSort.key === k ? -state.dsSort.dir : (k === 'name' ? 1 : -1) };
      renderDatasets();
    } else if (tgt.dataset.k && tgt.closest('#sn-head')) {
      const k = tgt.dataset.k;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === 'dataset' || k === 'name' ? 1 : -1) };
      renderSnapshots();
    } else if (tgt.dataset.i != null && tgt.closest('#sn-body')) {
      select(snRows[+tgt.dataset.i]);
    }
  });

  $('#sn-body').addEventListener('scroll', () => drawSnapRows(false), { passive: true });
  new ResizeObserver(() => state.view === 'snapshots' && drawSnapRows(true)).observe($('#sn-body'));
  $('#sn-export').addEventListener('click', exportCsv);
  $('#details-close').addEventListener('click', () => {
    $('#details').hidden = true;
    state.selected = null;
    treemap?.setSelected(null);
    timeline?.setSelected(null);
    if (state.view === 'snapshots') drawSnapRows(true);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#details-close').click(); });

  // import dialog
  const dlg = $('#import-dialog');
  $('#import-cmds').textContent = importCommands();
  $('#btn-import').addEventListener('click', () => dlg.showModal());
  $('#import-go').addEventListener('click', async e => {
    e.preventDefault();
    const file = $('#import-file').files[0];
    const text = file ? await file.text() : $('#import-text').value;
    if (!text.trim()) return;
    try {
      const res = await fetch('/api/import', { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain' } });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
      dlg.close();
      state.imported = true;
      ingest(body);
    } catch (err) {
      alert(err.message);
    }
  });

  fetch('/api/status').then(r => r.json()).then(st => {
    $('#btn-import').hidden = !st.allow_import;
    state.caps = { allow_delete: !!st.allow_delete, delete_supported: !!st.delete_supported };
    updateSelectionUI();
  }).catch(() => {});

  // edit menu
  $('#btn-edit').addEventListener('click', e => {
    e.stopPropagation();
    const list = $('#edit-list');
    if (list.hidden) { updateSelectionUI(); list.hidden = false; $('#btn-edit').setAttribute('aria-expanded', 'true'); }
    else closeEditMenu();
  });
  document.addEventListener('click', e => { if (!e.target.closest('#edit-menu')) closeEditMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeEditMenu(); });

  // table checkboxes
  document.addEventListener('change', e => {
    if (e.target.id === 'sn-all') {
      const next = new Set(state.selection);
      for (const s of snRows) e.target.checked ? next.add(s.id) : next.delete(s.id);
      setSelection(next);
    } else if (e.target.dataset.pick != null) {
      toggleSelection([snRows[+e.target.dataset.pick].id]);
    }
  });

  // delete dialog
  $('#del-confirm').addEventListener('input', () => {
    $('#del-go').disabled = $('#del-confirm').value.trim() !== String(deleteState.ids.length);
  });
  $('#del-go').addEventListener('click', e => { e.preventDefault(); runDelete(); });
  updateSelectionUI();
  load(false);
}

init();
