import { metricById, functionMetrics } from './catalog.mjs';
export const operations = ['sum', 'quantile', 'min', 'max', 'product'];
export function aggregate(values, operation, quantile = 50) {
  if (!values.length) return 0;
  if (operation === 'count') return values.length;
  if (operation === 'sum') return values.reduce((a, b) => a + b, 0);
  if (operation === 'product') return values.reduce((a, b) => a * b, 1);
  if (operation === 'min') return values.reduce((a, b) => Math.min(a, b), Infinity);
  if (operation === 'max') return values.reduce((a, b) => Math.max(a, b), -Infinity);
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * quantile / 100;
  const index = Math.floor(position), fraction = position - index;
  return sorted[index] + (sorted[Math.min(index + 1, sorted.length - 1)] - sorted[index]) * fraction;
}
const fail = message => { throw new Error(message); };
const object = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`Invalid ${label}.`);
};
const number = (value, label, maximum = Infinity) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) fail(`Invalid ${label}.`);
  return value;
};
export function validateConfig(config, catalog = metricById) {
  object(config, ['area', 'scores', 'heat', 'operation', 'quantile', 'functionArea'], 'treemap configuration');
  const metric = id => { if (!catalog.has(id)) fail(`Unknown metric "${id}".`); return id; };
  const area = metric(config.area ?? 'code_files.size_bytes');
  const functionArea = config.functionArea ?? 'code_functions.exclusive_size_bytes';
  if (!functionMetrics.has(functionArea)) fail('Invalid function size metric.');
  const operation = config.operation ?? 'sum';
  if (!operations.includes(operation)) fail('Invalid group operation.');
  const quantile = number(config.quantile ?? 50, 'group quantile', 100);
  if (!Array.isArray(config.scores) || config.scores.length < 1 || config.scores.length > 3) fail('Use one to three score groups.');
  const scores = config.scores.map((score, index) => {
    object(score, ['name', 'metrics', 'normalize', 'max'], 'score group');
    if (score.name !== undefined && (typeof score.name !== 'string' || !score.name.trim())) fail('A score name is required.');
    if (score.normalize !== undefined && typeof score.normalize !== 'boolean') fail('Normalize must be a boolean.');
    if (score.max !== undefined && number(score.max, 'group maximum') === 0) fail('Group maximum must be positive.');
    if (!Array.isArray(score.metrics) || !score.metrics.length) fail('Each group needs a metric.');
    return { name: score.name ?? `Score ${index + 1}`, normalize: score.normalize ?? true, max: score.max, metrics: score.metrics.map(term => {
      object(term, ['metric', 'min', 'factor', 'aggregation', 'quantile'], 'metric contribution');
      const id = metric(term.metric), entry = metricById.get(id);
      const aggregation = term.aggregation ?? entry.aggregation;
      if (!entry.aggregations.includes(aggregation)) fail(`Invalid aggregation for ${id}.`);
      return { metric: id, min: number(term.min ?? 0, 'threshold'), factor: number(term.factor ?? 1, 'weight'), aggregation, quantile: number(term.quantile ?? 50, 'metric quantile', 100) };
    }) };
  });
  const heat = config.heat ?? {};
  object(heat, ['min', 'max', 'yellowFrom', 'redFrom'], 'heat options');
  for (const value of Object.values(heat)) number(value, 'heat value');
  const stops = [heat.min ?? 0, heat.yellowFrom, heat.redFrom, heat.max].filter(v => v !== undefined);
  if (!stops.every((v, i) => i === 0 || v > stops[i - 1])) fail('Heat stops must increase.');
  return { area, functionArea, scores, heat, operation, quantile };
}

export function scoreMeasurements(score, getValues, applicable = () => true) {
  const contributions = score.metrics.filter(term => applicable(term.metric)).map(term => {
    const values = getValues(term.metric);
    const excess = values.filter(value => value > term.min).map(value => value - term.min);
    const value = aggregate(excess, term.aggregation, term.quantile);
    return { ...term, label: metricById.get(term.metric).label, rawValue: aggregate(values, term.aggregation, term.quantile), value, matched: excess.length, contribution: value * term.factor };
  });
  const raw = contributions.reduce((sum, term) => sum + term.contribution, 0);
  if (!Number.isFinite(raw)) throw new Error('Score overflow; reduce weights.');
  return { name: score.name, raw, contributions };
}
