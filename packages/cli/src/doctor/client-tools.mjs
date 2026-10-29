import { execute } from '../recovery/execute.mjs';
import { finding } from './report.mjs';

export const minimumClientNode = '24.21.0';
const options = { timeoutMs: 5000, maxOutputBytes: 8192 };
const abcSha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

export async function inspectClientTools({ run = execute, nodeVersion = process.versions.node } = {}) {
  return [clientNodeFinding(nodeVersion), ...await Promise.all([inspectTar(run), inspectChecksum(run)])];
}

export function clientNodeFinding(version) {
  const match = typeof version === 'string' && version.length <= 48 && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version);
  const actual = match ? match.slice(1).map(Number) : [], minimum = minimumClientNode.split('.').map(Number);
  const known = actual.length === 3 && actual.every(Number.isSafeInteger);
  const difference = known ? actual.findIndex((value, index) => value !== minimum[index]) : -1;
  const supported = known && (difference === -1 || actual[difference] > minimum[difference]);
  return finding('client-node', known ? supported ? 'supported' : 'unsupported' : 'unverified',
    known ? supported ? 'The current client Node.js version meets the declared minimum.' : 'The current client Node.js version is below the declared minimum.' : 'The current client Node.js version could not be classified.',
    `Use stable Node.js ${minimumClientNode} or later for the operator/client program; this is separate from Node inside the pinned Docker runtime.`);
}

async function inspectTar(run) {
  let supported = false;
  try {
    const text = await run('tar', ['--version'], options);
    supported = /^(?:bsdtar|tar \(GNU tar\)) [0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[\s;-]|$)/.test(text);
  } catch { /* Missing, inaccessible and failed tools remain indistinguishable. */ }
  return finding('client-tar', supported ? 'supported' : 'unverified',
    supported ? 'A recognized GNU/BSD tar version banner was observed on the client.' : 'Client tar is missing, inaccessible or returned an unrecognized response.',
    'Provide a trusted GNU/BSD tar on the client PATH. Transfer and backup still validate the actual archive and required operations.');
}

async function inspectChecksum(run) {
  let supported = false;
  try {
    const result = (await run('sha256sum', [], { ...options, inputText: 'abc' })).trim().split(/\s+/);
    supported = result.length === 2 && result[0] === abcSha256 && ['-', '*-'].includes(result[1]);
  } catch { /* Do not print process output, errors or caller environment. */ }
  return finding('client-checksum', supported ? 'supported' : 'unverified',
    supported ? 'Client sha256sum correctly hashed known stdin.' : 'Client sha256sum is missing, inaccessible or did not produce the expected stdin checksum.',
    'Provide a trusted sha256sum on the client PATH for independent release authentication. No installation file was read or written by this probe.');
}
