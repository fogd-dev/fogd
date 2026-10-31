export const controllerGet = (origin, path, authorization, { timeoutMs = 15000, signal } = {}) => fetch(`${origin}${path}`, {
  headers: { Authorization: authorization }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
});
class ResponseLimitError extends Error {}
export async function boundedJson(response, { limit, invalid, oversized = invalid, interrupted = invalid }) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid response size limit');
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > limit) throw new ResponseLimitError(); chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof ResponseLimitError) throw new Error(oversized);
    throw new Error(error instanceof SyntaxError ? invalid : interrupted);
  }
}
export async function discardResponse(response) {
  try { await response.body?.cancel(); } catch { /* Cleanup must not expose transport diagnostics. */ }
}
