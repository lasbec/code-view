import { createDataCache, readPreferences, savePreferences } from './frontend-state.js';
import { mountDevelopers } from './developers-view.js';
import { mountGraph } from './graph-view.js';
import { mountInspectionList, clearListDataCache } from './list-view.js';
import { showDetailRoute, closeDetail, detailHash } from './detail-view.js';
import { metricSelect, functionAreaSelect } from './preset-fields.js';
import { formulaField, readFields, mountScoreEditors, destroyScoreEditors, confirmSyntax } from './score-fields.js';
import { progressHtml } from './progress-view.js';
import { metricHelpHtml, filterMetricHelp } from './metric-help.js';
import { initTheme, treemapThemeStyles, receiveTreemapTheme } from './theme.js';
initTheme();
const view = document.querySelector('#view');
const preferences = readPreferences(), dataCache = createDataCache();
let showFunctions = preferences.showFunctions === true, showDirectories = preferences.showDirectories !== false, colorByAuthor = preferences.colorByAuthor === true;
let dataContext = '';
function saveViewPreferences() {
  Object.assign(preferences, { showFunctions, showDirectories, colorByAuthor }); savePreferences(preferences);
}
const preferenceKey = () => JSON.stringify([selectedInspection()?.id, selectedPreset()?.id, selectedFilter()?.id, selectedTreemap()?.id]);
function clearDataCaches() { dataCache.clear(); clearListDataCache(); }

let state, metrics = [], newInspection = false, newPreset = false, newSettings = false, treeKey = '', listKey = '', requestNumber = 0;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const route = () => location.hash.slice(1) || 'treemap';
const lines = text => text.split('\n').map(s => s.trim()).filter(Boolean);
const selectedInspection = () => state.inspections.find(c => c.id === state.selection.inspection) ?? state.inspections[0];
const selectedPreset = () => state.presets.find(c => c.id === state.selection.preset) ?? state.presets[0];
const selectedFilter = () => state.filters.find(c => c.id === state.selection.filter) ?? state.filters[0];
const selectedTreemap = () => state.treemaps.find(c => c.id === state.selection.treemap) ?? state.treemaps[0];
const defaultPreset = () => ({ name: '', config: { fields: [{ id: crypto.randomUUID(), kind: 'function', name: 'Cyclomatic complexity', autoName: true, code: 'metrics.cyclomatic_complexity', aggregation: 'sum(scores)' }] } });
function notice(error) { const n = document.querySelector('#notice'); n.textContent = error?.message ?? error ?? ''; n.hidden = !error; }
async function api(path, method = 'GET', data) {
  const fetchValue = async () => {
    const response = await fetch(`/api/${path}`, { method, ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
    const value = await response.json();
    if (!response.ok || value.error) throw new Error(value.error || 'Request failed.');
    return value;
  };
  if (method === 'GET' && /^(treemap|list|developers|detail|graph)\?/.test(path)) return dataCache.get(`${dataContext}:${path}`, fetchValue);
  const value = await fetchValue();
  if (method !== 'GET' && !['selection','score/editor'].includes(path)) clearDataCaches();
  return value;
}
async function load() {
  state = await api('state');
  const context = JSON.stringify([state.inspections, state.presets, state.filters, state.treemaps, state.selection?.filter, state.selection?.treemap, state.developerPresets, state.graphPresets, state.selection?.developerPreset]);
  if (context !== dataContext) { dataContext = context; clearDataCaches(); }
}
document.querySelector('#reload-data').onclick = async event => {
  const button = event.currentTarget; button.disabled = true; notice(null);
  clearDataCaches(); requestNumber++;
  try { await load(); closeDetail(); treeKey = listKey = ''; render(); }
  catch (error) { notice(error); }
  finally { button.disabled = false; }
};
const options = (items, id) => items.map(c => `<option value="${esc(c.id)}" ${c.id === id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
const heading = (title, text) => `<div class="page-heading"><h1>${title}</h1><p class="muted">${text}</p></div>`;
const input = (label, name, value, extra = '') => `<label>${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`;
const patterns = (label, name, values = []) => `<label>${label}<textarea name="${name}" placeholder="One pattern per line">${esc(values.join('\n'))}</textarea></label>`;
function selection(collection, id, label, key) { return `<label>${label}<select data-select="${key}">${options(collection, id)}</select></label>`; }
function authorIdentityHtml(identity = {}) {
  return `<div class="row author-identity">${input('Name', 'author-name', identity.name, 'required')}${input('Primary email', 'author-email', identity.email, 'type="email" required')}${input('Other emails, separated by commas', 'author-aliases', (identity.aliases ?? []).join(', '))}<button type="button" data-action="remove-author">Remove author</button></div>`;
}
function render() {
  destroyScoreEditors();
  if (route().startsWith('detail?')) { showDetailRoute(api); return; }
  const hadDetail = !!document.querySelector('#detail-view');
  closeDetail();
  if (hadDetail && listKey === currentTreeKey() && ['files', 'functions'].includes(route()) && view.querySelector(`[data-list-route="${route()}"]`)) return;
  if (hadDetail && route() === 'graph' && view.querySelector('.graph-workspace')) return;
  if (hadDetail && route() === 'treemap' && document.querySelector('#map iframe')) return;
  document.body.classList.toggle('graph-page', ['graph', 'developers'].includes(route()));
  document.body.classList.toggle('treemap-page', route() === 'treemap');
  requestNumber++;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.hash === `#${route()}`));
  if (route() === 'inspections') inspectionView();
  else if (route() === 'presets') presetView();
  else if (['filters','treemap-settings'].includes(route())) settingsView();
  else if (['files', 'functions'].includes(route())) listView();
  else if (route() === 'developers') { listKey = currentTreeKey(); view.innerHTML = ''; mountDevelopers(view, { state, api, reload: load }); }
  else if (route() === 'graph') {
    listKey = currentTreeKey();
    view.innerHTML = '';
    mountGraph(view, { state, api, reload: load, openDetail: (kind, id, line) => {
      const p = selectedPreset();
      if (!p) { notice('Create a scoring preset to inspect source details.'); return; }
      history.pushState({ inspector: true }, '', detailHash(kind, id, { inspection: selectedInspection()?.id, preset: p.id, from: 'graph', listContext: 'true', ...(line ? { line } : {}) })); render();
    } });
  }
  else if (route() === 'help') view.innerHTML = metricHelpHtml(metrics);
  else treemapView();
  const toolbar = view.querySelector('.toolbar');
  document.querySelector('#configuration-bar').replaceChildren(...(toolbar ? [toolbar] : []));
  updateProgress();
}
function listView() {
  listKey = currentTreeKey();
  const c = selectedInspection(), p = selectedPreset(), functions = route() === 'functions';
  view.innerHTML = `<div class="card toolbar">${selection(state.inspections, c?.id, 'Inspection', 'inspection')}${selection(state.presets, p?.id, 'Score', 'preset')}${selection(state.filters, selectedFilter()?.id, 'Filter', 'filter')}</div><div class="list-heading"><h1>${functions ? 'Functions' : 'Files'}</h1><p class="hint">All inspected ${functions ? 'functions' : 'files'}</p></div><section data-list-route="${route()}"></section>`;
  const host = view.querySelector('[data-list-route]');
  if (!c?.hasResults || !p) { host.innerHTML = '<p class="muted">Choose an inspection with results and a scoring preset.</p>'; return; }
  mountInspectionList(host, { kind: functions ? 'function' : 'file', inspection: c, preset: p, api,
    openDetail: hash => { history.pushState({ inspector: true }, '', hash); render(); } });
}
function inspectionView() {
  const c = !newInspection && selectedInspection() || { name: '', repository: '', tsconfig: 'tsconfig.json', include: [], exclude: [], commits: null };
  view.innerHTML = heading('Inspection configuration', 'Code and Git inspect this repository independently. Save changes before starting a new run.') +
    `<div class="card toolbar">${selection(state.inspections, c.id, 'Saved inspection', 'inspection')}<button data-action="new-inspection">New configuration</button></div>
    <form id="inspection-form" class="card" data-id="${esc(c.id)}"><fieldset><h2>${c.id ? 'Repository settings' : 'New inspection'}</h2>
    ${input('Configuration name', 'name', c.name, 'required')}${input('Repository directory', 'repository', c.repository, 'required placeholder="/home/you/projects/application"')}
    <p class="hint">Use the repository root. Inspection reads current files and the current branch history.</p><div class="row">${input('TypeScript configuration', 'tsconfig', c.tsconfig, 'required')}${input('Git commit limit', 'commits', c.commits, 'type="number" min="1" step="1" placeholder="All history"')}</div>
    <div class="row">${patterns('Include code paths', 'include', c.include)}${patterns('Exclude code paths', 'exclude', c.exclude)}</div><p class="hint">Code patterns are relative to the TypeScript configuration directory. Empty filters include all project files.</p>
    <fieldset><legend>Author identities</legend><p class="hint">Combine known email addresses for the same person. Applies to all treemap presets for this repository without another inspection.</p><div id="author-identities">${(c.authorIdentities ?? []).map(authorIdentityHtml).join('')}</div><button type="button" data-action="add-author">Add author identity</button></fieldset>
    <div class="actions"><button class="primary" type="submit">Save configuration</button>${c.id ? '<button type="button" data-action="delete-inspection" class="danger">Delete</button>' : ''}</div></fieldset></form>${c.id ? `<div class="card">${runControls(c)}<div id="inspection-results">${inspectionStatusHtml(c)}</div></div>` : ''}`;
}
const configTabs = () => `<div class="config-tabs">${[['presets','Score configuration'],['filters','Filters'],['treemap-settings','Treemap settings']].map(([id,label]) => `<a href="#${id}" class="${route() === id ? 'active' : ''}">${label}</a>`).join('')}</div>`;
function presetView() {
  const p = !newPreset && selectedPreset() || defaultPreset();
  view.innerHTML = configTabs() + heading('Score configuration', 'JavaScript contributions, shared across every view.') +
    `<div class="card toolbar">${selection(state.presets, p.id, 'Saved score', 'preset')}<button data-action="new-preset">New</button><button data-action="duplicate-preset" ${p.id ? '' : 'disabled'}>Duplicate</button></div>
    <form id="preset-form" class="card score-config" data-id="${esc(p.id)}">${input('Configuration name', 'name', p.name, 'required')}
    <p class="execution-warning">JavaScript runs on this server. Use trusted code only. Synchronous JavaScript and Lodash are available; file, network and module access are not provided. <a href="#help">Examples &amp; tools</a></p>
    <div class="formula-section-heading"><h2>Contributions</h2><span class="hint">All file contributions are added</span></div><div id="formula-fields">${p.config.fields.map(formulaField).join('')}</div>
    <div class="actions add-fields"><button type="button" data-action="add-function-field">＋ Function metric</button><button type="button" data-action="add-file-field">＋ File metric</button></div>
    <div class="actions"><button class="primary" type="submit">Save &amp; apply</button>${p.id ? '<button type="button" class="danger" data-action="delete-preset">Delete</button>' : ''}</div></form>`;
  mountScoreEditors(view, api);
}
function settingsView() {
  const filters = route() === 'filters', collection = filters ? 'filters' : 'treemaps', key = filters ? 'filter' : 'treemap';
  const p = !newSettings && (filters ? selectedFilter() : selectedTreemap()) || (filters ? { name: '', options: { include: [], exclude: [] } } : { name: '', config: { area: 'code_files.effective_lines', functionArea: 'code_functions.exclusive_size_bytes', heat: {} } });
  const o = p.options ?? {}, h = p.config?.heat ?? {};
  view.innerHTML = configTabs() + heading(filters ? 'Filters' : 'Treemap settings', filters ? 'Reusable path and Git history scope for every score.' : 'Area and heat scale, independent of scoring.') +
    `<div class="card toolbar">${selection(state[collection], p.id, 'Saved configuration', key)}<button data-action="new-settings">New</button><button data-action="duplicate-settings" ${p.id ? '' : 'disabled'}>Duplicate</button></div>
    <form id="settings-form" class="card settings-config" data-collection="${collection}" data-id="${esc(p.id)}">${input('Configuration name','name',p.name,'required')}${filters ? `<div class="row">${patterns('Include paths','include',o.include)}${patterns('Exclude paths','exclude',o.exclude)}</div><p class="hint">Paths are relative to the repository root. Empty includes match all files.</p><div class="row">${input('Git history since','since',o.since,'placeholder="2025-01-01T00:00:00Z"')}${input('Git history until','until',o.until,'placeholder="2026-12-31T23:59:59Z"')}</div><p class="hint">Dates filter imported Git commits, not the analyzed source snapshot.</p>` : `<div class="row">${metricSelect('File tile size','area',p.config.area)}${functionAreaSelect(p.config.functionArea)}</div><h2>Heat scale</h2><p class="hint">Leave blank for automatic bounds from the selected score and filter.</p><div class="row">${['min','yellowFrom','redFrom','max'].map((k,i) => input(['Minimum','Yellow from','Red from','Maximum'][i], 'heat-'+k,h[k],'type="number" step="any" placeholder="Automatic"')).join('')}</div><button type="button" data-action="use-local-heat">Use current legend values</button>`}<div class="actions"><button class="primary">Save &amp; apply</button>${p.id ? '<button type="button" class="danger" data-action="delete-settings">Delete</button>' : ''}</div></form>`;
}
function runControls(c) {
  return ['code', 'git', 'both'].map(inspector => `<button data-action="run" data-inspector="${inspector}">${inspector === 'both' ? 'Run both' : `Run ${inspector === 'code' ? 'Code' : 'Git'}`}</button>`).join('');
}
function inspectionStatusHtml(c) {
  if (!c) return '';
  const items = ['code', 'git'].map(kind => {
    const status = c.inspectorStates?.[kind], result = status?.result;
    return `<p class="hint"><strong>${kind === 'code' ? 'Code' : 'Git'}:</strong> ${result ? `${esc(new Date(result.completedAt).toLocaleString())} · ${esc(result.branch)}${result.head ? ` · ${esc(result.head.slice(0, 8))}` : ''}${status.stale ? ' · Settings changed — rerun required' : ''}` : 'No results'}</p>`;
  }).join('');
  const code = c.inspectorStates?.code.result, git = c.inspectorStates?.git.result;
  const different = code && git && (code.head !== git.head || code.dirty);
  return items + (different ? '<p class="badge">Code and Git results represent different repository states.</p>' : '') + (c.hasResults && !git ? '<p class="hint">Git metrics are not available. Run Git inspection to add history.</p>' : '');
}
function updateProgress() {
  const jobs = state.jobs ?? [];
  document.querySelector('#inspection-footer').hidden = !jobs.length;
  document.querySelector('#progress').innerHTML = progressHtml(jobs);
  const host = document.querySelector('#job');
  const open = new Set([...host.querySelectorAll('details[open]')].map(node => node.dataset.key));
  const focused = document.activeElement?.closest('[data-action="cancel"]')?.dataset;
  host.innerHTML = jobs.map(j => `<div class="status ${j.status === 'failed' ? 'failed' : ''}"><strong>${esc(j.name)} · ${esc(j.inspector)}</strong>${j.branch ? `<span class="job-branch">Branch: ${esc(j.branch)}</span>` : ''}${j.status === 'running' ? `<button data-action="cancel" data-id="${esc(j.id)}" data-inspector="${j.inspector}" ${j.cancelled ? 'disabled' : ''}>${j.cancelled ? 'Cancelling…' : `Cancel ${j.inspector}`}</button>` : ''}<details data-key="${esc(j.id)}:${j.inspector}" ${open.has(`${j.id}:${j.inspector}`) ? 'open' : ''}><summary>Inspection output</summary><pre>${esc(j.error || '')}\n${esc(j.log)}</pre></details></div>`).join('');
  if (focused) [...host.querySelectorAll('[data-action="cancel"]')].find(node => node.dataset.id === focused.id && node.dataset.inspector === focused.inspector)?.focus();
  const c = selectedInspection();
  for (const button of document.querySelectorAll('[data-action="run"]')) button.disabled = jobs.some(j => j.id === c?.id && j.status === 'running' && (button.dataset.inspector === 'both' || j.inspector === button.dataset.inspector));
  const remove = document.querySelector('[data-action="delete-inspection"]');
  if (remove) remove.disabled = jobs.some(j => j.id === c?.id && j.status === 'running');
  const results = document.querySelector('#inspection-results');
  if (results) results.innerHTML = inspectionStatusHtml(c);
}
function treemapView() {
  const c = selectedInspection(), p = selectedPreset();
  view.innerHTML =
    `<div class="card toolbar">${selection(state.inspections, c?.id, 'Inspection configuration', 'inspection')}<label>Score<select data-select="preset">${options(state.presets, colorByAuthor ? null : p?.id)}<optgroup label="Special configurations"><option value="__author__" ${colorByAuthor ? 'selected' : ''}>Color by author</option></optgroup></select></label>${selection(state.filters, selectedFilter()?.id, 'Filter', 'filter')}${selection(state.treemaps, selectedTreemap()?.id, 'Treemap', 'treemap')}<label class="checkbox-label"><input type="checkbox" id="show-functions" ${showFunctions ? 'checked' : ''}>Show functions</label><label class="checkbox-label"><input type="checkbox" id="show-directories" ${showDirectories ? 'checked' : ''}>Show directories</label>${c ? runControls(c) : ''}</div><div id="map-state">${inspectionStatusHtml(c)}</div><div id="map"></div><details id="warnings"><summary>Warnings</summary><div id="warning-content"><p class="muted">No warnings.</p></div></details>`;
  if (!c) document.querySelector('#map').innerHTML = '<div class="card empty"><div class="symbol">▦</div><h2>Please configure inspection</h2><p class="muted">Choose a local repository to get started.</p><a class="button primary" href="#inspections">Configure inspection</a></div>';
  else if (!c.hasResults) document.querySelector('#map').innerHTML = '<div class="card empty"><div class="symbol">▦</div><h2>Start inspection</h2><p class="muted">Run Code inspection to explore this repository. Git results alone provide status until Code results are available.</p></div>';
  else if (!p) document.querySelector('#map').innerHTML = '<div class="card empty"><h2>Please configure a treemap preset</h2><a class="button" href="#presets">Create preset</a></div>';
  else if (!selectedFilter() || !selectedTreemap()) document.querySelector('#map').innerHTML = '<div class="card empty"><h2>Choose a filter and treemap settings</h2><a href="#filters">Configure filters</a> · <a href="#treemap-settings">Configure treemap</a></div>';
  else { document.querySelector('#map').innerHTML = '<p class="muted">Calculating treemap…</p>'; drawMap(c, p, requestNumber); }
  treeKey = currentTreeKey();
}
function currentTreeKey() { return JSON.stringify([showFunctions, state.selection, selectedInspection()?.inspectorStates, selectedInspection()?.stale, selectedInspection()?.hasResults, selectedInspection()?.authorIdentities, selectedPreset(), selectedFilter(), selectedTreemap(), state.developerPresets]); }
async function drawMap(c, p, number) {
  try {
    const result = await api(`treemap?inspection=${encodeURIComponent(c.id)}&preset=${encodeURIComponent(p.id)}&showFunctions=${showFunctions}`);
    if (number !== requestNumber || route() !== 'treemap') return;
    metrics = result.metrics;
    const frame = document.createElement('iframe'); frame.title = 'Code treemap'; frame.setAttribute('sandbox', 'allow-scripts allow-forms');
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style id="theme-style">${treemapThemeStyles()}</style><style>html,body{height:100%;box-sizing:border-box}body{margin:0;padding:6px;font-family:system-ui;overflow:hidden;background:var(--cv-bg);color:var(--cv-text)}.code-view-treemap{height:100%;min-height:0;--treemap-height:auto}</style><script>(${receiveTreemapTheme.toString()})();<\/script></head><body>${result.treeMapHtml}</body></html>`;
    frame.addEventListener('load', () => {
      sendTreeViewOptions();
      frame.contentWindow.postMessage({ type: 'code-view-theme', styles: treemapThemeStyles() }, '*');
      frame.contentWindow.postMessage({ type: 'code-view-set-path', path: new URLSearchParams(location.search).get('treemapPath') ?? '' }, '*');
    });
    document.querySelector('#map').replaceChildren(frame);
    document.querySelector('#warning-content').innerHTML = result.treeMapWarningsHtml;
  } catch (error) {
    if (number !== requestNumber || route() !== 'treemap') return;
    document.querySelector('#map').textContent = 'Unable to display the treemap.';
    document.querySelector('#warning-content').textContent = error.message;
    document.querySelector('#warnings').open = true;
  }
}
function sendTreeViewOptions() {
  document.querySelector('#map iframe')?.contentWindow?.postMessage({ type: 'code-view-options', showDirectories, colorByAuthor, heat: preferences.heat?.[preferenceKey()], disabledAuthors: preferences.disabledAuthors?.[preferenceKey()] ?? [] }, '*');
}
view.addEventListener('input', event => {
  if (event.target.name === 'field-name') event.target.closest('.formula-field').dataset.autoName = 'false';
  if (event.target.id === 'metric-help-search') filterMetricHelp(view, event.target.value);
});
document.addEventListener('change', async event => {
  if (event.target.id === 'show-directories') { showDirectories = event.target.checked; saveViewPreferences(); sendTreeViewOptions(); return; }
  if (event.target.id === 'show-functions') { showFunctions = event.target.checked; saveViewPreferences(); render(); return; }
  const key = event.target.dataset.select;
  if (!key || !event.target.value) return;
  if (key === 'preset') {
    colorByAuthor = event.target.value === '__author__'; saveViewPreferences();
    if (colorByAuthor) { sendTreeViewOptions(); return; }
  }
  try { await api('selection', 'POST', { [key]: event.target.value }); newInspection = newPreset = newSettings = false; await load(); render(); } catch (e) { notice(e); }
});
view.addEventListener('submit', async event => {
  if (!['inspection-form', 'preset-form', 'settings-form'].includes(event.target.id)) return;
  event.preventDefault(); notice(null);
  const form = event.target, data = new FormData(form), id = form.dataset.id;
  let value, collection;
  if (form.id === 'inspection-form') {
    const authorIdentities = [...form.querySelectorAll('.author-identity')].map(row => ({
      name: row.querySelector('[name="author-name"]').value,
      email: row.querySelector('[name="author-email"]').value,
      aliases: row.querySelector('[name="author-aliases"]').value.split(',').map(email => email.trim()).filter(Boolean),
    }));
    collection = 'inspections'; value = { name: data.get('name'), repository: data.get('repository'), tsconfig: data.get('tsconfig'), commits: data.get('commits') === '' ? null : Number(data.get('commits')), include: lines(data.get('include')), exclude: lines(data.get('exclude')), authorIdentities };
  } else if (form.id === 'preset-form') {
    collection = 'presets';
    const fields = readFields(form);
    if (!fields.length) { notice('Add at least one contribution.'); return; }
    try { if (!await confirmSyntax(fields, api)) return; } catch (error) { notice(error); return; }
    value = { name: data.get('name'), config: { fields } };
  } else {
    collection = form.dataset.collection;
    if (collection === 'filters') {
      const options = { include: lines(data.get('include')), exclude: lines(data.get('exclude')) };
      for (const key of ['since','until']) if (data.get(key)) options[key] = data.get(key);
      value = { name: data.get('name'), options };
    } else {
      const heat = {}; for (const key of ['min','yellowFrom','redFrom','max']) if (data.get('heat-'+key) !== '') heat[key] = Number(data.get('heat-'+key));
      value = { name: data.get('name'), config: { area: data.get('area'), functionArea: data.get('functionArea'), heat } };
    }
  }
  try { await api(`${collection}${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', value); if (collection === 'treemaps' && preferences.heat) { delete preferences.heat[preferenceKey()]; savePreferences(preferences); } newInspection = newPreset = newSettings = false; await load(); render(); const message = document.createElement('p'); message.className = 'saving'; message.textContent = 'Saved.'; view.prepend(message); } catch (e) { notice(e); }
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action; notice(null);
  try {
    if (action === 'new-inspection') { newInspection = true; render(); return; }
    if (action === 'add-author') { document.querySelector('#author-identities').insertAdjacentHTML('beforeend', authorIdentityHtml()); return; }
    if (action === 'remove-author') { button.closest('.author-identity').remove(); return; }
    if (action === 'new-preset') { newPreset = true; render(); return; }
    if (action === 'new-settings') { newSettings = true; render(); return; }
    if (action === 'duplicate-settings') { const filters = route() === 'filters', p = filters ? selectedFilter() : selectedTreemap(); await api(filters ? 'filters' : 'treemaps', 'POST', { ...p, name: `${p.name} copy` }); }
    if (action === 'delete-settings') { const filters = route() === 'filters', p = filters ? selectedFilter() : selectedTreemap(); if (!confirm(`Delete "${p.name}"?`)) return; await api(`${filters ? 'filters' : 'treemaps'}/${p.id}`, 'DELETE'); await load(); render(); return; }
    if (action === 'use-local-heat') { const heat = preferences.heat?.[preferenceKey()]; if (!heat) { notice('Adjust the treemap legend first.'); return; } for (const [key,value] of Object.entries(heat)) view.querySelector(`[name="heat-${key}"]`).value = value; return; }
    if (action === 'add-function-field' || action === 'add-file-field') { const kind = action === 'add-function-field' ? 'function' : 'file'; document.querySelector('#formula-fields').insertAdjacentHTML('beforeend', formulaField({ id: crypto.randomUUID(), kind, name: '', autoName: true, code: kind === 'function' ? 'metrics.cyclomatic_complexity' : 'metrics.effective_lines', aggregation: 'sum(scores)' })); mountScoreEditors(view, api); return; }
    if (action === 'remove-field') { button.closest('.formula-field').remove(); return; }
    if (action === 'duplicate-preset') { const p = selectedPreset(); await api('presets', 'POST', { ...p, name: `${p.name} copy` }); }
    if (['delete-inspection','delete-preset'].includes(action)) {
      const inspection = action === 'delete-inspection', c = inspection ? selectedInspection() : selectedPreset();
      if (!confirm(`Delete "${c.name}"${inspection ? ' and its inspection results' : ''}?`)) return;
      await api(`${inspection ? 'inspections' : 'presets'}/${c.id}`, 'DELETE');
    }
    if (action === 'run') await api('run', 'POST', { id: selectedInspection().id, inspector: button.dataset.inspector });
    if (action === 'cancel') await api('cancel', 'POST', { id: button.dataset.id, inspector: button.dataset.inspector });
    await load();
    if (action === 'run' || action === 'cancel') updateProgress(); else render();
  } catch (e) { notice(e); }
});
window.addEventListener('hashchange', () => { notice(null); newInspection = newPreset = newSettings = false; render(); });
try { await load(); render(); } catch (e) { notice(e); }
let polling = false;
setInterval(async () => {
  if (polling || !state) return;
  polling = true;
  try { await load(); if ((route() === 'treemap' && treeKey !== currentTreeKey()) || (['files', 'functions', 'developers', 'graph'].includes(route()) && listKey !== currentTreeKey())) render(); else updateProgress(); } catch (e) { notice(e); } finally { polling = false; }
}, 1500);

window.addEventListener('message', async event => {
  const frame = document.querySelector('#map iframe');
  if (frame && event.source === frame.contentWindow && event.data?.type === 'code-view-path' && typeof event.data.path === 'string') {
    const url = new URL(location.href);
    if (event.data.path) url.searchParams.set('treemapPath', event.data.path); else url.searchParams.delete('treemapPath');
    history.replaceState(history.state, '', url);
    return;
  }
  if (frame && event.source === frame.contentWindow && event.data?.type === 'code-view-authors' && Array.isArray(event.data.disabledAuthors) && event.data.disabledAuthors.every(id => typeof id === 'string')) {
    preferences.disabledAuthors = { ...preferences.disabledAuthors, [preferenceKey()]: event.data.disabledAuthors }; savePreferences(preferences); return;
  }
  if (frame && event.source === frame.contentWindow && event.data?.type === 'code-view-heat') {
    const p = selectedPreset(), heat = event.data.heat;
    try {
      if (!p || !heat || typeof heat !== 'object' || Array.isArray(heat) || Object.entries(heat).some(([key,value]) => !['min','yellowFrom','redFrom','max'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) )) throw new Error('Invalid heat thresholds.');
      preferences.heat = { ...preferences.heat, [preferenceKey()]: heat }; savePreferences(preferences);
      frame.contentWindow?.postMessage({ type: 'code-view-heat-result', local: true }, '*');
    } catch (error) {
      frame.contentWindow?.postMessage({ type: 'code-view-heat-result', error: error.message }, '*');
    }
    return;
  }
  if (event.source !== frame?.contentWindow || event.data?.type !== 'code-view-inspect' || !['file', 'function'].includes(event.data.kind) || typeof event.data.id !== 'string') return;
  const hash = detailHash(event.data.kind, event.data.id, { inspection: selectedInspection().id, preset: selectedPreset().id, showFunctions: String(showFunctions) });
  history.pushState({ inspector: true }, '', hash); render();
});
window.addEventListener('popstate', () => { render(); });
