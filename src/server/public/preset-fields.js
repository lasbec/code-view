import { metricCatalog, functionSizeMetrics, functionMetrics } from '../../treemap/src/catalog.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function metricSelect(label, name, value, catalog = metricCatalog) {
  const categories = [['Function metrics', entry => functionMetrics.has(entry.metric)], ['File metrics · Code', entry => !functionMetrics.has(entry.metric) && entry.metric.startsWith('code_')], ['File metrics · Git', entry => entry.metric.startsWith('git_')]];
  const groups = categories.map(([title, matches]) => {
    const entries = catalog.filter(matches);
    return entries.length ? `<optgroup label="${title}">${entries.map(entry => `<option value="${entry.metric}" ${entry.metric === value ? 'selected' : ''}>${esc(entry.label)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  return `<label>${label}<select name="${name}" required>${value ? '' : '<option value="">Choose a metric</option>'}${groups}</select></label>`;
}
export function functionAreaSelect(value) { return metricSelect('Function tile size', 'functionArea', value ?? 'code_functions.exclusive_size_bytes', functionSizeMetrics); }
