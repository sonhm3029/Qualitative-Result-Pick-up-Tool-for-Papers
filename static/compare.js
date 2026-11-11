'use strict';
/* Compare view: one overview image with draggable ROI ("loupe"); a grid with the same region for every method */
App.views.compare = (function () {
  const root = $('#view-compare');
  const OV_W = 330;
  const els = {};
  let C = null;            // current image context
  let loadGen = 0;
  let tiles = {};          // method -> {tile, base, over, name, loc, glob}
  const dpr = () => window.devicePixelRatio || 1;

  /* magma-like LUT for the error map */
  const LUT = (() => {
    const stops = [[0, [0, 0, 4]], [0.25, [80, 18, 123]], [0.5, [182, 54, 121]], [0.75, [251, 136, 97]], [1, [252, 253, 191]]];
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255; let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const [t0, c0] = stops[k], [t1, c1] = stops[k + 1], u = (t - t0) / (t1 - t0);
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * u;
    }
    return lut;
  })();

  /* ------------------------------------------------------------ skeleton */
  function init() {
    root.innerHTML = '';
    els.prev = h('button', { class: 'btn', onclick: () => nav(-1), title: '← previous image' }, '◀ prev');
    els.next = h('button', { class: 'btn', onclick: () => nav(1), title: '→ next image' }, 'next ▶');
    els.pos = h('span', { class: 'muted' });
    els.name = h('strong', { class: 'imgname' }, 'no image selected — open one from Browse');
    els.pick = h('button', { class: 'btn primary', onclick: doPick, title: 'P' }, '☆ Add to figure');
    els.unpick = h('button', { class: 'btn', onclick: doUnpick, hidden: true }, 'Remove pick');
    els.reject = h('button', { class: 'btn', onclick: doReject, title: 'X' }, '✕ Reject');
    els.top = h('div', { class: 'cmp-top' }, els.prev, els.next, els.pos, els.name, h('span', { class: 'grow' }), els.pick, els.unpick, els.reject);

    // --- left panel
    els.ov = h('canvas', { class: 'ov' });
    els.ovSel = h('select', { onchange: e => { App.ui.overviewMethod = e.target.value; App.save(); drawOverview(); } });
    els.roiChips = h('div', { class: 'chips' });
    els.roiInfo = h('div', { class: 'muted small' });
    els.aspect = h('select', { onchange: e => setAspect(e.target.value) },
      [['1', '1 : 1'], ['1.3333', '4 : 3'], ['0.75', '3 : 4'], ['1.5', '3 : 2'], ['0.6667', '2 : 3'], ['1.7778', '16 : 9'], ['2', '2 : 1']].map(([v, t]) => h('option', { value: v }, t)));
    els.size = h('input', { type: 'range', min: 16, max: 512, step: 1, oninput: e => { const r = roi(); const cx = r.x + r.w / 2, cy = r.y + r.h / 2; r.w = +e.target.value; r.x = cx - r.w / 2; r.y = cy - r.h / 2; fit(r); roisChanged(); } });
    els.tileSize = h('input', { type: 'range', min: 120, max: 520, step: 10, value: App.ui.tile, oninput: e => { App.ui.tile = +e.target.value; App.save(); layoutTiles(); drawAll(); } });
    els.smooth = h('select', { onchange: e => { App.ui.smooth = e.target.value; App.save(); drawAll(); } },
      h('option', { value: 'smooth' }, 'smooth (bicubic)'), h('option', { value: 'nearest' }, 'nearest (pixels)'));
    els.diff = h('input', { type: 'checkbox', onchange: e => { App.ui.diff = e.target.checked; App.save(); drawAll(); } });
    els.gain = h('input', { type: 'range', min: 1, max: 12, step: 1, value: App.ui.diffGain, oninput: e => { App.ui.diffGain = +e.target.value; App.save(); drawAll(); } });
    els.sortTiles = h('input', { type: 'checkbox', onchange: e => { App.ui.sortTiles = e.target.checked; App.save(); drawAll(); } });
    els.glob = h('select', { onchange: e => { App.ui.cmpMetric = e.target.value; App.save(); drawAll(); } },
      App.meta.metrics.map(m => h('option', { value: m.name }, m.name + (m.higher ? ' ↑' : ' ↓'))));
    els.cols = h('div', { class: 'chips' });
    els.sugWin = h('select', { onchange: e => { App.ui.suggestWin = +e.target.value; App.save(); } }, [48, 64, 96, 128, 160, 192, 256].map(v => h('option', { value: v }, v + ' px')));
    els.sugTex = h('input', { type: 'range', min: 0, max: 50, step: 1, oninput: e => { App.ui.suggestTexture = +e.target.value; $('#sug-tex-v').textContent = e.target.value; App.save(); } });
    els.sugMode = h('select', { onchange: e => { App.ui.suggestMode = e.target.value; App.save(); } },
      h('option', { value: 'best' }, 'vs best baseline'), h('option', { value: 'mean' }, 'vs mean of baselines'));
    els.sugList = h('div', { class: 'sug-list' });
    els.table = h('div', { class: 'mtable-wrap' });

    const panel = (title, ...kids) => h('div', { class: 'panel' }, h('h4', null, title), ...kids);
    els.left = h('aside', { class: 'cmp-left' },
      panel('Overview', h('div', { class: 'row-flex' }, 'show', els.ovSel), els.ov,
        h('div', { class: 'help' }, 'drag = move box · wheel = resize · click = jump')),
      panel('Region of interest (ROI)', els.roiChips,
        h('div', { class: 'row-flex' }, 'aspect', els.aspect, 'width', els.size),
        els.roiInfo,
        h('div', { class: 'row-flex' }, h('button', { class: 'btn', onclick: addRoi }, '+ ROI'), h('button', { class: 'btn', onclick: removeRoi }, '− remove'), h('button', { class: 'btn', onclick: centerRoi }, 'center'))),
      panel('Tiles',
        h('div', { class: 'row-flex' }, 'size', els.tileSize),
        h('div', { class: 'row-flex' }, 'scaling', els.smooth),
        h('div', { class: 'row-flex' }, h('label', { class: 'check' }, els.diff, ' error map vs HR'), 'gain', els.gain),
        h('div', { class: 'row-flex' }, h('label', { class: 'check' }, els.sortTiles, ' sort by local PSNR')),
        h('div', { class: 'row-flex' }, 'global metric', els.glob),
        h('div', { class: 'help' }, 'visible methods (order is set in Figure tab):'), els.cols),
      panel('Auto-suggest regions',
        h('div', { class: 'row-flex' }, 'window', els.sugWin, h('span', { class: 'muted' }, 'aspect = ROI')),
        h('div', { class: 'row-flex' }, 'min texture', els.sugTex, h('b', { id: 'sug-tex-v' }, App.ui.suggestTexture)),
        h('div', { class: 'row-flex' }, els.sugMode, h('button', { class: 'btn primary', onclick: findSuggestions }, 'Suggest')),
        h('div', { class: 'help' }, 'Slides a window over the image, ranks by local PSNR (vs HR) advantage of GRN-SR over the baselines, skips flat areas. Proxy only — confirm visually.'),
        els.sugList),
      panel('Image metrics (all methods)', els.table));

    // --- grid
    els.tiles = h('div', { class: 'tiles' });
    els.status = h('div', { class: 'muted small cmp-status' }, 'W/A/S/D move ROI · Q/E shrink/grow · ←/→ prev/next image · P add to figure · X reject · F error map · 1/2/3 select ROI');
    els.main = h('main', { class: 'cmp-grid' }, els.tiles, els.status);
    root.append(els.top, h('div', { class: 'cmp-body' }, els.left, els.main));

    // overview interaction
    let drag = null;
    const ovPt = e => { const r = els.ov.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * C.W, (e.clientY - r.top) / r.height * C.H]; };
    els.ov.addEventListener('pointerdown', e => {
      if (!C) return;
      const [px, py] = ovPt(e);
      let hit = C.rois.findIndex((r, i) => i === C.active && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
      if (hit < 0) hit = C.rois.findIndex(r => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
      if (hit >= 0) { C.active = hit; drag = { ox: px - C.rois[hit].x, oy: py - C.rois[hit].y }; }
      else { const r = roi(); r.x = px - r.w / 2; r.y = py - r.h / 2; fit(r); drag = { ox: r.w / 2, oy: r.h / 2 }; }
      els.ov.setPointerCapture(e.pointerId); roisChanged(true);
    });
    els.ov.addEventListener('pointermove', e => {
      if (!C || !drag) return;
      const [px, py] = ovPt(e), r = roi(); r.x = px - drag.ox; r.y = py - drag.oy; fit(r); roisChanged();
    });
    els.ov.addEventListener('pointerup', () => { drag = null; });
    els.ov.addEventListener('wheel', e => { if (!C) return; e.preventDefault(); zoomRoi(e.deltaY > 0 ? 1.1 : 1 / 1.1, 0.5, 0.5); }, { passive: false });

    document.addEventListener('keydown', onKey);
    syncControls();
  }

  function syncControls() {
    const ui = App.ui;
    els.smooth.value = ui.smooth; els.diff.checked = ui.diff; els.sortTiles.checked = ui.sortTiles;
    els.glob.value = ui.cmpMetric; els.sugWin.value = ui.suggestWin; els.sugTex.value = ui.suggestTexture; els.sugMode.value = ui.suggestMode;
    els.aspect.value = String(ui.aspect);
  }

  /* ------------------------------------------------------------ ROI model */
  const roi = () => C.rois[C.active];
  function fit(r) {
    r.w = clamp(Math.round(r.w), 16, C.W);
    r.h = Math.round(r.w / r.a);
    if (r.h > C.H) { r.h = C.H; r.w = Math.round(r.h * r.a); }
    if (r.h < 8) r.h = 8;
    r.x = clamp(Math.round(r.x), 0, C.W - r.w);
    r.y = clamp(Math.round(r.y), 0, C.H - r.h);
  }
  function mkRoi(w, a, cx, cy) {
    const r = { x: 0, y: 0, w, h: 0, a }; r.x = cx - w / 2; r.y = cy - w / a / 2; fit(r); return r;
  }
  function plainRois() { return C.rois.map(({ x, y, w, h }) => ({ x, y, w, h })); }
  function roisChanged(structural) {
    App.roiMemory[App.key(C.ds, C.name)] = plainRois();
    if (App.isPicked(C.ds, C.name)) App.addPick(C.ds, C.name, plainRois());
    if (structural) { layoutTiles(); }
    updateRoiUi(); drawAll();
  }
  function setAspect(v) {
    const a = +v; App.ui.aspect = a; App.save();
    if (!C) return;
    const r = roi(), cx = r.x + r.w / 2, cy = r.y + r.h / 2; r.a = a; r.x = cx - r.w / 2; r.y = cy - r.h / 2; fit(r);
    roisChanged(true);
  }
  function zoomRoi(f, nx, ny) {    // f>1 => bigger window (zoom out); anchor at normalized (nx,ny) of ROI
    const r = roi(), px = r.x + nx * r.w, py = r.y + ny * r.h;
    r.w = clamp(r.w * f, 16, C.W); r.h = r.w / r.a;
    r.x = px - nx * r.w; r.y = py - ny * r.h; fit(r); roisChanged();
  }
  function addRoi() {
    if (!C || C.rois.length >= ROI_COLORS.length) return;
    const b = roi(); C.rois.push(mkRoi(b.w, b.a, C.W * (0.25 + 0.5 * Math.random()), C.H * (0.25 + 0.5 * Math.random())));
    C.active = C.rois.length - 1; roisChanged(true);
  }
  function removeRoi() {
    if (!C || C.rois.length <= 1) return;
    C.rois.splice(C.active, 1); C.active = Math.max(0, C.active - 1); roisChanged(true);
  }
  function centerRoi() { if (!C) return; const r = roi(); r.x = (C.W - r.w) / 2; r.y = (C.H - r.h) / 2; fit(r); roisChanged(); }

  function updateRoiUi() {
    if (!C) return;
    els.roiChips.innerHTML = '';
    C.rois.forEach((r, i) => els.roiChips.append(h('button', { class: 'chip' + (i === C.active ? ' on' : ''), style: { borderColor: ROI_COLORS[i] }, onclick: () => { C.active = i; roisChanged(true); } }, 'ROI ' + (i + 1))));
    const r = roi();
    els.size.max = C.W; els.size.value = r.w; els.aspect.value = String(r.a);
    const sel = [...els.aspect.options].find(o => Math.abs(+o.value - r.a) < 0.01);
    if (!sel) { const o = h('option', { value: String(r.a) }, r.a.toFixed(2) + ' : 1'); els.aspect.append(o); }
    els.aspect.value = String(sel ? sel.value : r.a);
    const zoom = (App.ui.tile / r.w).toFixed(1);
    els.roiInfo.textContent = `x=${r.x} y=${r.y}  ${r.w}×${r.h} px  ·  tile zoom ×${zoom}`;
  }

  /* ------------------------------------------------------------ loading */
  async function open(ds, name, rois) {
    if (App.ds !== ds) await App.setDataset(ds);
    const idx = App.data[ds].images.indexOf(name);
    if (idx < 0) return;
    App.show('compare');
    await load(idx, rois);
  }

  async function load(idx, forcedRois) {
    const D = App.D, name = D.images[idx], gen = ++loadGen;
    const methods = ['LR', 'HR', ...D.methods];
    els.name.textContent = name; els.tiles.classList.add('loading');
    let imgs;
    try { imgs = await Promise.all(methods.map(m => App.loadImage(D.name, m, name))); }
    catch (e) { App.toast('failed to load images: ' + e.message, 4000); return; }
    if (gen !== loadGen) return;
    const byM = Object.fromEntries(methods.map((m, i) => [m, imgs[i]]));
    const W = byM.HR.naturalWidth, H = byM.HR.naturalHeight, key = App.key(D.name, name);
    const pickIdx = App.pickIndex(D.name, name);
    let rois = forcedRois || (pickIdx >= 0 && App.picks[pickIdx].rois.length ? App.picks[pickIdx].rois : null) || App.roiMemory[key];
    C = { ds: D.name, D, idx, name, methods, imgs: byM, W, H, pix: {}, err: null, active: 0, hover: null, drag: null };
    rois = rois && rois.length ? rois : [{ x: 0, y: 0, w: Math.round(W * 0.19), h: 0, a: App.ui.aspect }];
    C.rois = rois.map((r, i) => {
      const a = r.a || (r.w / r.h) || 1, o = { x: r.x, y: r.y, w: r.w, h: r.h, a };
      if (!rois[i].h && !rois[i].x) { o.x = (W - o.w) / 2; o.y = (H - o.w / a) / 2; }
      C.W = W; C.H = H; fit(o); return o;
    });
    els.sugList.innerHTML = '';
    // overview selector
    els.ovSel.innerHTML = '';
    for (const m of methods) els.ovSel.append(h('option', { value: m }, m));
    const ovm = methods.includes(App.ui.overviewMethod) ? App.ui.overviewMethod : (methods.includes(App.meta.ours) ? App.meta.ours : 'HR');
    els.ovSel.value = ovm; App.ui.overviewMethod = ovm;
    const cssH = Math.round(OV_W * H / W);
    els.ov.style.width = OV_W + 'px'; els.ov.style.height = cssH + 'px';
    els.ov.width = Math.round(OV_W * dpr()); els.ov.height = Math.round(cssH * dpr());
    buildColChips(); buildMetricTable(); updatePos(); updatePickBtn();
    layoutTiles(); updateRoiUi(); drawAll();
    els.tiles.classList.remove('loading');
    // prefetch neighbour
    setTimeout(() => {
      const L = App.list, p = L.indexOf(idx), n = p >= 0 && p + 1 < L.length ? L[p + 1] : null;
      if (n != null && gen === loadGen) methods.forEach(m => App.loadImage(D.name, m, D.images[n]).catch(() => { }));
    }, 300);
  }

  function nav(d) {
    if (!C) return;
    const L = App.list, p = L.indexOf(C.idx);
    let target;
    if (p >= 0) target = L[clamp(p + d, 0, L.length - 1)]; else target = clamp(C.idx + d, 0, C.D.images.length - 1);
    if (target !== C.idx) load(target);
  }
  function updatePos() {
    const L = App.list, p = L.indexOf(C.idx);
    els.pos.textContent = p >= 0 ? `${p + 1} / ${L.length} (filtered)` : `#${C.idx + 1} (outside current filter)`;
    const R = App.analysis;
    if (R) {
      const i = C.idx; els.name.title = `composite ${Number.isNaN(R.comp[i]) ? '–' : R.comp[i].toFixed(2)}, wins ${R.wins[i]}`;
    }
  }
  function updatePickBtn() {
    const picked = App.isPicked(C.ds, C.name);
    els.pick.textContent = picked ? '★ Update pick' : '☆ Add to figure';
    els.unpick.hidden = !picked;
    els.reject.textContent = App.isRejected(C.ds, C.name) ? '↺ Un-reject' : '✕ Reject';
  }
  function doPick() { if (!C) return; App.addPick(C.ds, C.name, plainRois()); updatePickBtn(); App.toast('★ added to figure (' + App.picks.length + ' rows)'); if (App.ui.onlyPicked) App.refresh(); }
  function doUnpick() { if (!C) return; App.removePick(C.ds, C.name); updatePickBtn(); App.toast('removed'); }
  function doReject() {
    if (!C) return; App.toggleReject(C.ds, C.name); updatePickBtn();
    if (App.isRejected(C.ds, C.name)) { App.buildList(); nav(1); App.views.browse.refresh(); }
  }

  /* ------------------------------------------------------------ left panels */
  function buildColChips() {
    els.cols.innerHTML = '';
    const fig = App.figure;
    for (const m of fig.order) {
      const on = !fig.hidden.includes(m);
      els.cols.append(h('button', { class: 'chip' + (on ? ' on' : '') + (m === App.meta.ours ? ' ours' : ''), onclick: () => {
        const i = fig.hidden.indexOf(m); i >= 0 ? fig.hidden.splice(i, 1) : fig.hidden.push(m);
        App.save(); buildColChips(); layoutTiles(); drawAll();
      } }, m));
    }
  }

  function buildMetricTable() {
    const D = C.D, i = C.idx, M = App.meta.metrics, ours = App.meta.ours;
    const best = {}, second = {};
    for (const m of M) {
      const vals = D.methods.map(me => [me, D.metrics[me][m.name][i]]).filter(x => x[1] != null)
        .sort((a, b) => m.higher ? b[1] - a[1] : a[1] - b[1]);
      best[m.name] = vals[0] && vals[0][0]; second[m.name] = vals[1] && vals[1][0];
    }
    const t = h('table', { class: 'mtable' },
      h('thead', null, h('tr', null, h('th', null, ''), M.map(m => h('th', { title: m.ref ? 'reference-based' : 'no-reference' }, m.name + (m.higher ? '↑' : '↓'))))),
      h('tbody', null, D.methods.map(me => h('tr', { class: me === ours ? 'ours' : '' },
        h('td', { class: 'mname' }, me),
        M.map(m => h('td', { class: me === best[m.name] ? 'best' : me === second[m.name] ? 'second' : '' }, App.fmt(m.name, D.metrics[me][m.name][i])))))));
    els.table.innerHTML = ''; els.table.append(t);
  }

  /* ------------------------------------------------------------ tiles */
  function visibleMethods() { return App.columns().filter(m => C.methods.includes(m)); }

  function layoutTiles() {
    if (!C) return;
    const r = roi(), W = App.ui.tile, Hh = Math.round(W / r.a), d = dpr();
    els.tiles.innerHTML = ''; tiles = {};
    els.tiles.style.gridTemplateColumns = `repeat(auto-fill, ${W}px)`;
    for (const m of visibleMethods()) {
      const base = h('canvas', { class: 'base' }), over = h('canvas', { class: 'over' });
      for (const c of [base, over]) { c.width = Math.round(W * d); c.height = Math.round(Hh * d); c.style.width = W + 'px'; c.style.height = Hh + 'px'; }
      const name = h('span', { class: 'tname' + (m === App.meta.ours ? ' ours' : '') }, m === 'LR' ? 'LR (upsampled)' : m === 'HR' ? 'HR (GT)' : m);
      const loc = h('span', { class: 'tloc' }), glob = h('span', { class: 'tglob' });
      const wrap = h('div', { class: 'tcanvas', style: { width: W + 'px', height: Hh + 'px', borderColor: ROI_COLORS[C.active] } }, base, over);
      const tile = h('div', { class: 'tile' + (m === App.meta.ours ? ' ours' : '') }, wrap, h('div', { class: 'tlabel' }, name, loc, glob));
      attachTile(over, m);
      els.tiles.append(tile);
      tiles[m] = { tile, base, over, loc, glob, name };
    }
  }

  function attachTile(over, m) {
    let drag = null;
    const nrm = e => { const r = over.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
    over.addEventListener('pointerdown', e => {
      const r = roi(); drag = { px: e.clientX, py: e.clientY, x: r.x, y: r.y }; over.setPointerCapture(e.pointerId); over.style.cursor = 'grabbing';
    });
    over.addEventListener('pointermove', e => {
      const [nx, ny] = nrm(e), r = roi();
      if (drag) {
        const cr = over.getBoundingClientRect();
        r.x = drag.x - (e.clientX - drag.px) * r.w / cr.width; r.y = drag.y - (e.clientY - drag.py) * r.h / cr.height; fit(r); roisChanged();
      }
      C.hover = [nx, ny]; drawOverlays();
      els.status.textContent = `pixel (${Math.floor(r.x + nx * r.w)}, ${Math.floor(r.y + ny * r.h)}) in ${C.W}×${C.H} image · ROI ${r.w}×${r.h} @ (${r.x},${r.y})`;
    });
    over.addEventListener('pointerup', () => { drag = null; over.style.cursor = ''; });
    over.addEventListener('pointerleave', () => { if (!drag) { C.hover = null; drawOverlays(); } });
    over.addEventListener('wheel', e => { e.preventDefault(); const [nx, ny] = nrm(e); zoomRoi(e.deltaY > 0 ? 1.12 : 1 / 1.12, nx, ny); }, { passive: false });
  }

  function pix(m) {
    if (C.pix[m]) return C.pix[m];
    const cv = document.createElement('canvas'); cv.width = C.W; cv.height = C.H;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingQuality = 'high'; cx.drawImage(C.imgs[m], 0, 0, C.W, C.H);
    return (C.pix[m] = cx.getImageData(0, 0, C.W, C.H).data);
  }

  const dc = document.createElement('canvas');
  function diffCanvas(m, r) {
    const a = pix(m), b = pix('HR'), W = C.W, gain = App.ui.diffGain;
    dc.width = r.w; dc.height = r.h;
    const cx = dc.getContext('2d'), out = cx.createImageData(r.w, r.h), o = out.data;
    for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) {
      const p = ((r.y + j) * W + r.x + i) * 4, q = (j * r.w + i) * 4;
      const d = (Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2])) / 3;
      const v = Math.min(255, Math.round(d * gain)) * 3;
      o[q] = LUT[v]; o[q + 1] = LUT[v + 1]; o[q + 2] = LUT[v + 2]; o[q + 3] = 255;
    }
    cx.putImageData(out, 0, 0); return dc;
  }

  function localPSNR(m, r) {
    const a = pix(m), b = pix('HR'), W = C.W; let s = 0;
    for (let j = 0; j < r.h; j++) { let p = ((r.y + j) * W + r.x) * 4; for (let i = 0; i < r.w; i++, p += 4) {
      const d0 = a[p] - b[p], d1 = a[p + 1] - b[p + 1], d2 = a[p + 2] - b[p + 2]; s += d0 * d0 + d1 * d1 + d2 * d2; } }
    const mse = s / (r.w * r.h * 3);
    return mse < 1e-9 ? 99 : 10 * Math.log10(65025 / mse);
  }

  function drawTiles() {
    if (!C) return;
    const r = roi(), ui = App.ui, M = visibleMethods();
    const psnr = {};
    for (const m of M) {
      const t = tiles[m]; if (!t) continue;
      const ctx = t.base.getContext('2d'), cw = t.base.width, ch = t.base.height, img = C.imgs[m];
      ctx.imageSmoothingEnabled = ui.smooth !== 'nearest'; ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, cw, ch);
      if (ui.diff && m !== 'HR' && m !== 'LR') ctx.drawImage(diffCanvas(m, r), 0, 0, r.w, r.h, 0, 0, cw, ch);
      else { const k = img.naturalWidth / C.W, kh = img.naturalHeight / C.H; ctx.drawImage(img, r.x * k, r.y * kh, r.w * k, r.h * kh, 0, 0, cw, ch); }
      if (m !== 'HR' && m !== 'LR') psnr[m] = localPSNR(m, r);
    }
    // labels
    const ps = Object.entries(psnr).sort((a, b) => b[1] - a[1]), bestP = ps[0] && ps[0][0], secP = ps[1] && ps[1][0];
    const gm = App.metricInfo(ui.cmpMetric), D = C.D;
    const gvals = D.methods.map(me => [me, D.metrics[me][gm.name][C.idx]]).filter(x => x[1] != null).sort((a, b) => gm.higher ? b[1] - a[1] : a[1] - b[1]);
    const gBest = gvals[0] && gvals[0][0], gSec = gvals[1] && gvals[1][0];
    M.forEach((m, k) => {
      const t = tiles[m]; if (!t) return;
      if (m in psnr) { t.loc.textContent = psnr[m].toFixed(2) + ' dB'; t.loc.className = 'tloc ' + (m === bestP ? 'best' : m === secP ? 'second' : ''); }
      else { t.loc.textContent = ''; }
      if (D.metrics[m]) {
        const v = D.metrics[m][gm.name][C.idx];
        t.glob.textContent = `${gm.name} ${App.fmt(gm.name, v)}`; t.glob.className = 'tglob ' + (m === gBest ? 'best' : m === gSec ? 'second' : '');
      } else t.glob.textContent = '';
      t.tile.style.order = ui.sortTiles ? (m === 'LR' ? -2 : m === 'HR' ? -1 : ps.findIndex(x => x[0] === m)) : k;
      t.tile.firstChild.style.borderColor = ROI_COLORS[C.active];
    });
    drawOverlays();
  }

  function drawOverlays() {
    if (!C) return;
    const d = dpr();
    for (const m in tiles) {
      const o = tiles[m].over, ctx = o.getContext('2d'); ctx.clearRect(0, 0, o.width, o.height);
      if (!C.hover) continue;
      const x = C.hover[0] * o.width, y = C.hover[1] * o.height, L = 7 * d;
      ctx.lineWidth = 1 * d; ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath(); ctx.moveTo(x - L, y); ctx.lineTo(x + L, y); ctx.moveTo(x, y - L); ctx.lineTo(x, y + L); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 1 * d;
      ctx.strokeRect(x - L - 0.5, y - L - 0.5, 2 * L + 1, 2 * L + 1);
    }
  }

  function drawOverview() {
    if (!C) return;
    const cv = els.ov, ctx = cv.getContext('2d'), d = dpr(), m = els.ovSel.value || 'HR', img = C.imgs[m];
    ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const sx = cv.width / C.W, sy = cv.height / C.H;
    C.rois.forEach((r, i) => {
      ctx.lineWidth = (i === C.active ? 2.5 : 1.5) * d; ctx.strokeStyle = ROI_COLORS[i];
      ctx.strokeRect(r.x * sx, r.y * sy, r.w * sx, r.h * sy);
      ctx.fillStyle = ROI_COLORS[i]; ctx.font = `bold ${11 * d}px sans-serif`;
      ctx.fillText(String(i + 1), r.x * sx + 3 * d, r.y * sy + 12 * d);
    });
  }

  const drawAll = raf(() => { if (!C) return; drawOverview(); drawTiles(); });

  /* ------------------------------------------------------------ auto-suggest */
  function ensureErr() {
    if (C.err) return C.err;
    const W = C.W, H = C.H, S = W + 1, hr = pix('HR'), err = {};
    const integral = f => {
      const I = new Float64Array(S * (H + 1));
      for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += f((y * W + x) * 4); I[(y + 1) * S + x + 1] = I[y * S + x + 1] + row; } }
      return I;
    };
    for (const m of C.D.methods) {
      const a = pix(m);
      err[m] = integral(p => { const d0 = a[p] - hr[p], d1 = a[p + 1] - hr[p + 1], d2 = a[p + 2] - hr[p + 2]; return d0 * d0 + d1 * d1 + d2 * d2; });
    }
    err._g = integral(p => 0.299 * hr[p] + 0.587 * hr[p + 1] + 0.114 * hr[p + 2]);
    err._g2 = integral(p => { const g = 0.299 * hr[p] + 0.587 * hr[p + 1] + 0.114 * hr[p + 2]; return g * g; });
    return (C.err = err);
  }

  function findSuggestions() {
    if (!C) return;
    const ui = App.ui, ours = App.meta.ours, W = C.W, H = C.H, S = W + 1;
    const E = ensureErr(), comps = C.D.methods.filter(m => m !== ours && ui.comparators.includes(m));
    if (!comps.length) { App.toast('select at least one baseline in Browse'); return; }
    const a = roi().a, w = Math.min(ui.suggestWin, W), hh = Math.round(w / a), n = w * hh, stride = 8, cands = [];
    const rect = (I, x, y) => I[(y + hh) * S + x + w] - I[y * S + x + w] - I[(y + hh) * S + x] + I[y * S + x];
    for (let y = 0; y + hh <= H; y += stride) for (let x = 0; x + w <= W; x += stride) {
      const g = rect(E._g, x, y), g2 = rect(E._g2, x, y), std = Math.sqrt(Math.max(0, g2 / n - (g / n) ** 2));
      if (std < ui.suggestTexture) continue;
      const P = m => 10 * Math.log10(65025 / Math.max(1e-6, rect(E[m], x, y) / (n * 3)));
      const po = P(ours); let best = -1e9, sum = 0;
      for (const c of comps) { const v = P(c); if (v > best) best = v; sum += v; }
      cands.push({ x, y, w, h: hh, margin: po - (ui.suggestMode === 'best' ? best : sum / comps.length), po, best, std });
    }
    cands.sort((p, q) => q.margin - p.margin);
    const kept = [];
    for (const c of cands) {
      if (kept.every(k => Math.abs(k.x - c.x) > c.w * 0.6 || Math.abs(k.y - c.y) > c.h * 0.6)) kept.push(c);
      if (kept.length >= 8) break;
    }
    els.sugList.innerHTML = '';
    if (!kept.length) { els.sugList.textContent = 'nothing found — lower “min texture”.'; return; }
    const img = C.imgs[ours] || C.imgs.HR;
    for (const c of kept) {
      const cv = h('canvas', { width: 64, height: Math.round(64 / a) });
      const cx = cv.getContext('2d'); cx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, cv.width, cv.height);
      els.sugList.append(h('div', { class: 'sug', onclick: () => { const r = roi(); r.x = c.x; r.y = c.y; r.w = c.w; r.a = a; fit(r); roisChanged(); } },
        cv, h('div', null, h('b', { class: c.margin > 0 ? 'pos' : 'neg' }, (c.margin >= 0 ? '+' : '') + c.margin.toFixed(2) + ' dB'),
          h('div', { class: 'muted small' }, `${ours} ${c.po.toFixed(1)} · best ${c.best.toFixed(1)}`),
          h('div', { class: 'muted small' }, `@ ${c.x},${c.y}`))));
    }
  }

  /* ------------------------------------------------------------ keyboard */
  function onKey(e) {
    if (App.current !== 'compare' || !C) return;
    const t = e.target.tagName; if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase(), step = e.shiftKey ? 16 : 4, r = roi();
    const mv = (dx, dy) => { r.x += dx; r.y += dy; fit(r); roisChanged(); };
    if (k === 'arrowleft') nav(-1);
    else if (k === 'arrowright') nav(1);
    else if (k === 'a') mv(-step, 0); else if (k === 'd') mv(step, 0);
    else if (k === 'w') mv(0, -step); else if (k === 's') mv(0, step);
    else if (k === 'q') zoomRoi(0.9, 0.5, 0.5); else if (k === 'e') zoomRoi(1.1, 0.5, 0.5);
    else if (k === 'p') doPick();
    else if (k === 'x') doReject();
    else if (k === 'f') { els.diff.checked = App.ui.diff = !App.ui.diff; App.save(); drawAll(); }
    else if (k >= '1' && k <= '3') { const i = +k - 1; if (i < C.rois.length) { C.active = i; roisChanged(true); } }
    else return;
    e.preventDefault();
  }

  /* ------------------------------------------------------------ lifecycle */
  return {
    init, open,
    refresh() { if (C && App.D && C.ds === App.ds) { updatePos(); updatePickBtn(); } },
    enter() {
      if (!C && App.list.length) load(App.list[0]);
      else if (C) { updatePickBtn(); buildColChips(); layoutTiles(); drawAll(); }
    },
    current: () => C,
  };
})();
