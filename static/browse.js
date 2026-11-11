'use strict';
/* Browse & Filter: ranked table of images with GRN-SR's metrics vs. baselines */
App.views.browse = (function () {
  const root = $('#view-browse');
  const ROW_H = 84;
  let side, scroller, inner, head, status, builtFor = null;

  const fidelity = ['PSNR', 'SSIM', 'FSIM', 'LPIPS', 'DISTS'];
  const percept = ['CLIPIQA', 'NIQE', 'MUSIQ', 'MANIQA'];

  function chip(label, on, onclick, title, cls) {
    return h('button', { class: 'chip' + (on ? ' on' : '') + (cls ? ' ' + cls : ''), title: title || '', onclick }, label);
  }
  const arrow = m => App.metricInfo(m).higher ? '↑' : '↓';

  /* ------------------------------------------------------------ sidebar */
  function buildSide() {
    builtFor = App.ds;
    const ui = App.ui, D = App.D, ours = App.meta.ours;
    const base = D.methods.filter(m => m !== ours);
    const mnames = App.meta.metrics.map(m => m.name);
    const change = () => { App.save(); App.refresh(); };
    side.innerHTML = '';

    side.append(
      h('h3', null, 'Filter'),
      h('input', { type: 'search', placeholder: 'search image name…', value: ui.search, oninput: e => { ui.search = e.target.value; change(); } }),

      h('h4', null, `Baselines that ${ours} is compared against`),
      h('div', { class: 'chips', id: 'chips-comp' },
        base.map(m => chip(m, ui.comparators.includes(m), () => {
          const i = ui.comparators.indexOf(m); i >= 0 ? ui.comparators.splice(i, 1) : ui.comparators.push(m); syncChips(); change();
        })),
      ),
      h('div', { class: 'mini-actions' },
        h('a', { onclick: () => { ui.comparators = base.slice(); syncChips(); change(); } }, 'all'),
        h('a', { onclick: () => { ui.comparators = []; syncChips(); change(); } }, 'none')),

      h('h4', null, 'Score metrics', h('span', { class: 'hint' }, ' (used by composite score & #wins)')),
      h('div', { class: 'chips', id: 'chips-score' },
        mnames.map(m => chip(m + arrow(m), ui.scoreMetrics.includes(m), () => {
          const i = ui.scoreMetrics.indexOf(m); i >= 0 ? ui.scoreMetrics.splice(i, 1) : ui.scoreMetrics.push(m); syncChips(); change();
        }, App.metricInfo(m).ref ? 'reference-based' : 'no-reference'))),
      h('div', { class: 'mini-actions' },
        h('a', { onclick: () => { ui.scoreMetrics = mnames.slice(); syncChips(); change(); } }, 'all'),
        h('a', { onclick: () => { ui.scoreMetrics = fidelity.slice(); syncChips(); change(); }, title: 'PSNR SSIM FSIM LPIPS DISTS' }, 'fidelity (ref)'),
        h('a', { onclick: () => { ui.scoreMetrics = percept.slice(); syncChips(); change(); }, title: 'CLIPIQA NIQE MUSIQ MANIQA' }, 'perceptual (no-ref)')),

      h('h4', null, `Require ${ours} rank ≤ `,
        h('select', { id: 'sel-K', onchange: e => { ui.K = +e.target.value; change(); } },
          [1, 2, 3, 4, 5].map(k => h('option', { value: k, selected: ui.K === k }, k))),
        ' on:'),
      h('div', { class: 'chips', id: 'chips-req' },
        mnames.map(m => chip(m, ui.reqMetrics.includes(m), () => {
          const i = ui.reqMetrics.indexOf(m); i >= 0 ? ui.reqMetrics.splice(i, 1) : ui.reqMetrics.push(m); syncChips(); change();
        }, 'image must have rank ≤ K for this metric'))),
      h('div', { class: 'mini-actions' },
        h('a', { onclick: () => { ui.reqMetrics = []; syncChips(); change(); } }, 'clear'),
        h('a', { onclick: () => { ui.reqMetrics = ui.scoreMetrics.slice(); syncChips(); change(); } }, 'same as score')),

      h('h4', null, 'Min #metrics won ', h('b', { id: 'minwins-val' }, ui.minWins)),
      h('input', { type: 'range', min: 0, max: mnames.length, value: ui.minWins, oninput: e => { ui.minWins = +e.target.value; $('#minwins-val').textContent = ui.minWins; change(); } }),

      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ui.onlyPicked, onchange: e => { ui.onlyPicked = e.target.checked; change(); } }), ' only bookmarked / picked'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ui.hideRejected, onchange: e => { ui.hideRejected = e.target.checked; change(); } }), ' hide rejected (✕)'),

      h('h4', null, 'Sort by'),
      h('div', { class: 'row-flex' },
        sortSelect(),
        h('button', { class: 'btn', id: 'btn-dir', title: 'toggle direction', onclick: () => { ui.sortDir = ui.sortDir === 'asc' ? 'desc' : 'asc'; syncChips(); change(); } }, ui.sortDir === 'asc' ? '↑ asc' : '↓ desc')),
      h('p', { class: 'help' },
        h('b', null, 'Composite'), ' = mean over score metrics of (GRN-SR − best baseline) / typical spread between methods (sign-corrected, clipped to ±3). ',
        h('b', null, 'rank'), ' is among GRN-SR + selected baselines. Metrics that a method lacks (e.g. FSIM) are skipped. Click a column header to sort by that metric’s margin.'),
    );
  }

  function sortSelect() {
    const ui = App.ui, M = App.meta.metrics.map(m => m.name);
    const opt = (v, t) => h('option', { value: v, selected: ui.sortKey === v }, t);
    return h('select', { id: 'sel-sort', onchange: e => { ui.sortKey = e.target.value; App.save(); App.refresh(); } },
      h('optgroup', { label: 'Overall' }, opt('comp', 'Composite advantage'), opt('wins', '# metrics won'), opt('name', 'Image name')),
      h('optgroup', { label: 'Margin over best baseline' }, M.map(m => opt(`m:${m}:marg`, m + ' margin'))),
      h('optgroup', { label: 'GRN-SR raw value' }, M.map(m => opt(`m:${m}:val`, m + ' value'))),
      h('optgroup', { label: 'GRN-SR rank' }, M.map(m => opt(`m:${m}:rank`, m + ' rank'))));
  }

  function syncChips() {
    const ui = App.ui, D = App.D, ours = App.meta.ours;
    const base = D.methods.filter(m => m !== ours);
    const setOn = (id, names, labelFn, active) => $$('#' + id + ' .chip').forEach((c, i) => c.classList.toggle('on', active.includes(names[i])));
    setOn('chips-comp', base, null, ui.comparators);
    setOn('chips-score', App.meta.metrics.map(m => m.name), null, ui.scoreMetrics);
    setOn('chips-req', App.meta.metrics.map(m => m.name), null, ui.reqMetrics);
    const b = $('#btn-dir'); if (b) b.textContent = ui.sortDir === 'asc' ? '↑ asc' : '↓ desc';
    const s = $('#sel-sort'); if (s) s.value = ui.sortKey;
  }

  /* ------------------------------------------------------------ table */
  const COLS = () => `38px 92px minmax(120px,1.3fr) 64px 50px repeat(${App.meta.metrics.length}, minmax(76px,1fr))`;

  function buildHead() {
    const ui = App.ui;
    head.style.gridTemplateColumns = COLS();
    head.innerHTML = '';
    const sortMark = key => ui.sortKey === key ? (ui.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    const th = (txt, key, title) => h('div', { class: 'th' + (key ? ' sortable' : '') + (ui.sortKey === key ? ' sorted' : ''), title: title || '', onclick: key ? () => {
      if (ui.sortKey === key) ui.sortDir = ui.sortDir === 'asc' ? 'desc' : 'asc'; else { ui.sortKey = key; ui.sortDir = 'desc'; }
      App.save(); syncChips(); App.refresh();
    } : null }, txt + (key ? sortMark(key) : ''));
    head.append(th(''), th('HR'), th('Image', 'name'), th('Score', 'comp', 'composite advantage'), th('Wins', 'wins', '# score-metrics where GRN-SR is rank 1'));
    for (const m of App.meta.metrics) {
      const key = `m:${m.name}:marg`;
      const inReq = ui.reqMetrics.includes(m.name), inScore = ui.scoreMetrics.includes(m.name);
      const t = th(m.name + arrow(m.name), key, 'sort by margin over best baseline');
      t.classList.toggle('dimcol', !inScore); t.classList.toggle('reqcol', inReq);
      head.append(t);
    }
  }

  function rowHTML(i, top) {
    const D = App.D, R = App.analysis, ours = App.meta.ours, name = D.images[i];
    const picked = App.isPicked(D.name, name), rej = App.isRejected(D.name, name);
    let cells = '';
    for (const m of App.meta.metrics) {
      const mn = m.name, v = D.metrics[ours][mn][i], rank = R.rank[mn][i], mg = R.marg[mn][i];
      const cls = rank === 1 ? 'r1' : rank === 2 ? 'r2' : rank === 0 ? 'na' : 'rn';
      const dim = App.ui.scoreMetrics.includes(mn) ? '' : ' dim';
      cells += `<div class="c m ${cls}${dim}"><b>${App.fmt(mn, v)}</b>` +
        (rank ? `<small class="${mg > 0 ? 'pos' : 'neg'}">${Number.isNaN(mg) ? '' : App.fmtDelta(mn, mg) + ' '}#${rank}</small>` : '') + '</div>';
    }
    const comp = R.comp[i];
    return `<div class="row${picked ? ' picked' : ''}${rej ? ' rejected' : ''}" data-i="${i}" style="top:${top}px;grid-template-columns:${COLS()}">` +
      `<div class="c acts"><button data-act="pick" title="bookmark / un-bookmark">${picked ? '★' : '☆'}</button><button data-act="rej" title="reject (hide)">${rej ? '↺' : '✕'}</button></div>` +
      `<div class="c"><img loading="lazy" src="${App.thumbURL(D.name, 'HR', name, 160)}" width="84" height="64"></div>` +
      `<div class="c name" title="${esc(name)}">${esc(name)}</div>` +
      `<div class="c score ${comp > 0 ? 'pos' : 'neg'}">${Number.isNaN(comp) ? '–' : (comp >= 0 ? '+' : '') + comp.toFixed(2)}</div>` +
      `<div class="c wins">${R.wins[i]}/${App.ui.scoreMetrics.length}</div>` + cells + '</div>';
  }

  function renderRows() {
    const L = App.list, st = scroller.scrollTop, vh = scroller.clientHeight;
    const a = Math.max(0, Math.floor(st / ROW_H) - 3), b = Math.min(L.length, Math.ceil((st + vh) / ROW_H) + 3);
    let html = '';
    for (let k = a; k < b; k++) html += rowHTML(L[k], k * ROW_H);
    inner.style.height = L.length * ROW_H + 'px';
    inner.innerHTML = html;
  }

  function renderStatus() {
    const ui = App.ui, D = App.D;
    status.textContent = `${App.list.length} / ${D.images.length} images match  ·  sorted by ${ui.sortKey} (${ui.sortDir})  ·  baselines: ${App.analysis.comps.length}`;
  }

  /* ------------------------------------------------------------ lifecycle */
  function init() {
    root.innerHTML = '';
    side = h('aside', { class: 'side' });
    head = h('div', { class: 'thead' });
    status = h('div', { class: 'tstatus muted' });
    inner = h('div', { class: 'tinner' });
    scroller = h('div', { class: 'tscroll' }, inner);
    scroller.addEventListener('scroll', raf(renderRows));
    scroller.addEventListener('click', e => {
      const row = e.target.closest('.row'); if (!row) return;
      const i = +row.dataset.i, name = App.D.images[i], act = e.target.dataset.act;
      if (act === 'pick') {
        App.isPicked(App.D.name, name) ? App.removePick(App.D.name, name) : App.addPick(App.D.name, name, App.roiMemory[App.key(App.D.name, name)] || []);
        if (App.ui.onlyPicked) App.refresh(); else renderRows();
      } else if (act === 'rej') {
        App.toggleReject(App.D.name, name); App.refresh();
      } else {
        App.views.compare.open(App.D.name, name);
      }
    });
    root.append(side, h('div', { class: 'tablewrap' }, status, head, scroller));
  }

  function refresh() {
    if (!side) return;
    if (builtFor !== App.ds) buildSide();
    buildHead(); renderStatus(); scroller.scrollTop = Math.min(scroller.scrollTop, Math.max(0, App.list.length * ROW_H - scroller.clientHeight));
    renderRows();
  }

  return { init, refresh, enter() { renderRows(); } };
})();
