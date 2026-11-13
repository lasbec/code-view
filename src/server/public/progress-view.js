const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const states = { waiting: 'Waiting', preparing: 'Preparing', processing: 'Processing', finalizing: 'Finalizing', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', cancelling: 'Cancelling' };
export function progressHtml(job) {
  if (!job) return '';
  const cancelling = job.status === 'running' && job.cancelled;
  const bars = [['code', 'Code-Inspector', 'files'], ['git', 'Git-Inspector', 'commits']].map(([key, label, unit]) => {
    const p = job.progress?.[key] ?? { status: 'waiting', completed: 0, total: null };
    const status = cancelling && job.activeInspector === key ? 'cancelling' : p.status;
    const unknown = ['preparing', 'finalizing', 'cancelling'].includes(status);
    const count = p.total === null ? '' : `${p.completed}/${p.total} ${unit}`;
    return `<div class="inspector-progress"><div class="progress-label"><label for="progress-${key}">${label}</label><span>${escape(count)}</span></div><progress id="progress-${key}" aria-label="${label}" aria-describedby="progress-status-${key}" max="${Math.max(1, p.total ?? 1)}" ${unknown ? '' : `value="${status === 'done' ? Math.max(1, p.total ?? 1) : p.completed}"`}></progress><span id="progress-status-${key}" class="hint" title="${escape(p.detail || states[status])}">${states[status] ?? escape(status)}${p.detail ? ` · ${escape(p.detail)}` : ''}</span></div>`;
  }).join('');
  const overall = cancelling ? 'Cancelling' : job.status === 'running' ? job.phase : job.status === 'succeeded' ? 'Inspection complete' : states[job.status];
  return `<section class="inspection-progress" aria-label="Inspection progress"><div class="progress-heading"><strong>${escape(job.name || 'Inspection')}</strong><span class="hint">${escape(overall)}</span></div><div class="progress-bars">${bars}</div></section>`;
}
