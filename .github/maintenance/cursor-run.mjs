const terminal = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);
const statuses = new Set(['CREATING', 'RUNNING', ...terminal]);
const identifier = /^[A-Za-z0-9_-]{1,160}$/;

async function boundedJson(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1048576) throw new Error('CURSOR_STATUS_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function pollCursorRun({
  receipt, apiKey, assertCurrent, fetcher = fetch,
  now = Date.now, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  maxWaitMs = 600000, pollMs = 30000,
}) {
  if (!apiKey || !identifier.test(receipt.agentId) || !identifier.test(receipt.runId)) throw new Error('INVALID_CURSOR_POLL_INPUT');
  if (typeof assertCurrent !== 'function' || !Number.isFinite(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 600000 || !Number.isFinite(pollMs) || pollMs < 1 || pollMs > 60000) throw new Error('INVALID_CURSOR_POLL_BUDGET');
  const started = now();
  const output = {
    schema: 'cursor-run-receipt.v1', agentId: receipt.agentId, runId: receipt.runId,
    head: receipt.head, url: `https://cursor.com/agents/${receipt.agentId}`,
    status: 'pending', polls: 0,
  };
  const maxPolls = Math.min(601, Math.ceil(maxWaitMs / pollMs) + 1);
  for (let attempt = 0; attempt < maxPolls && now() - started < maxWaitMs; attempt += 1) {
    let run;
    try {
      const response = await fetcher(`https://api.cursor.com/v1/agents/${receipt.agentId}/runs/${receipt.runId}`, {
        method: 'GET', headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(Math.max(1, Math.min(30000, maxWaitMs - (now() - started)))),
      });
      output.polls += 1;
      if (!response.ok) {
        output.error = `CURSOR_STATUS_HTTP_${response.status}`;
        if (response.status !== 429 && response.status < 500) return { ...output, status: 'failed' };
      } else {
        run = await boundedJson(response);
        if (run.id !== receipt.runId || run.agentId !== receipt.agentId || !statuses.has(run.status)) return { ...output, status: 'failed', error: 'INVALID_CURSOR_RUN_RESPONSE' };
        output.remoteStatus = run.status;
        delete output.error;
        if (typeof run.result === 'string') {
          output.result = run.result.split(apiKey).join('[REDACTED]').slice(0,32768);
          output.resultTruncated = run.result.length > 32768;
        }
        if (terminal.has(run.status)) {
          if (run.status !== 'FINISHED') return { ...output, status:'failed' };
          try { await assertCurrent(); }
          catch (error) { return { ...output, status: error.message === 'SUPERSEDED_REVISION' ? 'superseded' : 'failed', error: error.message === 'SUPERSEDED_REVISION' ? 'SUPERSEDED_REVISION' : 'SOURCE_REVISION_UNVERIFIED' }; }
          return { ...output, status:'completed', sourceRevisionVerified:true };
        }
      }
    } catch { output.error = 'CURSOR_STATUS_REQUEST_FAILED'; }
    const remaining = maxWaitMs - (now() - started);
    if (remaining <= 0 || attempt + 1 >= maxPolls) break;
    await sleep(Math.min(pollMs,remaining));
  }
  return { ...output, status:'pending', waitBudgetExhausted:true };
}
