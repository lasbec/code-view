// This function is serialized into each snippet. Keep it free of module dependencies.
export function mountTreeMap(host, model) {
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host{display:flex;flex-direction:column;font:14px system-ui,sans-serif;color:#17212b}*{box-sizing:border-box}nav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px;flex-shrink:0}button{font:inherit;cursor:pointer}nav button{border:1px solid #aaa;border-radius:4px;background:#fff;padding:3px 7px}.map{flex:1 1 auto;position:relative;width:100%;height:var(--treemap-height,560px);min-height:100px;background:#f0f2f4;overflow:hidden}.tile{position:absolute;border:1px solid #fff;border-radius:0;color:#111;overflow:hidden;text-align:left;padding:4px;font-size:12px;text-shadow:0 1px 2px #ffffffb0}.tile.directory{padding:0 5px;line-height:22px;white-space:nowrap;text-overflow:ellipsis;font-weight:600}.tile:focus-visible{outline:3px solid #152dff;outline-offset:-3px;z-index:2}.legend{margin:6px 0 0;flex-shrink:0}.bar{height:10px;border:1px solid #555}.labels{position:relative;height:22px;font-size:11px}.labels span{position:absolute;transform:translateX(-50%);white-space:nowrap}.detail{flex:0 0 132px;height:132px;overflow-wrap:anywhere;padding:8px 10px;background:#f0f2f4;max-height:132px;overflow:auto;font-size:12px}.detail-path{display:block;margin-bottom:6px}.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px 20px}.detail h3{font-size:12px;margin:0 0 5px}.detail dl{display:grid;grid-template-columns:1fr auto;gap:3px 10px;margin:0}.detail dt,.detail dd{margin:0}.detail dd{font-variant-numeric:tabular-nums}.detail p{margin:2px 0}.detail table{width:100%;border-collapse:collapse;font-size:11px}.detail td{padding:2px 8px 2px 0}.detail td:last-child{text-align:right}.detail td small{display:block;font-size:10px}.detail small{color:#586779}.hint{margin:4px 0;color:#47505c;font-size:11px;flex-shrink:0}';
  root.append(style);
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Verzeichnispfad');
  const map = document.createElement('div'); map.className = 'map'; map.setAttribute('aria-label', 'Dateien nach Fläche und Heat-Score');
  const detail = document.createElement('div'); detail.className = 'detail'; detail.textContent = 'Datei berühren, fokussieren oder anklicken, um Kennzahlen zu sehen.';
  const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = `Fläche: ${model.areaMetric}. Verzeichnisse anklicken, um hineinzuzoomen.`;
  const legend = document.createElement('div'); legend.className = 'legend';
  const bar = document.createElement('div'); bar.className = 'bar';
  const labels = document.createElement('div'); labels.className = 'labels';
  const scale = model.legend;
  const percent = value => scale.max === scale.min ? 0 : 100 * (value - scale.min) / (scale.max - scale.min);
  bar.style.background = scale.max === scale.min ? 'rgb(34,160,70)' : `linear-gradient(to right,rgb(34,160,70),rgb(255,215,0) ${percent(scale.yellowFrom)}%,rgb(225,45,45) ${percent(scale.redFrom)}%,rgb(135,55,190))`;
  for (const [name, value] of [['Grün', scale.min], ['Gelb ab', scale.yellowFrom], ['Rot ab', scale.redFrom], ['Violett', scale.max]]) {
    if (scale.max === scale.min && name !== 'Grün') continue;
    const label = document.createElement('span'); label.style.left = `${percent(value)}%`; label.textContent = `${name}: ${Number(value.toPrecision(5))}`;
    if (value === scale.min) label.style.transform = 'none';
    else if (value === scale.max) label.style.transform = 'translateX(-100%)';
    labels.append(label);
  }
  legend.append(bar, labels); root.append(nav, hint, map, legend, detail);
  let trail = [model.tree], selectedFile = null;
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
      button.onclick = () => { selectedFile = null; trail = trail.slice(0, index + 1); draw(); }; nav.append(button);
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
      if (box.frame) { tile.classList.add('file-frame'); tile.style.border = `4px solid ${node.color}`; tile.style.display = 'flex'; tile.style.alignItems = 'flex-start'; }
      Object.assign(tile.style, { left: `${100 * box.x / width}%`, top: `${100 * box.y / height}%`, width: `${100 * box.width / width}%`, height: `${100 * box.height / height}%`, background: box.frame ? '#edf0f3' : node.color ?? '#c9d0d8' });
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
          draw();
        }
      };
      map.append(tile);
    }
    if (!layout.length) map.textContent = 'Keine darstellbaren Dateien.';
  }
  draw();
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => { if (host.isConnected) draw(); else observer.disconnect(); });
    observer.observe(host);
  }
}
