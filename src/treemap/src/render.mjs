import { mountTreeMap } from './runtime.mjs';
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderTreeMap(result) {
  const messages = result.diagnostics ?? [];
  const treeMapWarningsHtml = `<section class="code-view-warnings" aria-label="Treemap-Meldungen"><h2>Treemap-Meldungen</h2>${messages.length ? messages.map(d => `<article><strong>${d.severity === 'error' ? 'Fehler' : 'Warnung'}</strong><p>${escapeHtml(d.message)}</p>${d.paths?.length ? `<details><summary>Betroffene Dateien (${d.paths.length})</summary><ul>${d.paths.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul></details>` : ''}</article>`).join('') : '<p>Keine Fehler oder Warnungen.</p>'}</section>`;
  let treeMapHtml;
  if (!result.ok) treeMapHtml = '<section class="code-view-treemap" role="alert">Treemap konnte nicht erstellt werden. Details stehen im Meldungs-Snippet.</section>';
  else {
    // Escape '<' to prevent database text from ending the inline script element.
    const json = JSON.stringify({ tree: result.tree, legend: result.legend, heat: result.heat, observedMax: result.observedMax, areaMetric: result.areaMetric }).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
    treeMapHtml = `<div class="code-view-treemap"></div><script>(${mountTreeMap.toString()})(document.currentScript.previousElementSibling,${json});</script>`;
  }
  return { treeMapHtml, treeMapWarningsHtml };
}
