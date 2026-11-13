export { calculateTreeMap, listMetrics, colorFor } from './data.mjs';
export { renderTreeMap } from './render.mjs';
import { calculateTreeMap } from './data.mjs';
import { renderTreeMap } from './render.mjs';

export async function createTreeMap(bytes, config, options = {}) {
  return renderTreeMap(await calculateTreeMap(bytes, config, options));
}
