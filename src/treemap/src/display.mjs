import { metricById, functionMetrics } from './catalog.mjs';

export function validateDisplay(config = {}) {
  const area = config.area ?? 'code_files.effective_lines';
  const functionArea = config.functionArea ?? 'code_functions.exclusive_size_bytes';
  if (!metricById.has(area) || !functionMetrics.has(functionArea)) throw new Error('Choose valid file and function area metrics.');
  const heat = config.heat ?? {};
  if (!heat || typeof heat !== 'object' || Array.isArray(heat) || Object.keys(heat).some(k => !['min','yellowFrom','redFrom','max'].includes(k)) || Object.values(heat).some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('Heat values must be finite numbers.');
  const stops = ['min','yellowFrom','redFrom','max'].map(k => heat[k]).filter(v => v !== undefined);
  if (!stops.every((v,i) => !i || v > stops[i-1])) throw new Error('Heat stops must increase.');
  return { area, functionArea, heat };
}
