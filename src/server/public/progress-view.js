const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const states = { waiting: 'Waiting', preparing: 'Preparing', processing: 'Processing', finalizing: 'Finalizing', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', cancelling: 'Cancelling' };
export function progressHtml(jobs = []) {
  return jobs.map(job => {
    const key = job.inspector, label = key === 'code' ? 'Code-Inspector' : 'Git-Inspector', unit = key === 'code' ? 'files' : 'commits';
    const p = job.progress ?? { status: 'waiting', completed: 0, total: null };
    const status = job.status === 'running' && job.cancelled ? 'cancelling' : p.status;
    const unknown = ['preparing', 'finalizing', 'cancelling'].includes(status);
    const count = p.total === null ? '' : `${p.completed}/${p.total} ${unit}`;
    const id = escape(`${job.id}-${key}`);
    const overall = status === 'cancelling' ? 'Cancelling' : job.status === 'running' || job.status === 'succeeded' ? job.phase : states[job.status];
    return `<section class="inspection-progress" aria-label="${label} progress"><div class="progress-heading"><strong>${escape(job.name || 'Inspection')} · ${label}</strong><span class="hint">${escape(overall)}</span></div><div class="inspector-progress"><div class="progress-label"><label for="progress-${id}">${label}</label><span>${escape(count)}</span></div><progress id="progress-${id}" aria-label="${label}" max="${Math.max(1, p.total ?? 1)}" ${unknown ? '' : `value="${status === 'done' ? Math.max(1, p.total ?? 1) : p.completed}"`}></progress><span class="hint" title="${escape(p.detail || states[status])}">${states[status] ?? escape(status)}${p.detail ? ` · ${escape(p.detail)}` : ''}</span></div></section>`;
  }).join('');
}
