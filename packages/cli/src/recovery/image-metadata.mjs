import { execute } from './execute.mjs';

export const imageArchiveReader = (archive, options) => path => execute('tar', ['-xOf', archive, '--', path], options);
export function parseImageMetadata(input) {
  try { return JSON.parse(input); }
  catch { throw new Error('Unreadable image archive metadata'); }
}
