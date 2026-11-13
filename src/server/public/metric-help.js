import { metricCatalog } from '../../treemap/src/catalog.mjs';
export const metricHelp = metricCatalog.map(entry => ({
  ...entry, short: entry.description,
  long: `${entry.description} Default file aggregation: ${entry.aggregation}. Numeric measurements contribute only their excess above the threshold before file aggregation. Counts count qualifying events. Git metrics use imported history and commit-time filters; source metrics describe static sites, not executions.`,
  example: entry.counter ? 'With threshold 0, three associated events give count 3. No events give 0.' : 'Measurements 5, 12 and 20 with threshold 10 contribute 2 and 10: sum 12, maximum 10, count 2, or median 6.',
}));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function metricHelpHtml() {
  return `<div class="metric-help"><div class="help-toolbar"><h1>Help</h1><label class="help-search" for="metric-help-search">Search metrics<input id="metric-help-search" type="search" placeholder="Name, description or example" aria-controls="metric-help-list"></label><span id="metric-help-count" class="hint" role="status">${metricHelp.length} metrics</span></div>
    <details class="metric-guide"><summary>How metrics become a treemap</summary>
    <p>For each contribution: keep individual measurements strictly above the threshold, subtract the threshold, aggregate per file, then multiply by the weight. Contributions within a group are added.</p>
    <p>Choose sum, minimum, maximum, quantile or count for numeric measurements. Event counters count qualifying rows. Empty sets give 0. Quantiles use linear interpolation on sorted values: 0 is minimum, 50 median, 100 maximum.</p>
    <p>Each group is capped at its upper limit, even without normalization. A blank limit uses the largest raw group score among displayed files. Optional normalization divides the capped score by that limit and multiplies by 100. An all-zero group stays 0.</p>
    <p>Combine groups using sum, quantile, minimum, maximum or product. The result is not normalized again: two normalized groups can sum to 200 or multiply to 10,000. An explicit legend maximum takes precedence; otherwise the largest displayed final score is used.</p>
    <p>Area uses the catalog metric's default file aggregation without score thresholds. Files with nonpositive area are omitted before calculating automatic group limits and the legend. Missing numeric measurements do not enter score aggregates and produce a warning; no qualifying measurements give 0.</p>
    <p>Show functions temporarily subdivides files. The file border keeps its score. Function tiles use their own measurements and exclude file-only metrics; empty groups are omitted. Group limits and the legend are shared. Outside-function code stays neutral. Function tile sizing is configured separately in the preset and uses raw values without score thresholds. Older results require a new inspection.</p>
    <p>Only inspected source files appear. Git history is subject to import limits and date filters; renames are not followed. Reconstructed conflicts are not proof of historical conflicts or who resolved them. Possible mutations include conservative estimates. Function line spans include nested functions. Cognitive complexity follows the local analyzer rule.</p></details>
    <div id="metric-help-list">${[['Code metrics', 'code_'], ['Git metrics', 'git_']].map(([title, prefix]) => `<section class="metric-help-group"><h2>${title}</h2><div class="metric-help-entries">${metricHelp.filter(entry => entry.metric.startsWith(prefix)).map(entry => `<details class="metric-help-entry"><summary><span class="metric-help-summary"><strong>${esc(entry.label)}</strong><span>${esc(entry.short)}</span></span></summary><dl><div><dt>Calculation</dt><dd>${esc(entry.long)} <code>${esc(entry.metric)}</code></dd></div><div><dt>Example</dt><dd><pre>${esc(entry.example)}</pre></dd></div></dl></details>`).join('')}</div></section>`).join('')}</div><p id="metric-help-empty" hidden>No matching metrics.</p></div>`;
}

export function filterMetricHelp(view, query) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  let visible = 0;
  for (const entry of view.querySelectorAll('.metric-help-entry')) {
    const content = entry.textContent.toLowerCase();
    entry.hidden = !words.every(word => content.includes(word));
    if (!entry.hidden) visible++;
  }
  for (const group of view.querySelectorAll('.metric-help-group')) group.hidden = !group.querySelector('.metric-help-entry:not([hidden])');
  view.querySelector('#metric-help-count').textContent = `${visible} metrics`;
  view.querySelector('#metric-help-empty').hidden = visible !== 0;
}
