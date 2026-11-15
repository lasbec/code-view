import { detailHash } from './detail-view.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const functionFilters = [
  ['kind:FunctionDeclaration', 'Function'], ['kind:MethodDeclaration', 'Method'],
  ['kind:Constructor', 'Constructor'], ['kind:GetAccessor', 'Getter'], ['kind:SetAccessor', 'Setter'],
  ['kind:ArrowFunction', 'Arrow function'], ['kind:FunctionExpression', 'Function expression'],
  ['visibility:public', 'Public'], ['visibility:protected', 'Protected'], ['visibility:private', 'Private'],
  ['visibility:not_applicable', 'Visibility not applicable'], ['is_static', 'Static'], ['is_async', 'Async'],
  ['is_exported', 'Exported'], ['is_generator', 'Generator'],
];
const compareText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
export function selectRows(rows, state) {
  const search = state.search.trim().toLowerCase(), signature = state.signature.trim().toLowerCase();
  const filtered = rows.filter(row => (!search || `${row.name} ${row.path}`.toLowerCase().includes(search)) &&
    (!signature || row.signature?.toLowerCase().includes(signature)) &&
    (!state.filters.length || state.filters.some(filter => {
      const [key, value] = filter.split(':');
      return value === undefined ? row[key] === 1 : row[key] === value;
    })));
  return filtered.sort((a, b) => {
    const av = a[state.sort], bv = b[state.sort];
    if (av == null && bv != null) return 1;
    if (bv == null && av != null) return -1;
    const primary = av == null ? 0 : typeof av === 'number' ? av - bv : compareText(av, bv);
    return primary * state.direction || compareText(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || compareText(a.id, b.id);
  });
}
const states = new Map();
let cacheKey, cachePromise;
export function clearListDataCache() { cacheKey = undefined; cachePromise = undefined; }
export async function mountInspectionList(host, { kind, inspection, preset, api, openDetail }) {
  const key = JSON.stringify([inspection.id, inspection.result, preset]);
  if (cacheKey !== key) {
    cacheKey = key;
    cachePromise = api(`list?${new URLSearchParams({ inspection: inspection.id, preset: preset.id })}`).catch(error => { if (cacheKey === key) cacheKey = null; throw error; });
  }
  const stateKey = `${inspection.id}:${preset.id}:${kind}`;
  if (!states.has(stateKey)) states.set(stateKey, { search: '', signature: '', filters: [], sort: 'score', direction: -1, page: 0, scroll: 0 });
  const state = states.get(stateKey);
  host.textContent = 'Loading inspection…';
  try {
    const data = await cachePromise;
    if (!host.isConnected) return;
    const functions = kind === 'function', rows = functions ? data.functions : data.files, pageSize = 100;
    const columns = [['name', functions ? 'Function' : 'File'], ...(functions ? [['path', 'File : line']] : []), ['score', 'Score'], ['total_lines', 'Lines'], ...(functions ? [['call_depth', 'Up +2 call depth (internal)'], ['down_call_depth', 'Down call depth (internal)'], ['reachable_internal_count', 'Reachable functions'], ['reachable_external_count', 'Reachable external'], ['reachable_symbol_count', 'Reachable total'], ['direct_external_count', 'Direct external']] : []), ...(!functions ? [['function_count', 'Functions']] : []), ['complexity', functions ? 'Complexity' : 'Complexity ∑'], ['definite', 'Definite mutations'], ['possible', 'Possible mutations']];
    host.innerHTML = `<div class="list-search"><label>Name / path<input type="search" data-list-search placeholder="Search ${functions ? 'functions' : 'files'}…" value="${esc(state.search)}"></label>${functions ? `<label>Signature<input type="search" data-list-signature placeholder="Search signatures…" value="${esc(state.signature)}"></label><details class="list-filters"><summary>Filters <span data-filter-count></span></summary><p class="hint">Match any selected option (OR)</p><div class="filter-options">${functionFilters.map(([value, label]) => `<label><input type="checkbox" value="${value}" ${state.filters.includes(value) ? 'checked' : ''} ${!data.traitsAvailable && !value.startsWith('kind:') ? 'disabled' : ''}>${label}</label>`).join('')}</div></details>` : ''}</div>${functions && !data.traitsAvailable ? '<p class="inspect-warning">Run inspection again to enable visibility, static, async, exported and generator filters.</p>' : ''}<div class="filter-chips"></div><div class="list-summary"><span data-result-count aria-live="polite"></span><span class="hint">Scores use the selected score and filter · search preserves scores</span></div><div class="list-table-wrap"><table class="inspection-table"><thead><tr>${columns.map(([key, label]) => `<th scope="col" data-column="${key}"><button type="button" data-sort="${key}">${label}<span></span></button></th>`).join('')}</tr></thead><tbody></tbody></table></div><div class="list-pagination"><button type="button" data-page="-1">Previous</button><span data-page-count></span><button type="button" data-page="1">Next</button></div>`;
    const externals = document.createElement('details');
    externals.className = 'inspect-section';
    externals.innerHTML = `<summary>External symbols · repository <span>${data.externalSymbols?.length ?? 0}</span></summary><input type="search" aria-label="Search external symbols" placeholder="Search external symbols…"><div data-external-results></div>`;
    host.prepend(externals);
    function drawExternals() {
      const search = externals.querySelector('input').value.toLowerCase();
      const symbols = (data.externalSymbols ?? []).filter(s => s.name.toLowerCase().includes(search));
      externals.querySelector('[data-external-results]').innerHTML = symbols.map(s => `<details><summary><code>${esc(s.name)}</code> · ${esc(s.kind)} · ${s.references.length} references</summary>${s.references.map(r => `<p><a href="${esc(detailHash('file', r.file_id, { inspection: inspection.id, preset: preset.id, line: r.line, from: functions ? 'functions' : 'files' }))}">${esc(r.file_id)}:${r.line}</a> · <code>${esc(r.alias)}</code> · ${esc(r.kind)}</p>`).join('')}</details>`).join('') || '<p>No external symbols found. Older inspections require a new run.</p>';
    }
    externals.querySelector('input').oninput = drawExternals; drawExternals();
    function draw() {
      const selected = selectRows(rows, state);
      const pages = Math.max(1, Math.ceil(selected.length / pageSize));
      state.page = Math.max(0, Math.min(state.page, pages - 1));
      host.querySelector('[data-result-count]').textContent = `${selected.length.toLocaleString()} / ${rows.length.toLocaleString()} ${functions ? 'functions' : 'files'}`;
      host.querySelector('tbody').innerHTML = selected.slice(state.page * pageSize, (state.page + 1) * pageSize).map(row => {
        const href = detailHash(kind, row.id, { inspection: inspection.id, preset: preset.id, showFunctions: 'true', listContext: 'true', from: functions ? 'functions' : 'files' });
        return `<tr data-item="${esc(row.id)}">${columns.map(([key]) => `<td${['name', 'path'].includes(key) ? '' : ' class="numeric"'}>${key === 'name' ? `<a href="${esc(href)}">${esc(row.name)}</a>${!functions ? `<small>${esc(row.path)}</small>` : ''}` : key === 'path' ? `<span title="${esc(row.path)}">${esc(row.path)}:${row.line}</span>` : key === 'score' ? row.score == null ? `<span class="muted" title="${esc(row.error || 'No score')}">–${row.error ? ' ⚠' : ''}</span>` : esc(Number(row.score.toFixed(2))) : esc(row[key] == null ? '—' : `${(row[['call_depth', 'reachable_internal_count'].includes(key) ? 'call_graph_complete' : key === 'direct_external_count' ? 'direct_external_complete' : 'dependency_complete'] ?? row.dependency_complete) === 0 && ['call_depth', 'reachable_internal_count', 'reachable_external_count', 'reachable_symbol_count', 'direct_external_count'].includes(key) ? '≥ ' : ''}${row[key]}`)}</td>`).join('')}</tr>`;
      }).join('') || `<tr><td colspan="${columns.length}" class="list-empty">${rows.length ? 'No matching items. Try changing the searches or filters.' : 'No inspected items.'}</td></tr>`;
      host.querySelectorAll('[data-sort]').forEach(button => {
        const active = button.dataset.sort === state.sort;
        button.closest('th').setAttribute('aria-sort', active ? state.direction === 1 ? 'ascending' : 'descending' : 'none');
        button.querySelector('span').textContent = active ? state.direction === 1 ? ' ↑' : ' ↓' : '';
      });
      host.querySelector('[data-page-count]').textContent = `Page ${state.page + 1} of ${pages}`;
      host.querySelector('[data-page="-1"]').disabled = state.page === 0;
      host.querySelector('[data-page="1"]').disabled = state.page >= pages - 1;
      const count = host.querySelector('[data-filter-count]'); if (count) count.textContent = state.filters.length ? `(${state.filters.length})` : '';
      host.querySelector('.filter-chips').innerHTML = state.filters.map(value => `<button type="button" data-remove-filter="${value}">${esc(functionFilters.find(f => f[0] === value)?.[1])} ×</button>`).join('') + (state.filters.length ? '<button type="button" data-clear-filters>Clear filters</button>' : '');
    }
    host.querySelector('[data-list-search]').oninput = event => { state.search = event.target.value; state.page = 0; draw(); };
    const signature = host.querySelector('[data-list-signature]');
    if (signature) signature.oninput = event => { state.signature = event.target.value; state.page = 0; draw(); };
    host.onchange = event => {
      if (!event.target.matches('.filter-options input')) return;
      state.filters = [...host.querySelectorAll('.filter-options input:checked')].map(input => input.value);
      state.page = 0; draw();
    };
    host.onclick = event => {
      const sort = event.target.closest('[data-sort]');
      if (sort) { state.direction = state.sort === sort.dataset.sort ? -state.direction : ['name', 'path'].includes(sort.dataset.sort) ? 1 : -1; state.sort = sort.dataset.sort; state.page = 0; draw(); return; }
      const page = event.target.closest('[data-page]');
      if (page) { state.page += Number(page.dataset.page); draw(); return; }
      const remove = event.target.closest('[data-remove-filter]'), clear = event.target.closest('[data-clear-filters]');
      if (remove || clear) {
        state.filters = clear ? [] : state.filters.filter(value => value !== remove.dataset.removeFilter);
        host.querySelectorAll('.filter-options input').forEach(input => { input.checked = state.filters.includes(input.value); });
        state.page = 0; draw(); return;
      }
      const link = event.target.closest('tbody a');
      const row = event.target.closest('tbody tr[data-item]');
      if (!row || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); state.scroll = window.scrollY;
      openDetail((link ?? row.querySelector('a')).getAttribute('href'));
    };
    draw(); window.scrollTo?.(0, state.scroll);
  } catch (error) { if (host.isConnected) host.textContent = `Unable to load inspection list: ${error.message}`; }
}
