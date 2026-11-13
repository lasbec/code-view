// Data is disposable; preferences are persisted separately in this browser.
export function createDataCache(limit = 32) {
  const entries = new Map();
  return {
    clear() { entries.clear(); },
    async get(key, fetchValue) {
      let pending = entries.get(key);
      if (pending) entries.delete(key);
      else pending = Promise.resolve().then(fetchValue);
      entries.set(key, pending);
      if (entries.size > limit) entries.delete(entries.keys().next().value);
      try { return JSON.parse(JSON.stringify(await pending)); }
      catch (error) { if (entries.get(key) === pending) entries.delete(key); throw error; }
    },
  };
}
export function readPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem('code-view.settings.v1'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function savePreferences(value) {
  try { localStorage.setItem('code-view.settings.v1', JSON.stringify(value)); } catch { /* Storage may be unavailable. */ }
}
