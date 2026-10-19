import { join } from 'node:path';
import { execute } from './execute.mjs';
export async function snapshotState(directory) {
  try { return JSON.parse(await execute('tar', ['-xOf', join(directory, 'controller.tar'), './state.json'])); }
  catch { throw new Error('Cannot read controller state from the stopped snapshot'); }
}
