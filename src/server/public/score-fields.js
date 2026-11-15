import { mountFormulaEditor } from '../../score-code/editor-entry.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let editors = [];
export function destroyScoreEditors() { editors.forEach(e => e.destroy()); editors = []; }
export function formulaField(field) {
  return `<section class="formula-field" data-field-id="${esc(field.id)}" data-kind="${field.kind}" data-auto-name="${field.autoName !== false}"><div class="formula-heading"><span class="scope-badge">${field.kind === 'function' ? 'ƒ Function metric' : '▤ File metric'}</span><input aria-label="Contribution name" name="field-name" value="${esc(field.name)}" placeholder="Name from first metric"><button type="button" class="quiet" data-action="remove-field" aria-label="Remove contribution">Remove</button></div><textarea name="code" hidden>${esc(field.code)}</textarea><div data-editor="${field.kind}"></div>${field.kind === 'function' ? `<div class="aggregation-heading">File aggregation <span class="hint">scores: number[]</span></div><textarea name="aggregation" hidden>${esc(field.aggregation ?? 'sum(scores)')}</textarea><div data-editor="aggregation"></div>` : ''}<p class="formula-diagnostics hint" aria-live="polite"></p></section>`;
}
export function mountScoreEditors(root, api) {
  for (const host of root.querySelectorAll('[data-editor]:not([data-mounted])')) {
    host.dataset.mounted = 'true';
    const field = host.closest('.formula-field'), scope = host.dataset.editor;
    const textarea = field.querySelector(`[name="${scope === 'aggregation' ? 'aggregation' : 'code'}"]`);
    editors.push(mountFormulaEditor(host, { code: textarea.value, scope, api,
      changed: value => { textarea.value = value; },
      checked: result => {
        if (!field.isConnected) return;
        host.dataset.errors = String(result.diagnostics.length);
        host.dataset.syntax = String(result.diagnostics.some(d => d.syntax));
        host.title = result.diagnostics.map(d => d.message).join('\n');
        const count = [...field.querySelectorAll('[data-editor]')].reduce((n,e) => n + Number(e.dataset.errors || 0), 0);
        field.querySelector('.formula-diagnostics').textContent = count ? `${count} issue${count === 1 ? '' : 's'} · hover underlined code for details` : '';
        if (scope !== 'aggregation' && field.dataset.autoName === 'true') field.querySelector('[name="field-name"]').value = result.name;
      },
    }));
  }
}
export function readFields(form) {
  return [...form.querySelectorAll('.formula-field')].map(field => ({ id: field.dataset.fieldId, kind: field.dataset.kind, name: field.querySelector('[name="field-name"]').value, autoName: field.dataset.autoName === 'true', code: field.querySelector('[name="code"]').value,
    ...(field.dataset.kind === 'function' ? { aggregation: field.querySelector('[name="aggregation"]').value } : {}) }));
}
export async function confirmSyntax(fields, api) {
  const checks = await Promise.all(fields.flatMap(f => [{ code: f.code, scope: f.kind }, ...(f.kind === 'function' ? [{ code: f.aggregation, scope: 'aggregation' }] : [])]).map(value => api('score/editor', 'POST', value)));
  if (!checks.some(result => result.diagnostics.some(d => d.syntax))) return true;
  const dialog = document.createElement('dialog'); dialog.className = 'syntax-dialog';
  dialog.innerHTML = `<form method="dialog"><h2>Save with syntax errors?</h2><p>Some formulas cannot run. Affected contributions and their dependent scores will be empty until corrected.</p><pre>${esc(checks.flatMap(r => r.diagnostics.filter(d => d.syntax).map(d => d.message)).join('\n'))}</pre><div class="actions"><button value="cancel">Keep editing</button><button class="primary" value="save">Save anyway</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'save'; dialog.remove(); resolve(accepted); }, { once: true }));
}
