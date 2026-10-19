export class InputError extends Error {
  /** @param {400|404|409|413} status @param {string} message */
  constructor(status, message) { super(message); this.status = status; }
}
export function jobId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) throw new InputError(400, 'Use a job ID with 1–64 lowercase letters, digits, or hyphens');
  return id;
}
export function labels(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 8192) throw new InputError(400, 'Input must be text no larger than 8 KiB');
  const rows = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!rows.length || rows.length > 20 || rows.some(row => row.length > 200)) throw new InputError(400, 'Use 1–20 nonempty lines, at most 200 characters each');
  return rows;
}
export async function inputHash(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function options(value) {
  const mode = value.mode || 'normal', delayMs = value.delayMs ?? 0;
  if (!['normal', 'retry-once', 'fail'].includes(mode) || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30000) throw new InputError(400, 'Invalid processing options');
  return { mode, delayMs };
}
export async function readJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new InputError(400, 'Expected a JSON body');
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 16384) { await reader.cancel(); throw new InputError(413, 'Request too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new InputError(400, 'Expected valid JSON'); }
}
