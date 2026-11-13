import { metricCatalog, metricById, functionSizeMetrics } from '../../treemap/src/catalog.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const numeric = (label, name, value, placeholder, maximum = '') => `<label>${label}<input name="${name}" value="${esc(value)}" type="number" min="0" step="any" ${maximum ? `max="${maximum}"` : ''} placeholder="${placeholder}"></label>`;
const labels = { sum: 'Sum', count: 'Count above threshold', max: 'Maximum', min: 'Minimum', quantile: 'Quantile', product: 'Product' };
export function operationSelect(name, value, allowed) {
  return `<label>${name === 'aggregation' ? 'File aggregation' : 'Combine groups'}<select name="${name}">${allowed.map(id => `<option value="${id}" ${id === value ? 'selected' : ''}>${labels[id]}</option>`).join('')}</select></label>`;
}
export function metricSelect(label, name, value, catalog = metricCatalog) {
  return `<label>${label}<select name="${name}" required>${value ? '' : '<option value="">Choose a metric</option>'}${catalog.map(entry => `<option value="${entry.metric}" ${entry.metric === value ? 'selected' : ''}>${esc(entry.label)}</option>`).join('')}</select></label>`;
}
export function termHtml(term = {}) {
  const entry = metricById.get(term.metric), aggregation = term.aggregation ?? entry?.aggregation ?? 'sum';
  return `<div class="term">${metricSelect('Metric', 'metric', term.metric)}${operationSelect('aggregation', aggregation, entry?.aggregations ?? ['sum', 'max', 'min', 'quantile', 'count'])}${numeric('Threshold (per measurement)', 'min', term.min, '0')}<span class="quantile-field" ${aggregation === 'quantile' ? '' : 'hidden'}>${numeric('Quantile (0–100)', 'quantile', term.quantile, '50', '100')}</span>${numeric('Weight', 'factor', term.factor, '1')}<button type="button" data-action="remove-term" aria-label="Remove metric">Remove</button></div>`;
}
export function scoreHtml(score = { name: 'New score', normalize: true, metrics: [{}] }) {
  return `<section class="score"><div class="score-head"><label>Score name<input name="score-name" value="${esc(score.name)}" required></label>${numeric('Group upper limit', 'score-max', score.max, 'Largest displayed group score')}<label class="checkbox-label"><input type="checkbox" name="normalize" ${score.normalize !== false ? 'checked' : ''}>Normalize group to 0–100</label><button type="button" data-action="remove-score">Remove score</button></div><div class="terms">${score.metrics.map(termHtml).join('')}</div><button type="button" data-action="add-term">Add metric</button></section>`;
}
export function readScores(form) {
  return [...form.querySelectorAll('.score')].map(section => {
    const score = { name: section.querySelector('[name="score-name"]').value, normalize: section.querySelector('[name="normalize"]').checked,
      metrics: [...section.querySelectorAll('.term')].map(row => {
        const term = { metric: row.querySelector('[name="metric"]').value, aggregation: row.querySelector('[name="aggregation"]').value };
        for (const key of ['min', 'factor', 'quantile']) {
          const value = row.querySelector(`[name="${key}"]`).value;
          if (value !== '' && (key !== 'quantile' || term.aggregation === 'quantile')) term[key] = Number(value);
        }
        return term;
      }) };
    const max = section.querySelector('[name="score-max"]').value;
    if (max !== '') score.max = Number(max);
    return score;
  });
}
export function updateAggregation(row) {
  const entry = metricById.get(row.querySelector('[name="metric"]').value);
  const select = row.querySelector('[name="aggregation"]');
  const value = entry?.aggregation;
  select.outerHTML = operationSelect('aggregation', value, entry?.aggregations ?? ['sum']).match(/<select.*<\/select>/)[0];
  row.querySelector('.quantile-field').hidden = value !== 'quantile';
}

export function functionAreaSelect(value) { return metricSelect("Function tile size", "functionArea", value ?? "code_functions.exclusive_size_bytes", functionSizeMetrics); }
