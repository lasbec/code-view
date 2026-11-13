const check = (ok, message) => { if (!ok) throw Object.assign(new Error(message), { status: 400 }); };
export const defaultGraphPreset = () => ({ name: 'Coupling', config: { mode: 'clusters', level: 'file', relation: 'calls', include: [], exclude: [], resolution: 1, weighting: 'binary', directed: false, nested: true, targetSize: 20, maxDepth: 3, minGroup: 2, selfLoops: true } });
export function validateGraphPreset(value) {
  check(value && typeof value.name === 'string' && value.name.trim(), 'A graph preset name is required.');
  const c = { ...defaultGraphPreset().config, ...value.config };
  for (const [key, choices] of Object.entries({ mode: ['cycles', 'clusters'], level: ['file', 'function'], relation: ['imports', 'calls', 'references'], weighting: ['binary', 'count', 'log'] })) check(choices.includes(c[key]), `Invalid graph ${key}.`);
  check(c.level !== 'function' || c.relation !== 'imports', 'Imports require file level.');
  for (const key of ['directed', 'nested', 'selfLoops']) check(typeof c[key] === 'boolean', `Invalid ${key}.`);
  for (const [key, min, max] of [['resolution', .1, 5], ['targetSize', 2, 200], ['maxDepth', 1, 6], ['minGroup', 2, 100]]) check(Number.isFinite(c[key]) && c[key] >= min && c[key] <= max && (key === 'resolution' || Number.isInteger(c[key])), `Invalid ${key}.`);
  for (const key of ['include', 'exclude']) check(Array.isArray(c[key]) && c[key].length <= 100 && c[key].every(p => typeof p === 'string' && p.length > 0 && p.length <= 500), 'Invalid graph path patterns.');
  return { name: value.name.trim(), config: c };
}

