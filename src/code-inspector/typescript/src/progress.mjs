// Opt-in, line-delimited events on stderr; ordinary CLI output stays unchanged.
export function progressReporter(enabled) {
  let last = -Infinity, lastStatus;
  return (status, completed = 0, total = null, detail) => {
    const now = performance.now();
    if (!enabled) return;
    const boundary = status !== lastStatus || status === 'finalizing' || status === 'processing' && (completed === 0 || completed === total);
    if (!boundary && now - last < 100) return;
    lastStatus = status;
    last = now;
    process.stderr.write(`CODE_VIEW_PROGRESS ${JSON.stringify({ status, completed, total, ...(detail ? { detail } : {}) })}\n`);
  };
}
