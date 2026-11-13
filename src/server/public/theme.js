const storageKey = 'code-view.theme';
const themes = [
  ['light', 'Light'], ['dark', 'Dark'], ['nord', 'Nord'],
  ['dracula', 'Dracula'], ['solarized', 'Solarized'],
];
const validTheme = value => themes.some(([id]) => id === value);

export function treemapThemeStyles() {
  const style = getComputedStyle(document.documentElement);
  return `:root{color-scheme:${style.colorScheme};${Array.from(style)
    .filter(name => name.startsWith('--cv-'))
    .map(name => `${name}:${style.getPropertyValue(name)};`).join('')}}`;
}

// Serialized into the sandboxed iframe, which cannot access localStorage.
export function receiveTreemapTheme() {
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'code-view-theme' || typeof event.data.styles !== 'string') return;
    document.querySelector('#theme-style').textContent = event.data.styles;
  });
}

export function initTheme() {
  const select = document.querySelector('#theme-select');
  select.replaceChildren(...themes.map(([id, label]) => {
    const option = document.createElement('option');
    option.value = id; option.textContent = label;
    return option;
  }));
  function apply(value) {
    const theme = validTheme(value) ? value : 'light';
    document.documentElement.dataset.theme = theme;
    select.value = theme;
    document.querySelector('#map iframe')?.contentWindow?.postMessage({ type: 'code-view-theme', styles: treemapThemeStyles() }, '*');
  }
  let saved;
  try { saved = localStorage.getItem(storageKey); } catch { /* Storage can be disabled. */ }
  apply(saved);
  select.addEventListener('change', () => {
    apply(select.value);
    try { localStorage.setItem(storageKey, select.value); } catch { /* Keep the theme usable for this visit. */ }
  });
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) apply(event.newValue);
  });
}
