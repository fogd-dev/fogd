import { join, posix } from 'node:path';
import { execute } from './execute.mjs';
export async function snapshotState(directory, archive = 'controller.tar') {
  try {
    const file = join(directory, archive);
    const entries = (await execute('tar', ['-tf', file])).trimEnd().split('\n').filter(name => posix.normalize(name) === 'state.json');
    if (entries.length !== 1 || !['./state.json', 'state.json'].includes(entries[0])) throw new Error('Ambiguous controller metadata');
    return JSON.parse(await execute('tar', ['-xOf', file, entries[0]]));
  }
  catch { throw new Error('Cannot read controller state from the stopped snapshot'); }
}
