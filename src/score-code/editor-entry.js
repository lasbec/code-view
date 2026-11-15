import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion } from '@codemirror/autocomplete';
import { linter, lintGutter } from '@codemirror/lint';

export function mountFormulaEditor(host, { code, scope, api, changed, checked }) {
  let metadata, metadataPromise, request = 0;
  const inspect = async value => {
    const ticket = ++request;
    const result = await api('score/editor', 'POST', { code: value, scope });
    metadata = result;
    if (ticket === request) checked?.(result);
    return result;
  };
  const completion = async context => {
    if (!metadata) await metadataPromise;
    if (!metadata) return null;
    const text = context.state.doc.sliceString(0, context.pos);
    const metric = /metrics\.([\w]*)$/.exec(text), lodash = /_\.([\w]*)$/.exec(text);
    if (metric && scope !== 'aggregation') return { from: context.pos - metric[1].length, options: metadata.metrics.filter(m => m.scope === scope).map(m => ({ label: m.key, type: 'property', section: m.category === 'git' ? 'Git metrics' : m.category === 'code' ? 'Code metrics' : 'Function metrics', detail: m.type, info: `${m.label}: ${m.description}` })) };
    if (lodash) return { from: context.pos - lodash[1].length, options: metadata.tools.map(label => ({ label, type: 'function', detail: 'Lodash' })) };
    const word = context.matchBefore(/[\w$]+/);
    if (!word && !context.explicit) return null;
    return { from: word?.from ?? context.pos, options: [ { label: scope === 'aggregation' ? 'scores' : 'metrics', type: 'variable' }, { label: '_', type: 'namespace', detail: 'Lodash' }, ...metadata.tools.map(label => ({ label, type: 'function', detail: 'Lodash' })) ] };
  };
  const editor = new EditorView({ doc: code, parent: host, extensions: [basicSetup, javascript(), lintGutter(),
    autocompletion({ override: [completion] }),
    linter(async view => {
      const value = view.state.doc.toString();
      try { const result = await inspect(value); if (view.state.doc.toString() !== value) return []; return result.diagnostics; }
      catch { return []; }
    }, { delay: 450 }),
    EditorView.updateListener.of(update => { if (update.docChanged) changed(update.state.doc.toString()); }),
    EditorView.theme({ '&': { fontSize: '13px', backgroundColor: 'var(--cv-surface)', color: 'var(--cv-text)' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', overflow: 'auto' }, '.cm-content': { minHeight: scope === 'aggregation' ? '36px' : '64px' }, '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--cv-muted)', borderRight: '1px solid var(--cv-border)' }, '.cm-tooltip': { backgroundColor: 'var(--cv-surface)', color: 'var(--cv-text)', border: '1px solid var(--cv-border)' }, '&.cm-focused': { outline: 'none' } }),
  ] });
  metadataPromise = inspect(code).catch(() => {});
  return { destroy: () => editor.destroy(), focus: () => editor.focus() };
}
