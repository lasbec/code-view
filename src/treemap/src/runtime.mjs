// This function is serialized into each snippet. Keep it free of module dependencies.
export function mountTreeMap(host, model) {
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host{display:flex;flex-direction:column;font:14px system-ui,sans-serif;color:var(--cv-text,#17212b)}*{box-sizing:border-box}nav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px;flex-shrink:0}button{font:inherit;cursor:pointer}nav button{border:1px solid var(--cv-input-border,#aaa);border-radius:4px;background:var(--cv-surface,#fff);color:var(--cv-text,#17212b);padding:3px 7px}.map{flex:1 1 auto;position:relative;width:100%;height:var(--treemap-height,560px);min-height:100px;background:var(--cv-subtle,#f0f2f4);overflow:hidden}.tile{position:absolute;border:1px solid var(--cv-heat-border,#fff);border-radius:0;color:var(--cv-heat-text,#111);overflow:hidden;text-align:left;padding:4px;font-size:12px;text-shadow:var(--cv-heat-label-shadow,0 1px 2px #ffffffb0)}.tile.file-frame{color:var(--cv-text,#17212b);text-shadow:none}.tile.directory{padding:0 5px;line-height:22px;white-space:nowrap;text-overflow:ellipsis;font-weight:600}.tile:focus-visible{outline:3px solid var(--cv-accent,#152dff);outline-offset:-3px;z-index:2}.legend{margin:6px 0 0;flex-shrink:0}.bar{height:10px;border:1px solid var(--cv-input-border,#555)}.labels{position:relative;height:22px;font-size:11px}.labels span{position:absolute;transform:translateX(-50%);white-space:nowrap}.detail{flex:0 0 132px;height:132px;overflow-wrap:anywhere;padding:8px 10px;background:var(--cv-subtle,#f0f2f4);max-height:132px;overflow:auto;font-size:12px}.detail-path{display:block;margin-bottom:6px}.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px 20px}.detail h3{font-size:12px;margin:0 0 5px}.detail dl{display:grid;grid-template-columns:1fr auto;gap:3px 10px;margin:0}.detail dt,.detail dd{margin:0}.detail dd{font-variant-numeric:tabular-nums}.detail p{margin:2px 0}.detail table{width:100%;border-collapse:collapse;font-size:11px}.detail td{padding:2px 8px 2px 0}.detail td:last-child{text-align:right}.detail td small{display:block;font-size:10px}.detail small{color:var(--cv-muted,#586779)}.hint{margin:4px 0;color:var(--cv-muted,#47505c);font-size:11px;flex-shrink:0}';
  root.append(style);
  style.textContent += '.heat-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 6px;font-size:11px}.heat-controls label{display:flex;align-items:center;gap:4px;white-space:nowrap}.heat-controls input{width:76px;min-width:0;padding:3px 5px;font:inherit;color:inherit;background:var(--cv-surface,#fff);border:1px solid var(--cv-input-border,#aaa);border-radius:4px}.heat-controls input:focus-visible{outline:2px solid var(--cv-accent,#152dff)}.heat-controls button{padding:3px 7px;font-size:11px;color:inherit;background:var(--cv-surface,#fff);border:1px solid var(--cv-input-border,#aaa);border-radius:4px}.heat-status{color:var(--cv-muted,#586779)}.heat-status.error{color:var(--cv-danger,#b00020)}';
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Verzeichnispfad');
  const map = document.createElement('div'); map.className = 'map'; map.setAttribute('aria-label', 'Dateien nach Fläche und Heat-Score');
  const detail = document.createElement('div'); detail.className = 'detail'; detail.textContent = 'Datei berühren, fokussieren oder anklicken, um Kennzahlen zu sehen.';
  const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = `Fläche: ${model.areaMetric}. Verzeichnisse anklicken, um hineinzuzoomen.`;
  const legend = document.createElement('div'); legend.className = 'legend';
  const bar = document.createElement('div'); bar.className = 'bar';
  const labels = document.createElement('div'); labels.className = 'labels';
  const scale = model.legend;
  let scaleChanged = false;
  let authorMode = false;
  const disabledAuthors = new Set();
  const neutralAuthorColor = '#aeb4bc';
  const authorId = node => node.mainAuthor?.id ?? '__unknown__';
  const percent = value => scale.max === scale.min ? 0 : 100 * (value - scale.min) / (scale.max - scale.min);
  // CSS variables keep the mounted map in sync with theme changes without rebuilding it.
  // Standalone snippets retain the colors calculated by the data API.
  const themedHeat = !!getComputedStyle(host).getPropertyValue('--cv-heat-green').trim();
  const heatStops = [
    [scale.min, 'var(--cv-heat-green,rgb(34,160,70))'],
    [scale.yellowFrom, 'var(--cv-heat-yellow,rgb(255,215,0))'],
    [scale.redFrom, 'var(--cv-heat-red,rgb(225,45,45))'],
    [scale.max, 'var(--cv-heat-violet,rgb(135,55,190))'],
  ];
  function heatColor(node) {
    if (authorMode) return disabledAuthors.has(authorId(node)) ? neutralAuthorColor : node.mainAuthor?.color ?? neutralAuthorColor;
    if (!themedHeat && !scaleChanged) return node.color ?? '#c9d0d8';
    if (node.heat == null) return 'var(--cv-heat-neutral,#c9d0d8)';
    const value = Math.max(scale.min, Math.min(scale.max, node.heat));
    if (!themedHeat) {
      const colors = [[34,160,70],[255,215,0],[225,45,45],[135,55,190]];
      if (scale.max === scale.min) return `rgb(${colors[0].join(',')})`;
      for (let i = 1; i < heatStops.length; i++) {
        if (value > heatStops[i][0]) continue;
        const ratio = (value - heatStops[i-1][0]) / (heatStops[i][0] - heatStops[i-1][0]);
        return `rgb(${colors[i-1].map((c,j) => Math.round(c+(colors[i][j]-c)*ratio)).join(',')})`;
      }
    }
    if (value === scale.min) return heatStops[0][1];
    for (let i = 1; i < heatStops.length; i++) {
      const [to, color] = heatStops[i], [from, previous] = heatStops[i - 1];
      if (value > to) continue;
      if (value === to) return color;
      const weight = 100 * (value - from) / (to - from);
      return `color-mix(in srgb, ${previous} ${100 - weight}%, ${color})`;
    }
    return heatStops.at(-1)[1];
  }
  function drawLegend() {
    if (authorMode) {
      labels.replaceChildren(); bar.style.background = 'none'; bar.style.height = 'auto';
      bar.replaceChildren();
      for (const author of [...(model.authors ?? []), { id: '__unknown__', name: 'Unknown author', color: neutralAuthorColor }]) {
        const entry = document.createElement('button'); entry.type = 'button';
        const active = !disabledAuthors.has(author.id);
        entry.setAttribute('aria-pressed', String(active));
        entry.title = active ? 'Autor ausblenden' : 'Autor einblenden';
        entry.style.cssText = 'display:inline-flex;align-items:center;margin:4px 8px 4px 0;padding:4px 7px;border:1px solid var(--cv-input-border,#777);border-radius:4px;background:var(--cv-surface,#fff);color:var(--cv-text,#17212b)';
        entry.onclick = () => {
          if (disabledAuthors.has(author.id)) disabledAuthors.delete(author.id); else disabledAuthors.add(author.id);
          drawLegend(); draw();
          [...bar.querySelectorAll('button')].find(button => button.dataset.author === author.id)?.focus();
        };
        entry.dataset.author = author.id;
        entry.style.textDecoration = active ? 'none' : 'line-through';
        const swatch = document.createElement('span'); swatch.style.cssText = `display:inline-block;width:12px;height:12px;margin-right:4px;background:${active ? author.color : neutralAuthorColor}`;
        entry.append(swatch, document.createTextNode(author.name)); bar.append(entry);
      }
      return;
    }
    bar.replaceChildren(); bar.style.height = '10px';
    [scale.min, scale.yellowFrom, scale.redFrom, scale.max].forEach((value,i) => { heatStops[i][0] = value; });
    labels.replaceChildren();
    bar.style.background = scale.max === scale.min ? heatStops[0][1] : `linear-gradient(to right,${heatStops[0][1]},${heatStops[1][1]} ${percent(scale.yellowFrom)}%,${heatStops[2][1]} ${percent(scale.redFrom)}%,${heatStops[3][1]})`;
    for (const [name, value] of [['Grün', scale.min], ['Gelb ab', scale.yellowFrom], ['Rot ab', scale.redFrom], ['Violett', scale.max]]) {
      if (scale.max === scale.min && name !== 'Grün') continue;
      const label = document.createElement('span'); label.style.left = `${percent(value)}%`; label.textContent = `${name}: ${Number(value.toPrecision(5))}`;
      if (value === scale.min) label.style.transform = 'none';
      else if (value === scale.max) label.style.transform = 'translateX(-100%)';
      labels.append(label);
    }
  }
  drawLegend();
  const controls = document.createElement('form'); controls.className = 'heat-controls'; controls.setAttribute('aria-label', 'Heat thresholds');
  const fields = new Map();
  controls.append(element('span', 'Heat'));
  for (const [key, name] of [['min','Min'],['yellowFrom','Yellow'],['redFrom','Red'],['max','Max']]) {
    const label = element('label', name), input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.step = 'any'; input.name = key;
    input.setAttribute('aria-label', `Heat ${name}`); input.title = 'Leave blank for automatic';
    input.value = model.heat?.[key] ?? ''; input.placeholder = String(Number(scale[key].toPrecision(5)));
    label.append(input); controls.append(label); fields.set(key, input);
  }
  const apply = element('button', 'Apply'); apply.type = 'submit';
  const auto = element('button', 'Auto'); auto.type = 'button'; auto.title = 'Calculate all thresholds automatically';
  const status = element('span', '', 'heat-status'); status.setAttribute('role', 'status');
  controls.append(apply, auto, status);
  controls.onsubmit = event => { event.preventDefault(); applyHeat(); };
  auto.onclick = () => { for (const input of fields.values()) input.value = ''; applyHeat(); };
  function applyHeat() {
    if (!controls.reportValidity()) return;
    const heat = {};
    for (const [key,input] of fields) if (input.value !== '') heat[key] = Number(input.value);
    const min = heat.min ?? 0, max = heat.max ?? model.observedMax ?? model.legend.max;
    const next = { min, max, yellowFrom: heat.yellowFrom ?? min+(max-min)/3, redFrom: heat.redFrom ?? min+2*(max-min)/3 };
    const zero = min === 0 && max === 0 && heat.max === undefined && heat.yellowFrom === undefined && heat.redFrom === undefined;
    if (!Object.values(next).every(v => Number.isFinite(v) && v >= 0) || (!zero && !(min < next.yellowFrom && next.yellowFrom < next.redFrom && next.redFrom < max))) {
      status.textContent = 'Use Min < Yellow < Red < Max.'; status.classList.add('error'); return;
    }
    Object.assign(scale, next); scaleChanged = true;
    for (const [key,input] of fields) input.placeholder = String(Number(scale[key].toPrecision(5)));
    drawLegend(); draw();
    status.classList.remove('error'); status.textContent = 'Applied';
    const message = { type: 'code-view-heat', heat };
    host.dispatchEvent(new CustomEvent(message.type, { detail: message, bubbles: true, composed: true }));
    if (window.parent !== window) {
      apply.disabled = auto.disabled = true; status.textContent = 'Saving…';
      window.parent.postMessage(message, '*');
    }
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'code-view-heat-result') return;
    apply.disabled = auto.disabled = false;
    status.textContent = event.data.error || 'Saved'; status.classList.toggle('error', !!event.data.error);
  });
  if (model.authors) {
    const colorLabel = element('label', 'Color by '), colorSelect = document.createElement('select');
    for (const [value,text] of [['score','Score'],['author','Main author']]) { const option = document.createElement('option'); option.value=value; option.textContent=text; colorSelect.append(option); }
    colorSelect.setAttribute('aria-label','Color by'); colorSelect.onchange=()=>{authorMode=colorSelect.value==='author';controls.hidden=authorMode;drawLegend();draw();};
    colorLabel.append(colorSelect); root.append(colorLabel);
  }
  legend.append(bar, labels); root.append(nav, hint, map, legend, controls, detail);
  let trail = [model.tree], selectedFile = null;
  function restorePath(path) {
    const next = [model.tree];
    let node = model.tree;
    while (node.path !== path) {
      const child = (node.children ?? []).find(child => child.children && (child.path === path || path.startsWith(child.path + '/')));
      if (!child) break;
      next.push(child); node = child;
    }
    trail = next; selectedFile = null; draw(); publishPath();
  }
  function publishPath() {
    const path = trail.at(-1).path || '';
    if (window.parent !== window) window.parent.postMessage({ type: 'code-view-path', path }, '*');
    else {
      const url = new URL(window.location.href);
      if (!['http:', 'https:', 'file:'].includes(url.protocol)) return;
      if (path) url.searchParams.set('treemapPath', path); else url.searchParams.delete('treemapPath');
      window.history.replaceState(window.history.state, '', url);
    }
  }
  window.addEventListener('message', event => {
    if (event.source === window.parent && event.data?.type === 'code-view-set-path' && typeof event.data.path === 'string') restorePath(event.data.path);
  });
  function describe(node) {
    if (node.children && node.kind !== 'file') return `${node.path || '/'}\nFläche: ${node.area}\nKlicken, um dieses Verzeichnis zu öffnen.`;
    const lines = [node.path, `Fläche (${model.areaMetric}): ${node.area}`, `Heat-Score: ${node.heat ?? 'No applicable function score'}`];
    for (const score of node.scores ?? []) {
      lines.push(`${score.name}: ${score.raw} → ${score.capped} (Grenze ${score.max}${score.normalize ? ', normalisiert auf 0–100' : ''}) → ${score.value}`);
      for (const term of score.contributions) lines.push(`  ${term.label}: ${term.aggregation}${term.aggregation === 'quantile' ? ` (${term.quantile}%)` : ''}, Schwellwert ${term.min}, ${term.matched} Treffer, Wert ${term.value}, Faktor ${term.factor} → ${term.contribution}`);
    }
    return lines.join('\n');
  }
  function element(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function showDetail(node) {
    detail.replaceChildren(element('strong', node.path || '/', 'detail-path'));
    const grid = element('div', undefined, 'detail-grid');
    const summary = element('section'); summary.append(element('h3', 'Kennzahlen'));
    const values = element('dl');
    for (const [name, value] of [['Fläche', node.area], ...(!node.children || node.kind === 'file' ? [['Heat-Score', node.heat ?? 'No applicable function score']] : [])]) {
      values.append(element('dt', name), element('dd', String(value)));
    }
    summary.append(values); grid.append(summary);
    if (node.authorship?.authors?.length) {
      const section = element('section'); section.append(element('h3', node.kind === 'function' ? 'Autorschaft · zugehörige Datei' : 'Autorschaft'));
      const list = element('dl');
      for (const author of node.authorship.authors) list.append(element('dt', author.name), element('dd', `${(author.share * 100).toFixed(1)}%`));
      section.append(list, element('small', node.authorship.basis === 'commits' ? 'Basis: Commits' : 'Basis: gewichtete Zeilenänderungen')); grid.append(section);
    }
    if (!node.children || node.kind === 'file') {
      if (node.kind === 'function') summary.append(element('p', `${node.name} · ${node.functionKind} · line ${node.line}:${node.column} · Size: ${node.sizeMetric}`));
      if (node.heat == null) summary.append(element('p', node.kind === 'outside' ? 'Outside functions' : 'No applicable function score'));
      for (const [field, count, title, hint] of (node.kind === 'function' || node.kind === 'outside' ? [] : [
        ['topAuthors', 'commits', 'Häufigste Autoren · Änderungscommits', 'Ohne Merges. Aus der gespeicherten, gefilterten Git-Historie.'],
        ['topMergeAuthors', 'merges', 'Häufigste Merge-Autoren · Merges', 'Übernahmen und mögliche Konfliktlösungen; kein Nachweis eigener Änderungen.'],
      ])) {
        const authors = element('section'); authors.append(element('h3', title));
        if (node[field]?.length) {
          const list = element('dl');
          for (const author of node[field]) {
            const name = element('dt', author.name || author.email || 'Unbekannt'); name.title = author.email || '';
            list.append(name, element('dd', String(author[count])));
          }
          authors.append(list);
        } else authors.append(element('p', node[field] == null ? 'Keine Git-Autorendaten verfügbar.' : 'Keine passenden Commits für diesen Dateipfad in der gespeicherten Historie.'));
        authors.append(element('small', hint));
        grid.append(authors);
      }
      for (const score of node.scores ?? []) {
        const section = element('section'); section.append(element('h3', `${score.name}: ${score.value}`), element('small', `Rohwert ${score.raw} · gedeckelt ${score.capped} · Grenze ${score.max}${score.normalize ? ' · normalisiert auf 0–100' : ''}`));
        const table = element('table');
        for (const term of score.contributions) {
          const row = element('tr');
          const metric = element('td', term.label); metric.title = `${term.aggregation}${term.aggregation === 'quantile' ? ` (${term.quantile}%)` : ''} · Schwellwert ${term.min} · ${term.matched} Treffer · Faktor ${term.factor}`;
          metric.append(element('small', metric.title));
          row.append(metric, element('td', `Raw ${term.rawValue} · excess ${term.value} → ${term.contribution}`)); table.append(row);
        }
        section.append(table); grid.append(section);
      }
    } else summary.append(element('p', 'Klicken, um dieses Verzeichnis zu öffnen.'));
    detail.append(grid);
  }
  // Balanced binary subdivision keeps each rectangle proportional to its area.
  function partition(nodes, x, y, width, height, output) {
    if (!nodes.length) return;
    if (nodes.length === 1) { output.push({ node: nodes[0], x, y, width, height }); return; }
    const total = nodes.reduce((sum, n) => sum + n.area, 0);
    let split = 1, left = nodes[0].area;
    while (split < nodes.length - 1 && Math.abs(total / 2 - left - nodes[split].area) < Math.abs(total / 2 - left)) left += nodes[split++].area;
    const ratio = left / total;
    if (width >= height) {
      partition(nodes.slice(0, split), x, y, width * ratio, height, output);
      partition(nodes.slice(split), x + width * ratio, y, width * (1 - ratio), height, output);
    } else {
      partition(nodes.slice(0, split), x, y, width, height * ratio, output);
      partition(nodes.slice(split), x, y + height * ratio, width, height * (1 - ratio), output);
    }
  }
  function draw() {
    map.replaceChildren(); nav.replaceChildren();
    trail.forEach((node, index) => {
      const button = document.createElement('button'); button.textContent = node.name; button.type = 'button';
      button.onclick = () => { selectedFile = null; trail = trail.slice(0, index + 1); draw(); publishPath(); }; nav.append(button);
    });
    const layout = [];
    const width = map.clientWidth || 800, height = map.clientHeight || 560;
    const focus = trail.at(-1);
    function nested(node, x, y, w, h, depth) {
      if (node.children) {
        const children = [];
        if (node.kind === 'file') {
          layout.push({ node, x, y, width: w, height: h, frame: true });
          const inset = Math.min(4, w / 8, h / 8), header = Math.min(24, h / 3);
          partition([...node.children].sort((a,b) => b.area-a.area), x+inset, y+header, Math.max(0,w-2*inset), Math.max(0,h-header-inset), children);
          for (const box of children) nested(box.node, box.x, box.y, box.width, box.height, depth+1);
          return;
        }
        const header = depth && w > 60 && h > 48 ? 24 : 0;
        partition([...node.children].sort((a, b) => b.area - a.area || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), x, y + header, w, Math.max(0, h - header), children);
        if (header) layout.push({ node, x, y, width: w, height: header });
        for (const box of children) nested(box.node, box.x, box.y, box.width, box.height, depth + 1);
      } else layout.push({ node, x, y, width: w, height: h });
    }
    nested(focus, 0, 0, width, height, 0);
    for (const box of layout) {
      const { node } = box;
      const tile = document.createElement('button'); tile.className = node.children ? 'tile directory' : 'tile'; tile.type = 'button';
      if (box.frame) { tile.classList.add('file-frame'); tile.style.border = `4px solid ${heatColor(node)}`; tile.style.display = 'flex'; tile.style.alignItems = 'flex-start'; }
      Object.assign(tile.style, { left: `${100 * box.x / width}%`, top: `${100 * box.y / height}%`, width: `${100 * box.width / width}%`, height: `${100 * box.height / height}%`, background: box.frame ? 'var(--cv-subtle,#edf0f3)' : heatColor(node) });
      if (authorMode && !node.children) {
        const color = heatColor(node);
        const rgb = /^#([0-9a-f]{6})$/i.exec(color);
        const luminance = rgb ? [0, 2, 4].map(i => parseInt(rgb[1].slice(i, i+2), 16) / 255).map(c => c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4).reduce((sum,c,i) => sum+c*[.2126,.7152,.0722][i], 0) : .5;
        tile.style.color = luminance > .179 ? '#111' : '#fff';
        tile.style.textShadow = 'none';
      }
      tile.textContent = `${node.name}${node.kind === 'function' ? ` (${node.line}:${node.column})` : node.children && node.kind !== 'file' ? '/' : ''}`;
      tile.title = describe(node); tile.setAttribute('aria-label', tile.title);
      tile.onmouseenter = () => { if (!selectedFile) showDetail(node); };
      tile.onfocus = () => { showDetail(node); };
      tile.onclick = () => {
        if (node.kind === 'file' || node.kind === 'function' || (!node.children && node.id && node.kind !== 'outside')) {
          const message = { type: 'code-view-inspect', kind: node.kind === 'function' ? 'function' : 'file', id: node.id };
          host.dispatchEvent(new CustomEvent('code-view-inspect', { detail: message, bubbles: true, composed: true }));
          if (window.parent !== window) { window.parent.postMessage(message, '*'); return; }
        }
        selectedFile = node.children ? null : node;
        showDetail(node);
        if (node.children) {
          function route(parent) {
            if (parent === node) return [parent];
            for (const child of parent.children ?? []) {
              if (!child.children) continue;
              const found = route(child);
              if (found) return [parent, ...found];
            }
          }
          trail.push(...route(focus).slice(1));
          draw(); publishPath();
        }
      };
      map.append(tile);
    }
    if (!layout.length) map.textContent = 'Keine darstellbaren Dateien.';
  }
  draw();
  if (window.parent === window && new URLSearchParams(window.location.search).has('treemapPath')) restorePath(new URLSearchParams(window.location.search).get('treemapPath'));
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => { if (host.isConnected) draw(); else observer.disconnect(); });
    observer.observe(host);
  }
}
