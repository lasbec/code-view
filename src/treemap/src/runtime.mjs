// This function is serialized into each snippet. Keep it free of module dependencies.
export function mountTreeMap(host, model) {
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host{display:block;font:14px system-ui,sans-serif;color:#17212b}*{box-sizing:border-box}nav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}button{font:inherit;cursor:pointer}nav button{border:1px solid #aaa;border-radius:4px;background:#fff;padding:5px 9px}.map{position:relative;width:100%;height:560px;min-height:240px;background:#f0f2f4;overflow:hidden}.tile{position:absolute;border:1px solid #fff;border-radius:0;color:#111;overflow:hidden;text-align:left;padding:4px;font-size:12px;text-shadow:0 1px 2px #ffffffb0}.tile:focus-visible{outline:3px solid #152dff;outline-offset:-3px;z-index:2}.legend{margin:12px 0}.bar{height:16px;border:1px solid #555}.labels{position:relative;height:36px;font-size:12px}.labels span{position:absolute;transform:translateX(-50%);white-space:nowrap}.detail{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;background:#f0f2f4;max-height:260px;overflow:auto}.hint{margin:8px 0;color:#47505c}';
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
  let trail = [model.tree];
  function describe(node) {
    if (node.children) return `${node.path || '/'}\nFläche: ${node.area}\nKlicken, um dieses Verzeichnis zu öffnen.`;
    const lines = [node.path, `Fläche (${model.areaMetric}): ${node.area}`, `Heat-Score: ${node.heat}`];
    for (const score of node.scores) {
      lines.push(`${score.name}: ${score.value}`);
      for (const term of score.contributions) lines.push(`  ${term.metric}: Wert ${term.value}, Min ${term.min}, Max ${term.max ?? '∞'}, Faktor ${term.factor} → ${term.contribution}`);
    }
    return lines.join('\n');
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
      button.onclick = () => { trail = trail.slice(0, index + 1); draw(); }; nav.append(button);
    });
    const layout = [];
    const width = map.clientWidth || 800, height = map.clientHeight || 560;
    const focus = trail.at(-1);
    function nested(node, x, y, w, h, depth) {
      if (node.children) {
        const children = [];
        const header = depth && w > 60 && h > 40 ? 18 : 0;
        partition([...node.children].sort((a, b) => b.area - a.area || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), x, y + header, w, Math.max(0, h - header), children);
        if (header) layout.push({ node, x, y, width: w, height: header });
        for (const box of children) nested(box.node, box.x, box.y, box.width, box.height, depth + 1);
      } else layout.push({ node, x, y, width: w, height: h });
    }
    nested(focus, 0, 0, width, height, 0);
    for (const box of layout) {
      const { node } = box;
      const tile = document.createElement('button'); tile.className = 'tile'; tile.type = 'button';
      Object.assign(tile.style, { left: `${100 * box.x / width}%`, top: `${100 * box.y / height}%`, width: `${100 * box.width / width}%`, height: `${100 * box.height / height}%`, background: node.color ?? '#c9d0d8' });
      tile.textContent = `${node.name}${node.children ? '/' : ''}`;
      tile.title = describe(node); tile.setAttribute('aria-label', tile.title);
      tile.onmouseenter = tile.onfocus = () => { detail.textContent = describe(node); };
      tile.onclick = () => {
        detail.textContent = describe(node);
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
