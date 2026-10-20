import { modes } from './refresh.mjs';
export class InputError extends Error {
  /** @param {400|413} status @param {string} message */
  constructor(status, message) { super(message); this.status = status; }
}
export async function readMode(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw new InputError(400, 'Send a JSON source mode.');
  const reader = request.body?.getReader();
  if (!reader) throw new InputError(400, 'Choose a supported source mode.');
  const decoder = new TextDecoder('utf-8', { fatal: true }); let text = '', bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024) { await reader.cancel(); throw new InputError(413, 'Source settings are too large.'); }
      text += decoder.decode(value, { stream: true });
    }
    const input = JSON.parse(text + decoder.decode());
    if (!input || !modes.includes(input.mode)) throw new InputError(400, 'Choose a supported source mode.');
    return input.mode;
  } catch (error) { if (error instanceof InputError) throw error; throw new InputError(400, 'Send a valid JSON source mode.'); }
  finally { reader.releaseLock(); }
}
