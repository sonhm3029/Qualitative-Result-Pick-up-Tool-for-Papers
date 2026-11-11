'use strict';
/* Summary: dataset-level means + per-baseline win-rates of GRN-SR (sanity check against the paper table) */
App.views.summary = (function () {
  const root = $('#view-summary');
  let box, useFiltered = false;

  function init() { root.innerHTML = ''; box = h('div', { class: 'summary' }); root.append(box); }

  function render() {
    if (!box || !App.D) return;
    const D = App.D, M = App.meta.metrics, ours = App.meta.ours, base = D.methods.filter(m => m !== ours);
    const idxs = useFiltered ? App.list : D.images.map((_, i) => i);
    box.innerHTML = '';
    box.append(h('div', { class: 'row-flex' },
      h('h3', null, `${D.name} — ${idxs.length} images`),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: useFiltered, onchange: e => { useFiltered = e.target.checked; render(); } }), ' only images in current Browse filter')));

    // ---- means
    const mean = {};
    for (const me of D.methods) {
      mean[me] = {};
      for (const m of M) {
        let s = 0, n = 0; const a = D.metrics[me][m.name];
        for (const i of idxs) if (a[i] != null) { s += a[i]; n++; }
        mean[me][m.name] = n ? s / n : null;
      }
    }
    const best = {}, second = {};
    for (const m of M) {
      const v = D.methods.filter(me => mean[me][m.name] != null).sort((a, b) => m.higher ? mean[b][m.name] - mean[a][m.name] : mean[a][m.name] - mean[b][m.name]);
      best[m.name] = v[0]; second[m.name] = v[1];
    }
    box.append(h('h4', null, 'Mean metrics (best bold green, second underlined)'),
      h('table', { class: 'mtable big' },
        h('thead', null, h('tr', null, h('th'), M.map(m => h('th', null, m.name + (m.higher ? '↑' : '↓'))))),
        h('tbody', null, D.methods.map(me => h('tr', { class: me === ours ? 'ours' : '' }, h('td', { class: 'mname' }, me),
          M.map(m => h('td', { class: me === best[m.name] ? 'best' : me === second[m.name] ? 'second' : '' }, App.fmt(m.name, mean[me][m.name]))))))));

    // ---- win rate
    const wr = {};
    for (const b of base) {
      wr[b] = {};
      for (const m of M) {
        const o = D.metrics[ours][m.name], a = D.metrics[b][m.name]; let w = 0, n = 0;
        for (const i of idxs) if (o[i] != null && a[i] != null) { n++; if (m.higher ? o[i] > a[i] : o[i] < a[i]) w++; }
        wr[b][m.name] = n ? w / n : null;
      }
    }
    const cell = v => {
      if (v == null) return h('td', { class: 'na' }, 'n/a');
      const t = (v - 0.5) * 2, c = t >= 0 ? `rgba(60,180,100,${Math.min(.8, t * .8)})` : `rgba(220,70,70,${Math.min(.8, -t * .8)})`;
      return h('td', { style: { background: c } }, (v * 100).toFixed(0) + '%');
    };
    box.append(h('h4', null, `Win-rate: % of images where ${ours} beats each baseline`),
      h('table', { class: 'mtable big' },
        h('thead', null, h('tr', null, h('th'), M.map(m => h('th', null, m.name)))),
        h('tbody', null, base.map(b => h('tr', null, h('td', { class: 'mname' }, 'vs ' + b), M.map(m => cell(wr[b][m.name])))))));

    // ---- best-of-all rate
    const rate = {};
    for (const m of M) {
      let w = 0, n = 0;
      for (const i of idxs) {
        const o = D.metrics[ours][m.name][i]; if (o == null) continue;
        n++; let ok = true;
        for (const b of base) { const v = D.metrics[b][m.name][i]; if (v != null && (m.higher ? v >= o : v <= o)) { ok = false; break; } }
        if (ok) w++;
      }
      rate[m.name] = n ? w / n : null;
    }
    box.append(h('h4', null, `% of images where ${ours} is #1 among ALL methods`),
      h('table', { class: 'mtable big' },
        h('thead', null, h('tr', null, M.map(m => h('th', null, m.name)))),
        h('tbody', null, h('tr', null, M.map(m => cell(rate[m.name]))))),
      h('p', { class: 'help' }, 'Methods that lack a metric (e.g. FSIM) are skipped for that metric.'));
  }

  return { init, refresh() { if (App.current === 'summary') render(); }, enter: render };
})();
