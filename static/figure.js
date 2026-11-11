'use strict';
/* Figure builder.
   layout "strip": one row of all methods; each cell = full image + red box + zoomed inset (like VARSR figure)
   layout "split": big LR/HR panels with box + thick inset, then a grid of per-method crops with labels below (like SeeSR/PiSA figure)
   Also exports every piece (full images, boxed images, crops) as a .zip for drawio / PowerPoint. */
App.views.figure = (function () {
  const root = $('#view-figure');
  const els = {};
  let gen = 0;

  const labelOf = m => {
    const f = App.figure;
    if (f.labels[m]) return f.labels[m];
    return m === App.meta.ours ? m + f.oursSuffix : m;
  };
  const stemOf = n => n.replace(/\.[^.]+$/, '');
  const safe = s => String(s).replace(/[^\w.-]+/g, '_');
  const pad = n => String(n).padStart(2, '0');

  /* ------------------------------------------------------------ UI */
  function init() {
    root.innerHTML = '';
    els.rows = h('div', { class: 'fig-rows' });
    els.cols = h('div', { class: 'fig-cols' });
    els.settings = h('div', { class: 'fig-settings' });
    els.canvas = h('canvas', { class: 'fig-canvas' });
    els.info = h('div', { class: 'muted small' });
    els.empty = h('div', { class: 'empty' }, 'Nothing to show. In the Compare tab, put a ROI on an image and press “Add to figure” (or P); tick rows on the left to show them.');
    els.left = h('aside', { class: 'fig-left' },
      h('div', { class: 'panel' }, h('h4', null, 'Layout'), els.layoutBox = h('div')),
      h('div', { class: 'panel' }, h('h4', null, 'Rows (picked images)'), els.rows),
      h('div', { class: 'panel' }, h('h4', null, 'Columns (methods)'), els.colHelp = h('div', { class: 'help' }), els.cols),
      h('div', { class: 'panel' }, h('h4', null, 'Style'), els.settings));
    els.main = h('main', { class: 'fig-main' },
      h('div', { class: 'fig-actions' },
        h('button', { class: 'btn primary', onclick: () => exportPNG(false) }, '⬇ Figure PNG'),
        h('button', { class: 'btn primary', onclick: () => exportPieces(false), title: 'full images, boxed images and ROI crops of every visible method + figure.png + layout.json' }, '🧩 Pieces (.zip)'),
        h('button', { class: 'btn', onclick: () => exportPNG(true) }, '💾 Save figure → tool/exports/'),
        h('button', { class: 'btn', onclick: () => exportPieces(true) }, '💾 Save pieces → tool/exports/'),
        h('button', { class: 'btn', onclick: () => exportJSON() }, 'Export selection JSON'),
        h('button', { class: 'btn', onclick: () => els.file.click(), title: 'load picks + ROIs + figure style from a selection.json exported earlier' }, 'Import selection JSON'),
        els.file = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, onchange: e => { importJSON(e.target.files[0]); e.target.value = ''; } }),
        h('label', { class: 'muted' }, 'preview ',
          h('select', { onchange: e => { els.canvas.style.maxWidth = e.target.value === 'fit' ? '100%' : 'none'; els.canvas.style.width = e.target.value === 'fit' ? '' : e.target.value + '%'; } },
            [['fit', 'fit width'], ['50', '50%'], ['100', '100% (pixels)']].map(([v, t]) => h('option', { value: v }, t)))),
        els.info),
      h('div', { class: 'fig-scroll' }, els.empty, els.canvas));
    root.append(els.left, els.main);
    buildSettings();
  }

  function buildSettings() {
    const f = App.figure, rr = debounce(render, 80);
    const set = (k, v) => { f[k] = v; App.save(); rr(); };
    const num = (label, key, min, max, step, title) => h('label', { class: 'set', title: title || '' }, label,
      h('input', { type: 'number', min, max, step, value: f[key], onchange: e => set(key, +e.target.value) }));
    const sel = (label, key, opts, title) => h('label', { class: 'set', title: title || '' }, label,
      h('select', { onchange: e => set(key, e.target.value) }, opts.map(([v, t]) => h('option', { value: v, selected: String(f[key]) === String(v) }, t))));
    const chk = (label, key) => h('label', { class: 'set check' }, h('input', { type: 'checkbox', checked: f[key], onchange: e => set(key, e.target.checked) }), label);
    const txt = (label, key) => h('label', { class: 'set' }, label, h('input', { type: 'text', value: f[key], oninput: e => set(key, e.target.value) }));

    // layout chooser (two big buttons)
    const L = [['strip', 'A · Strip', 'one row: every method shows the full image + red box + zoomed inset'],
               ['split', 'B · Split', 'big LR/HR panels with box + thick inset, then a grid of crops with labels below']];
    els.layoutBox.append(
      h('div', { class: 'layout-pick' }, L.map(([v, t, d]) => h('button', { class: 'layout-btn' + (f.layout === v ? ' on' : ''), title: d, 'data-l': v, onclick: e => {
        f.layout = v; $$('.layout-btn', els.layoutBox).forEach(b => b.classList.toggle('on', b.dataset.l === v)); App.save(); renderLists(); render();
      } }, h('b', null, t), h('span', { class: 'small muted' }, d)))),
      h('div', { class: 'fig-settings' },
        num('crop-grid columns (B), 0 = auto (2 rows)', 'gridCols', 0, 12, 1, 'layout B: number of columns in the crop grid; 0 splits the methods into 2 rows'),
        num('inset border × (B)', 'thickMul', 1, 4, 0.5, 'layout B: inset border is this many times thicker than the thin ROI box'),
        chk('thin gray frame on crops (B)', 'cropFrame')));

    els.settings.append(
      num('panel width (px)', 'tile', 64, 2048, 16, 'width of one full-image panel at 1× (HR is 512)'),
      num('gap (px)', 'gap', 0, 40, 1),
      num('inset size (frac of panel)', 'inset', 0.15, 0.8, 0.01),
      num('box line width', 'lw', 0.5, 12, 0.5, 'in px for a 512-wide panel; scales with panel size'),
      sel('inset corner', 'corner', [['auto', 'auto (opposite of ROI)'], ['TL', 'top-left'], ['TR', 'top-right'], ['BL', 'bottom-left'], ['BR', 'bottom-right']]),
      sel('inset / crop scaling', 'insetSmooth', [['smooth', 'smooth (bicubic)'], ['nearest', 'nearest']]),
      sel('LR scaling', 'lrSmooth', [['smooth', 'smooth (bicubic)'], ['nearest', 'nearest']]),
      sel('font', 'font', ['Times New Roman', 'Liberation Serif', 'Arial', 'Helvetica', 'DejaVu Sans'].map(x => [x, x])),
      num('label font size', 'fontSize', 0, 80, 1, '0 = no labels'),
      num('pieces: crop long edge (px)', 'pieceCrop', 64, 2048, 32, 'size of the exported ROI crop PNGs'),
      chk('bold label for ours', 'boldOurs'),
      txt('ours label suffix', 'oursSuffix'),
      sel('figure export scale', 'scale', [[1, '1×'], [2, '2×'], [3, '3×']]),
      sel('metric overlay', 'showMetric', [['none', 'none'], ...App.meta.metrics.map(m => [m.name, m.name])]),
      chk('draft: overlay image name', 'draftName'));
  }

  function renderLists() {
    const f = App.figure, ours = App.meta.ours;
    els.colHelp.textContent = f.layout === 'split'
      ? 'Layout B: LR / HR become the big panels (in this order); every other checked method goes into the crop grid. Only ROI 1 of each row is used.'
      : 'Layout A: every checked column is one cell. Multiple ROIs are all drawn.';
    // rows
    els.rows.innerHTML = '';
    if (!App.picks.length) els.rows.append(h('div', { class: 'muted small' }, 'empty'));
    else {
      const setAll = v => { App.picks.forEach(p => { if (v) delete p.hidden; else p.hidden = true; }); App.save(); renderLists(); render(); };
      const nShown = App.picks.filter(p => !p.hidden).length;
      els.rows.append(h('div', { class: 'mini-actions' }, h('span', { class: 'muted' }, `${nShown}/${App.picks.length} shown in figure`),
        h('a', { onclick: () => setAll(true) }, 'all'), h('a', { onclick: () => setAll(false) }, 'none')));
    }
    App.picks.forEach((p, i) => {
      const warn = !p.rois.length;
      els.rows.append(h('div', { class: 'fig-row' + (p.hidden ? ' off' : '') },
        h('input', { type: 'checkbox', checked: !p.hidden, title: 'show this row in the figure', onchange: e => { if (e.target.checked) delete p.hidden; else p.hidden = true; App.save(); renderLists(); render(); } }),
        h('img', { src: App.thumbURL(p.ds, 'HR', p.image, 128), width: 56, height: 56 }),
        h('div', { class: 'grow' }, h('div', { class: 'small' }, p.image), h('div', { class: 'muted small' }, p.ds + (warn ? ' · ⚠ no ROI' : ` · ${p.rois.length} ROI`))),
        h('div', { class: 'btns' },
          h('button', { title: 'move up', onclick: () => move(i, -1) }, '↑'), h('button', { title: 'move down', onclick: () => move(i, 1) }, '↓'),
          h('button', { title: 'edit in Compare', onclick: () => { App.views.compare.open(p.ds, p.image, p.rois); } }, '✎'),
          h('button', { title: 'remove', onclick: () => { App.removePick(p.ds, p.image); renderLists(); render(); } }, '✕'))));
    });
    // cols
    els.cols.innerHTML = '';
    f.order.forEach((m, i) => {
      els.cols.append(h('div', { class: 'fig-col' + (m === ours ? ' ours' : '') },
        h('input', { type: 'checkbox', checked: !f.hidden.includes(m), onchange: e => { const k = f.hidden.indexOf(m); if (e.target.checked) { if (k >= 0) f.hidden.splice(k, 1); } else if (k < 0) f.hidden.push(m); App.save(); render(); } }),
        h('span', { class: 'cname' }, m),
        h('input', { type: 'text', placeholder: labelOf(m), value: f.labels[m] || '', oninput: e => { if (e.target.value) f.labels[m] = e.target.value; else delete f.labels[m]; App.save(); debounce(render, 80)(); } }),
        h('button', { onclick: () => moveCol(i, -1) }, '◀'), h('button', { onclick: () => moveCol(i, 1) }, '▶')));
    });
  }
  function move(i, d) {
    const j = i + d; if (j < 0 || j >= App.picks.length) return;
    [App.picks[i], App.picks[j]] = [App.picks[j], App.picks[i]]; App.save(); renderLists(); render();
  }
  function moveCol(i, d) {
    const o = App.figure.order, j = i + d; if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]]; App.save(); renderLists(); render();
  }

  /* ------------------------------------------------------------ drawing helpers */
  function placeInsets(rois, k, T, tH, fig) {
    const rects = rois.map(r => ({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k }));
    const used = new Set(), out = [];
    const inter = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    rois.forEach((r, j) => {
      let iw = fig.inset * T, ih = iw * r.h / r.w;
      if (ih > tH * 0.55) { ih = tH * 0.55; iw = ih * r.w / r.h; }
      const cs = { TL: [0, 0], TR: [T - iw, 0], BL: [0, tH - ih], BR: [T - iw, tH - ih] };
      const rc = rects[j], cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2;
      let order = Object.keys(cs).sort((a, b) => {
        const d = c => Math.hypot(cs[c][0] + iw / 2 - cx, cs[c][1] + ih / 2 - cy); return d(b) - d(a);
      });
      if (j === 0 && fig.corner !== 'auto') order = [fig.corner];
      const ch = order.find(c => !used.has(c) && !rects.some(rr => inter({ x: cs[c][0], y: cs[c][1], w: iw, h: ih }, rr))) || order.find(c => !used.has(c)) || order[0];
      used.add(ch);
      out.push({ x: cs[ch][0], y: cs[ch][1], w: iw, h: ih });
    });
    return out;
  }

  const labelFont = (ctx, m, fs) => {
    const f = App.figure, bold = f.boldOurs && m === App.meta.ours;
    ctx.font = `${bold ? 'bold ' : ''}${fs}px "${f.font}", "Times New Roman", serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#000';
  };
  function metricOverlay(ctx, p, m, cx, y, T) {
    const fig = App.figure, D = App.data[p.ds]; if (fig.showMetric === 'none' || !D.metrics[m]) return;
    const v = D.metrics[m][fig.showMetric][D.images.indexOf(p.image)], txt = `${fig.showMetric} ${App.fmt(fig.showMetric, v)}`;
    const f2 = Math.max(10, Math.round(T * 0.05));
    ctx.font = `${f2}px "${fig.font}", serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fillRect(cx - tw / 2 - 4, y, tw + 8, f2 * 1.3);
    ctx.fillStyle = '#000'; ctx.fillText(txt, cx, y + f2 * 0.15);
  }
  function draftName(ctx, p, x0, y0, T) {
    const f2 = Math.max(10, Math.round(T * 0.04));
    ctx.font = `${f2}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const tw = ctx.measureText(p.image).width; ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(x0, y0, tw + 8, f2 * 1.4);
    ctx.fillStyle = '#fff'; ctx.fillText(p.image, x0 + 4, y0 + f2 * 0.2);
  }
  const strokeIn = (ctx, x, y, w, h, lw, col) => { ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw); };

  /* ------------------------------------------------------------ layout A: strip */
  function drawStrip(canvas, rows, cols, imgs, hrs, S) {
    const fig = App.figure, T = Math.round(fig.tile * S), gap = Math.round(fig.gap * S), fs = fig.fontSize * S;
    const tH = rows.map((p, i) => Math.round(T * hrs[i].naturalHeight / hrs[i].naturalWidth));
    const labelH = fs > 0 ? Math.round(fs * 1.45) : 0;
    const cw = cols.length * T + (cols.length - 1) * gap;
    const chh = tH.reduce((a, b) => a + b, 0) + (rows.length - 1) * gap + labelH;
    canvas.width = cw; canvas.height = chh;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, chh);
    const lw = fig.lw * T / 512;
    let y0 = 0;
    rows.forEach((p, ri) => {
      const HR = hrs[ri], k = T / HR.naturalWidth, rois = p.rois;
      const ins = placeInsets(rois, k, T, tH[ri], fig);
      cols.forEach((m, ci) => {
        const img = imgs[ri][ci], x0 = ci * (T + gap), kx = img.naturalWidth / HR.naturalWidth, ky = img.naturalHeight / HR.naturalHeight;
        ctx.imageSmoothingEnabled = (m === 'LR' ? fig.lrSmooth : 'smooth') !== 'nearest'; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, x0, y0, T, tH[ri]);
        rois.forEach((r, j) => {
          const col = ROI_COLORS[j % ROI_COLORS.length], a = ins[j];
          ctx.imageSmoothingEnabled = fig.insetSmooth !== 'nearest';
          ctx.drawImage(img, r.x * kx, r.y * ky, r.w * kx, r.h * ky, x0 + a.x, y0 + a.y, a.w, a.h);
          strokeIn(ctx, x0 + a.x, y0 + a.y, a.w, a.h, lw, col);
          strokeIn(ctx, x0 + r.x * k, y0 + r.y * k, r.w * k, r.h * k, lw, col);
        });
        metricOverlay(ctx, p, m, x0 + T / 2, y0, T);
        if (fig.draftName && ci === 0) draftName(ctx, p, x0, y0, T);
      });
      y0 += tH[ri] + gap;
    });
    if (labelH) cols.forEach((m, ci) => { labelFont(ctx, m, fs); ctx.fillText(labelOf(m), ci * (T + gap) + T / 2, y0 + labelH / 2 - gap / 2 + 1); });
  }

  /* ------------------------------------------------------------ layout B: split */
  function drawSplit(canvas, rows, cols, imgs, hrs, S) {
    const fig = App.figure, T = Math.round(fig.tile * S), gap = Math.round(fig.gap * S), fs = fig.fontSize * S;
    const labelH = fs > 0 ? Math.round(fs * 1.45) : 0;
    const big = [], meth = [];
    cols.forEach((m, i) => (m === 'LR' || m === 'HR' ? big : meth).push(i));
    const nG = meth.length, gc = fig.gridCols > 0 ? Math.max(1, Math.min(fig.gridCols, nG || 1)) : Math.max(1, Math.ceil(nG / 2)), gr = nG ? Math.ceil(nG / gc) : 0;
    const lw = fig.lw * T / 512, rowGap = gap * 2;
    const geo = rows.map((p, ri) => {
      const tH = Math.round(T * hrs[ri].naturalHeight / hrs[ri].naturalWidth), blockH = tH + labelH, r0 = p.rois[0];
      const a = r0 ? r0.w / r0.h : 1;
      let ch = 0, cw = 0, gw = 0;
      if (nG) { ch = Math.max(8, Math.floor((blockH - (gr - 1) * gap) / gr - labelH)); cw = Math.max(8, Math.floor(ch * a)); gw = gc * cw + (gc - 1) * gap; }
      return { tH, blockH, ch, cw, gw };
    });
    const bigW = big.length * (T + gap);
    // right margin so that the last (wide) label is not clipped
    let overhang = 0;
    if (nG && labelH) {
      const mc = document.createElement('canvas').getContext('2d');
      meth.forEach(ci => { labelFont(mc, cols[ci], fs); const need = (mc.measureText(labelOf(cols[ci])).width - Math.min(...geo.map(g => g.cw))) / 2; overhang = Math.max(overhang, need); });
    }
    const W = bigW + Math.max(0, ...geo.map(g => g.gw)) - (nG ? 0 : gap) + Math.ceil(Math.max(0, overhang)) + 2;
    const Hh = geo.reduce((a, g) => a + g.blockH, 0) + (rows.length - 1) * rowGap;
    canvas.width = Math.max(W, 8); canvas.height = Hh;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    let y0 = 0;
    rows.forEach((p, ri) => {
      const g = geo[ri], HR = hrs[ri], k = T / HR.naturalWidth, r0 = p.rois[0], col = ROI_COLORS[0];
      big.forEach((ci, bi) => {
        const m = cols[ci], img = imgs[ri][ci], x0 = bi * (T + gap), kx = img.naturalWidth / HR.naturalWidth, ky = img.naturalHeight / HR.naturalHeight;
        ctx.imageSmoothingEnabled = (m === 'LR' ? fig.lrSmooth : 'smooth') !== 'nearest'; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, x0, y0, T, g.tH);
        if (r0) {
          const a = placeInsets([r0], k, T, g.tH, fig)[0], thick = lw * fig.thickMul;
          ctx.imageSmoothingEnabled = fig.insetSmooth !== 'nearest';
          ctx.drawImage(img, r0.x * kx, r0.y * ky, r0.w * kx, r0.h * ky, x0 + a.x, y0 + a.y, a.w, a.h);
          strokeIn(ctx, x0 + a.x, y0 + a.y, a.w, a.h, thick, col);
          strokeIn(ctx, x0 + r0.x * k, y0 + r0.y * k, r0.w * k, r0.h * k, lw, col);
        }
        if (fig.draftName && bi === 0) draftName(ctx, p, x0, y0, T);
        if (labelH) { labelFont(ctx, m, fs); ctx.fillText(labelOf(m), x0 + T / 2, y0 + g.tH + labelH / 2); }
      });
      meth.forEach((ci, mi) => {
        const m = cols[ci], img = imgs[ri][ci], cx = mi % gc, cy = Math.floor(mi / gc);
        const x = bigW + cx * (g.cw + gap), y = y0 + cy * (g.ch + labelH + gap);
        const kx = img.naturalWidth / HR.naturalWidth, ky = img.naturalHeight / HR.naturalHeight;
        if (r0) {
          ctx.imageSmoothingEnabled = fig.insetSmooth !== 'nearest'; ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, r0.x * kx, r0.y * ky, r0.w * kx, r0.h * ky, x, y, g.cw, g.ch);
        }
        if (fig.cropFrame) strokeIn(ctx, x, y, g.cw, g.ch, Math.max(1, S), '#9a9a9a');
        metricOverlay(ctx, p, m, x + g.cw / 2, y, g.cw);
        if (labelH) { labelFont(ctx, m, fs); ctx.fillText(labelOf(m), x + g.cw / 2, y + g.ch + labelH / 2); }
      });
      y0 += g.blockH + rowGap;
    });
  }

  const draw = (...a) => (App.figure.layout === 'split' ? drawSplit : drawStrip)(...a);

  async function prepare() {
    const cols = App.columns(), rows = App.picks.filter(p => !p.hidden && App.data[p.ds]);
    if (!rows.length || !cols.length) return null;
    const hrs = await Promise.all(rows.map(p => App.loadImage(p.ds, 'HR', p.image)));
    const imgs = await Promise.all(rows.map(p => Promise.all(cols.map(m => App.loadImage(p.ds, m, p.image)))));
    return { rows, cols, imgs, hrs };
  }

  async function render() {
    const g = ++gen;
    let P;
    try { P = await prepare(); } catch (e) { App.toast('image load failed: ' + e.message, 4000); return; }
    if (g !== gen) return;
    els.empty.style.display = P ? 'none' : '';
    els.canvas.style.display = P ? '' : 'none';
    if (!P) { els.info.textContent = ''; return; }
    draw(els.canvas, P.rows, P.cols, P.imgs, P.hrs, 1);
    const S = +App.figure.scale;
    els.info.textContent = `${P.rows.length} rows × ${P.cols.length} cols · preview ${els.canvas.width}×${els.canvas.height}px · export ${els.canvas.width * S}×${els.canvas.height * S}px`;
  }

  /* ------------------------------------------------------------ export */
  const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const toBlob = cv => new Promise(r => cv.toBlob(r, 'image/png'));
  function download(blob, name) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function deliver(blob, name, toServer) {
    if (!toServer) { download(blob, name); return; }
    try { const r = await App.api.post('/api/export?name=' + encodeURIComponent(name), blob, true); App.toast('saved → ' + r.path, 5000); }
    catch (e) { App.toast('save failed: ' + e.message, 4000); }
  }

  async function exportPNG(toServer) {
    const P = await prepare(); if (!P) { App.toast('nothing to export'); return; }
    const cv = document.createElement('canvas'); draw(cv, P.rows, P.cols, P.imgs, P.hrs, +App.figure.scale);
    await deliver(await toBlob(cv), `figure_${App.figure.layout}_${stamp()}.png`, toServer);
  }

  /* every piece as its own PNG:
       rowNN_<img>/full/<Method>.png        clean full image (HR size, LR upsampled)
       rowNN_<img>/full_boxed/<Method>.png  full image + ROI box(es)
       rowNN_<img>/crops/roiK_<Method>.png  ROI crop scaled to `pieceCrop` px long edge  */
  async function exportPieces(toServer) {
    const P = await prepare(); if (!P) { App.toast('nothing to export'); return; }
    const fig = App.figure, files = [], enc = new TextEncoder();
    App.toast('packing pieces…', 60000);
    const add = async (name, cv) => files.push({ name, data: new Uint8Array(await (await toBlob(cv)).arrayBuffer()) });
    const mk = (w, h2) => { const c = document.createElement('canvas'); c.width = w; c.height = h2; return c; };
    const meta = { layout: fig.layout, columns: P.cols.map(m => ({ method: m, label: labelOf(m) })), rows: [] };
    for (let ri = 0; ri < P.rows.length; ri++) {
      const p = P.rows[ri], HR = P.hrs[ri], W = HR.naturalWidth, H = HR.naturalHeight, base = `row${pad(ri + 1)}_${safe(stemOf(p.image))}`;
      meta.rows.push({ dir: base, dataset: p.ds, image: p.image, size: [W, H], rois: p.rois.map((r, j) => ({ id: j + 1, x: r.x, y: r.y, w: r.w, h: r.h, color: ROI_COLORS[j % ROI_COLORS.length] })) });
      const lw = Math.max(1, fig.lw * W / 512);
      for (let ci = 0; ci < P.cols.length; ci++) {
        const m = P.cols[ci], img = P.imgs[ri][ci], kx = img.naturalWidth / W, ky = img.naturalHeight / H, fn = safe(m);
        const full = mk(W, H), fx = full.getContext('2d');
        fx.imageSmoothingEnabled = (m === 'LR' ? fig.lrSmooth : 'smooth') !== 'nearest'; fx.imageSmoothingQuality = 'high';
        fx.drawImage(img, 0, 0, W, H);
        await add(`${base}/full/${fn}.png`, full);
        if (p.rois.length) {
          const boxed = mk(W, H), bx = boxed.getContext('2d'); bx.drawImage(full, 0, 0);
          p.rois.forEach((r, j) => strokeIn(bx, r.x, r.y, r.w, r.h, lw, ROI_COLORS[j % ROI_COLORS.length]));
          await add(`${base}/full_boxed/${fn}.png`, boxed);
        }
        for (let j = 0; j < p.rois.length; j++) {
          const r = p.rois[j], L = fig.pieceCrop, cw = r.w >= r.h ? L : Math.round(L * r.w / r.h), chh = r.w >= r.h ? Math.round(L * r.h / r.w) : L;
          const cr = mk(cw, chh), cx = cr.getContext('2d');
          cx.imageSmoothingEnabled = fig.insetSmooth !== 'nearest'; cx.imageSmoothingQuality = 'high';
          cx.drawImage(img, r.x * kx, r.y * ky, r.w * kx, r.h * ky, 0, 0, cw, chh);
          await add(`${base}/crops/roi${j + 1}_${fn}.png`, cr);
        }
      }
    }
    const fc = document.createElement('canvas'); draw(fc, P.rows, P.cols, P.imgs, P.hrs, +fig.scale);
    await add(`figure_${fig.layout}.png`, fc);
    files.push({ name: 'layout.json', data: enc.encode(JSON.stringify(meta, null, 2)) });
    const blob = makeZip(files);
    await deliver(blob, `pieces_${stamp()}.zip`, toServer);
    if (!toServer) App.toast(`${files.length} files in zip`, 3000);
  }

  function exportJSON() {
    const txt = JSON.stringify({ picks: App.picks, columns: App.columns(), figure: App.figure }, null, 2);
    download(new Blob([txt], { type: 'application/json' }), 'selection.json');
  }

  async function importJSON(file) {
    if (!file) return;
    let d;
    try { d = JSON.parse(await file.text()); } catch (e) { App.toast('not a valid JSON file', 4000); return; }
    if (!d || !Array.isArray(d.picks)) { App.toast('no "picks" array in this file', 4000); return; }
    const picks = d.picks.filter(p => p && App.meta.datasets.includes(p.ds) && typeof p.image === 'string' && Array.isArray(p.rois));
    const skipped = d.picks.length - picks.length;
    if (!picks.length) { App.toast('no usable picks (dataset names must match)', 4000); return; }
    let replace = true;
    if (App.picks.length) replace = confirm(`Replace the ${App.picks.length} current pick(s) with the ${picks.length} from the file?\n\nOK = replace, Cancel = append / overwrite same images.`);
    for (const p of picks) await App.loadDataset(p.ds);
    if (replace) App.picks = [];
    for (const p of picks) {
      if (!App.data[p.ds].images.includes(p.image)) { App.toast(`skipped missing image ${p.ds}/${p.image}`, 2500); continue; }
      App.addPick(p.ds, p.image, p.rois, p.note);
      if (p.hidden) App.picks[App.pickIndex(p.ds, p.image)].hidden = true;
    }
    if (d.figure && typeof d.figure === 'object') {
      const keepOrder = App.figure.order;
      Object.assign(App.figure, d.figure);
      if (!Array.isArray(App.figure.order)) App.figure.order = keepOrder;
      App.figure.hidden = Array.isArray(App.figure.hidden) ? App.figure.hidden : [];
      App.figure.labels = App.figure.labels && typeof App.figure.labels === 'object' ? App.figure.labels : {};
      App.reconcile(App.D);
    }
    els.settings.innerHTML = ''; els.layoutBox.innerHTML = ''; buildSettings();
    App.updatePickBadge(); App.save(); renderLists(); render();
    App.toast(`imported ${picks.length} pick(s)` + (skipped ? `, ${skipped} skipped` : ''), 3500);
  }

  /* ---- minimal ZIP writer (store, no compression: PNGs are already compressed) */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function makeZip(files) {
    const enc = new TextEncoder(), parts = [], cd = [];
    const d = new Date(), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    let off = 0;
    for (const f of files) {
      const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true);
      lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, nm, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
      ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
      cd.push(ch.buffer, nm);
      off += 30 + nm.length + sz;
    }
    const cdSize = cd.reduce((a, b) => a + (b.byteLength !== undefined ? b.byteLength : b.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...cd, end.buffer], { type: 'application/zip' });
  }

  return {
    init,
    refresh() { if (App.current === 'figure') { renderLists(); render(); } },
    enter() { renderLists(); render(); },
  };
})();
