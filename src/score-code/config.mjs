import { defaultName } from './formulas.mjs';
export function validateDefinition(config) {
  if (!config || Object.keys(config).some(k => k !== 'fields') || !Array.isArray(config.fields) || !config.fields.length) throw new Error('Add at least one function or file metric.');
  const ids = new Set();
  return { fields: config.fields.map((field, index) => {
    if (!field || Object.keys(field).some(k => !['id','kind','name','autoName','code','aggregation'].includes(k)) || !['function', 'file'].includes(field.kind) || typeof field.code !== 'string') throw new Error('Each metric needs a scope and JavaScript code.');
    if (field.name !== undefined && typeof field.name !== 'string' || field.autoName !== undefined && typeof field.autoName !== 'boolean') throw new Error('Invalid contribution name.');
    const autoName = field.autoName ?? !field.name?.trim();
    const id = field.id ?? `field-${index + 1}`;
    if (typeof id !== 'string' || !id.trim() || ids.has(id)) throw new Error('Metric field IDs must be unique.');
    ids.add(id);
    if (field.kind === 'function' && field.aggregation !== undefined && typeof field.aggregation !== 'string') throw new Error('File aggregation must be JavaScript code.');
    return { id, kind: field.kind, code: field.code, name: autoName ? defaultName(field.code, field.kind) : typeof field.name === 'string' && field.name.trim() || defaultName(field.code, field.kind), autoName,
      ...(field.kind === 'function' ? { aggregation: field.aggregation ?? 'sum(scores)' } : {}) };
  }) };
}
export const defaultDefinition = () => ({ fields: [{ id: 'complexity', kind: 'function', name: 'Cyclomatic complexity', autoName: true, code: 'metrics.cyclomatic_complexity', aggregation: 'sum(scores)' }] });
