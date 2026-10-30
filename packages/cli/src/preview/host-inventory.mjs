import { isDeepStrictEqual } from 'node:util';
import { PreviewAdmissionError } from './admission.mjs';

const commands = { container: ['container', 'ls', '-aq', '--no-trunc'], network: ['network', 'ls', '-q', '--no-trunc'], volume: ['volume', 'ls', '-q'] };
async function identifiers(kind, run) {
  const values = (await run(commands[kind])).trim().split(/\s+/).filter(Boolean).sort();
  const valid = kind === 'volume' ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/ : /^[a-f0-9]{64}$/;
  if (values.some(value => !valid.test(value)) || new Set(values).size !== values.length) throw new PreviewAdmissionError('inventory');
  return values;
}
const hostBinding = value => Object.fromEntries(['ID', 'OSType', 'Architecture', 'Driver', 'MemTotal', 'NCPU'].map(key => [key, value[key]]));

// The caller supplies its explicit Docker context. IDs are checked again after
// inspection. This snapshot is not a lock or reservation; launch must recheck.
export async function readPreviewHost(run) {
  try {
    const host = JSON.parse(await run(['info', '--format', '{{json .}}'])), ids = {}, records = {};
    for (const kind of Object.keys(commands)) {
      ids[kind] = await identifiers(kind, run);
      const values = ids[kind].length ? JSON.parse(await run([kind, 'inspect', ...ids[kind]])) : [];
      const key = kind === 'volume' ? 'Name' : 'Id';
      if (!Array.isArray(values) || !isDeepStrictEqual(values.map(value => value?.[key]).sort(), ids[kind])) throw new PreviewAdmissionError('inventory');
      records[kind] = values;
    }
    for (const kind of Object.keys(commands)) if (!isDeepStrictEqual(await identifiers(kind, run), ids[kind])) throw new PreviewAdmissionError('inventory-changed');
    const after = JSON.parse(await run(['info', '--format', '{{json .}}']));
    if (!isDeepStrictEqual(hostBinding(host), hostBinding(after))) throw new PreviewAdmissionError('inventory-changed');
    return { host, containers: records.container, networks: records.network, volumes: records.volume };
  } catch (error) {
    if (error instanceof PreviewAdmissionError) throw error;
    throw new PreviewAdmissionError('inventory');
  }
}
