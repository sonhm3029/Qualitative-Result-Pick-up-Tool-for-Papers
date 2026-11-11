'use strict';
/* ---------------------------------------------------------------- utils */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return e;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const raf = fn => { let p = false; return (...a) => { if (p) return; p = true; requestAnimationFrame(() => { p = false; fn(...a); }); }; };

const ROI_COLORS = ['#ff2a2a', '#ffd400', '#2bd96b'];

/* ---------------------------------------------------------------- app */
const App = {
  meta: null,
  data: {},          // dataset name -> dataset json
  ds: null,          // current dataset name
  D: null,           // current dataset json
  picks: [],         // [{ds,image,rois:[{x,y,w,h}],note}]
  rejected: [],      // ["ds/image"]
  roiMemory: {},     // "ds/image" -> rois (not persisted)
  figure: null,
  ui: null,
  views: {},
  list: [],          // filtered+sorted image indices for current dataset
  analysis: null,
  _imgCache: new Map(),
};

const DEFAULT_UI = {
  ds: null, comparators: null, scoreMetrics: null, reqMetrics: [], K: 1, minWins: 0,
  sortKey: 'comp', sortDir: 'desc', onlyPicked: false, hideRejected: true, search: '',
  cmpMetric: 'LPIPS', tile: 250, smooth: 'smooth', sortTiles: false, diff: false, diffGain: 4,
  overviewMethod: null, aspect: 1, suggestWin: 96, suggestTexture: 12, suggestMode: 'best',
};
const DEFAULT_FIG = {
  order: null, hidden: [], labels: {}, tile: 512, gap: 4, inset: 0.42, lw: 3, font: 'Times New Roman',
  fontSize: 30, boldOurs: true, scale: 1, insetSmooth: 'smooth', lrSmooth: 'smooth', corner: 'auto',
  showMetric: 'none', draftName: false, oursSuffix: ' (Ours)',
  layout: 'strip', gridCols: 0, thickMul: 2, cropFrame: true, pieceCrop: 512,
};

/* ---------------------------------------------------------------- API */
App.api = {
  async get(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' -> ' + r.status); return r.json(); },
  async post(url, body, raw) {
    const r = await fetch(url, { method: 'POST', body: raw ? body : JSON.stringify(body) });
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    return r.json();
  },
};
App.imgURL = (ds, method, name) => `/img/${encodeURIComponent(ds)}/${encodeURIComponent(method)}/${encodeURIComponent(name)}`;
App.thumbURL = (ds, method, name, w = 160) => `/thumb/${encodeURIComponent(ds)}/${encodeURIComponent(method)}/${encodeURIComponent(name)}?w=${w}`;

App.loadImage = function (ds, method, name) {
  const url = App.imgURL(ds, method, name);
  const c = App._imgCache;
  if (c.has(url)) { const p = c.get(url); c.delete(url); c.set(url, p); return p; }
  const p = new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => { c.delete(url); rej(new Error('failed ' + url)); };
    im.src = url;
  });
  c.set(url, p);
  while (c.size > 260) c.delete(c.keys().next().value);
  return p;
};

/* ---------------------------------------------------------------- formatting */
App.fmt = function (metric, v) {
  if (v == null || Number.isNaN(v)) return '–';
  return (metric === 'PSNR' || metric === 'NIQE' || metric === 'MUSIQ') ? v.toFixed(2) : v.toFixed(3);
};
App.fmtDelta = function (metric, v) {
  if (v == null || Number.isNaN(v)) return '';
  const d = (metric === 'PSNR' || metric === 'NIQE' || metric === 'MUSIQ') ? 2 : 3;
  return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);
};
App.metricInfo = name => App.meta.metrics.find(m => m.name === name);
App.key = (ds, image) => ds + '/' + image;
App.toast = function (msg, ms = 1800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(App._tt); App._tt = setTimeout(() => t.classList.remove('show'), ms);
};

/* ---------------------------------------------------------------- persistence */
App.save = debounce(async function () {
  try {
    $('#save-status').textContent = 'saving…';
    await App.api.post('/api/state', { picks: App.picks, rejected: App.rejected, figure: App.figure, ui: App.ui });
    $('#save-status').textContent = 'saved ✓';
  } catch (e) { $('#save-status').textContent = 'save failed!'; console.error(e); }
}, 400);

App.updatePickBadge = () => { $('#pick-count').textContent = App.picks.length; };

/* ---------------------------------------------------------------- picks */
App.pickIndex = (ds, image) => App.picks.findIndex(p => p.ds === ds && p.image === image);
App.isPicked = (ds, image) => App.pickIndex(ds, image) >= 0;
App.addPick = function (ds, image, rois, note) {
  const i = App.pickIndex(ds, image);
  const entry = { ds, image, rois: JSON.parse(JSON.stringify(rois)), note: note || (i >= 0 ? App.picks[i].note : '') };
  if (i >= 0 && App.picks[i].hidden) entry.hidden = true;   // keep "not shown in figure" when ROIs are edited
  if (i >= 0) App.picks[i] = entry; else App.picks.push(entry);
  App.updatePickBadge(); App.save();
};
App.removePick = function (ds, image) {
  const i = App.pickIndex(ds, image); if (i >= 0) App.picks.splice(i, 1);
  App.updatePickBadge(); App.save();
};
App.isRejected = (ds, image) => App.rejected.includes(App.key(ds, image));
App.toggleReject = function (ds, image) {
  const k = App.key(ds, image), i = App.rejected.indexOf(k);
  if (i >= 0) App.rejected.splice(i, 1); else App.rejected.push(k);
  App.save();
};

/* ---------------------------------------------------------------- dataset loading */
App.loadDataset = async function (name) {
  if (!App.data[name]) App.data[name] = await App.api.get('/api/dataset/' + encodeURIComponent(name));
  return App.data[name];
};

App.setDataset = async function (name, silent) {
  const D = await App.loadDataset(name);
  App.ds = name; App.D = D; App.ui.ds = name;
  $('#ds-select').value = name;
  App.reconcile(D);
  if (!silent) { App.save(); App.refresh(); }
  return D;
};

/* make sure ui/figure column lists contain only existing methods, ours present */
App.reconcile = function (D) {
  const ours = App.meta.ours, ui = App.ui, fig = App.figure;
  const base = D.methods.filter(m => m !== ours);
  const allCols = ['LR', 'HR', ...base, ...(D.methods.includes(ours) ? [ours] : [])];
  if (!ui.comparators) ui.comparators = base.slice();
  ui.comparators = ui.comparators.filter(m => base.includes(m));
  const mn = App.meta.metrics.map(m => m.name);
  if (!ui.scoreMetrics) ui.scoreMetrics = mn.slice();
  ui.scoreMetrics = ui.scoreMetrics.filter(m => mn.includes(m));
  ui.reqMetrics = (ui.reqMetrics || []).filter(m => mn.includes(m));
  if (!fig.order) fig.order = allCols.slice();
  fig.order = fig.order.filter(m => allCols.includes(m));
  for (const m of allCols) if (!fig.order.includes(m)) fig.order.splice(fig.order.length - 1, 0, m);
  fig.hidden = (fig.hidden || []).filter(m => allCols.includes(m));
};
App.columns = () => App.figure.order.filter(m => !App.figure.hidden.includes(m));

/* ---------------------------------------------------------------- scoring */
/* sigma: typical spread between methods on the same image (mean per-image std) */
App.sigma = function (D) {
  if (D._sigma) return D._sigma;
  const s = {}, N = D.images.length;
  for (const m of App.meta.metrics) {
    let acc = 0, n = 0;
    const arrs = D.methods.map(me => D.metrics[me][m.name]);
    for (let i = 0; i < N; i++) {
      let c = 0, sum = 0, sq = 0;
      for (const a of arrs) { const v = a[i]; if (v != null) { c++; sum += v; sq += v * v; } }
      if (c > 2) { const mu = sum / c; acc += Math.sqrt(Math.max(sq / c - mu * mu, 0)); n++; }
    }
    s[m.name] = n ? Math.max(acc / n, 1e-9) : 1;
  }
  return (D._sigma = s);
};

App.analyze = function (D) {
  const ui = App.ui, ours = App.meta.ours, M = App.meta.metrics, N = D.images.length;
  const comps = D.methods.filter(m => m !== ours && ui.comparators.includes(m));
  const sig = App.sigma(D);
  const R = { comps, rank: {}, marg: {}, nmarg: {}, best: {}, wins: new Int16Array(N), comp: new Float32Array(N).fill(NaN), pass: new Uint8Array(N) };
  const oursM = D.metrics[ours];
  for (const m of M) {
    const o = oursM && oursM[m.name];
    const rank = new Int8Array(N), marg = new Float32Array(N).fill(NaN), best = new Float32Array(N).fill(NaN), nm = new Float32Array(N).fill(NaN);
    const arrs = comps.map(c => D.metrics[c][m.name]);
    if (o) for (let i = 0; i < N; i++) {
      const v = o[i]; if (v == null) continue;
      let b = null, better = 0;
      for (const a of arrs) {
        const w = a[i]; if (w == null) continue;
        if (m.higher ? w > v : w < v) better++;
        if (b == null || (m.higher ? w > b : w < b)) b = w;
      }
      rank[i] = better + 1;
      if (b != null) { best[i] = b; const g = m.higher ? v - b : b - v; marg[i] = g; nm[i] = clamp(g / sig[m.name], -3, 3); }
    }
    R.rank[m.name] = rank; R.marg[m.name] = marg; R.nmarg[m.name] = nm; R.best[m.name] = best;
  }
  const q = (ui.search || '').trim().toLowerCase();
  for (let i = 0; i < N; i++) {
    let sum = 0, c = 0, w = 0;
    for (const mn of ui.scoreMetrics) {
      const v = R.nmarg[mn][i]; if (!Number.isNaN(v)) { sum += v; c++; }
      if (R.rank[mn][i] === 1) w++;
    }
    R.wins[i] = w; if (c) R.comp[i] = sum / c;
    let ok = w >= ui.minWins;
    for (const mn of ui.reqMetrics) { const r = R.rank[mn][i]; if (!(r > 0 && r <= ui.K)) { ok = false; break; } }
    if (ok && q && !D.images[i].toLowerCase().includes(q)) ok = false;
    if (ok && ui.onlyPicked && !App.isPicked(D.name, D.images[i])) ok = false;
    if (ok && ui.hideRejected && App.isRejected(D.name, D.images[i])) ok = false;
    R.pass[i] = ok ? 1 : 0;
  }
  return R;
};

App.sortKeyValue = function (R, D, key) {
  const N = D.images.length;
  if (key === 'name') return null;
  if (key === 'comp') return R.comp;
  if (key === 'wins') return R.wins;
  const [, mn, kind] = key.split(':');
  if (kind === 'marg') return R.marg[mn];
  if (kind === 'rank') return R.rank[mn];
  if (kind === 'val') { const a = D.metrics[App.meta.ours][mn]; return Float32Array.from(a, v => v == null ? NaN : v); }
  return R.comp;
};

App.buildList = function () {
  const D = App.D, R = App.analysis = App.analyze(D), ui = App.ui;
  const idx = [];
  for (let i = 0; i < D.images.length; i++) if (R.pass[i]) idx.push(i);
  const s = ui.sortDir === 'asc' ? 1 : -1;   // 'desc' = big / best first
  if (ui.sortKey === 'name') idx.sort((a, b) => D.images[a].localeCompare(D.images[b], undefined, { numeric: true }) * s);
  else {
    const v = App.sortKeyValue(R, D, ui.sortKey);
    const flip = /:rank$/.test(ui.sortKey) ? -1 : 1;   // rank: small number = better
    idx.sort((a, b) => {
      let x = v[a], y = v[b];
      const nx = Number.isNaN(x) || (flip < 0 && x === 0), ny = Number.isNaN(y) || (flip < 0 && y === 0);
      if (nx || ny) return nx === ny ? 0 : (nx ? 1 : -1);
      return (x - y) * s * flip;
    });
  }
  App.list = idx;
  return idx;
};

/* ---------------------------------------------------------------- views */
App.show = function (name) {
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  App.current = name;
  const v = App.views[name]; if (v && v.enter) v.enter();
};
App.refresh = function () {   // dataset or filter changed
  App.buildList();
  for (const v of Object.values(App.views)) if (v.refresh) v.refresh();
};

App.boot = async function () {
  try {
    App.meta = await App.api.get('/api/meta');
    const saved = await App.api.get('/api/state');
    App.ui = Object.assign({}, DEFAULT_UI, saved.ui || {});
    App.figure = Object.assign({}, DEFAULT_FIG, saved.figure || {});
    App.picks = saved.picks || [];
    App.rejected = saved.rejected || [];
    const sel = $('#ds-select');
    App.meta.datasets.forEach(d => sel.append(h('option', { value: d }, d)));
    sel.addEventListener('change', () => App.setDataset(sel.value));
    $$('#tabs button').forEach(b => b.addEventListener('click', () => App.show(b.dataset.view)));
    const ds = App.meta.datasets.includes(App.ui.ds) ? App.ui.ds : App.meta.datasets[0];
    await App.setDataset(ds, true);
    // load other datasets' metadata lazily so picks from other datasets can render
    for (const p of App.picks) if (!App.data[p.ds]) await App.loadDataset(p.ds).catch(() => { });
    for (const v of Object.values(App.views)) if (v.init) v.init();
    App.updatePickBadge();
    App.refresh();
    App.show('browse');
    $('#save-status').textContent = 'ready';
  } catch (e) {
    console.error(e);
    document.body.prepend(h('pre', { class: 'fatal' }, 'Boot failed: ' + e.message + '\n' + (e.stack || '')));
  }
};
