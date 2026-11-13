import { StringDecoder } from 'node:string_decoder';
export const waitingProgress = () => ({ status: 'waiting', completed: 0, total: null });

// A pipe chunk may split a UTF-8 character or contain several partial event lines.
export function progressStream(onProgress, onLog) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  function line(text) {
    const prefix = 'CODE_VIEW_PROGRESS ';
    if (text.startsWith(prefix)) {
      try {
        const p = JSON.parse(text.slice(prefix.length));
        if (['preparing', 'processing', 'finalizing'].includes(p.status) && Number.isSafeInteger(p.completed) && p.completed >= 0 &&
          (p.total === null && p.completed === 0 || Number.isSafeInteger(p.total) && p.total >= p.completed)) {
          onProgress({ status: p.status, completed: p.completed, total: p.total, ...(typeof p.detail === 'string' ? { detail: p.detail.slice(0, 300) } : {}) });
          return;
        }
      } catch { /* Preserve malformed events in the diagnostic output. */ }
    }
    onLog(text + '\n');
  }
  function drain() {
    let end;
    while ((end = pending.indexOf('\n')) >= 0) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
    if (pending.length > 100000) { onLog(pending); pending = ''; }
  }
  return {
    write(chunk) { pending += decoder.write(chunk); drain(); },
    end() { pending += decoder.end(); drain(); if (pending) line(pending); pending = ''; },
  };
}
