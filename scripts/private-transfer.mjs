import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { stackRoot } from '../packages/cli/src/local.mjs';

const script = `
import { Backend } from './packages/platform/src/backend.mjs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const args = JSON.parse(input);
const slot = JSON.parse(process.env.FOGD_SLOTS).find(s => s.id === args.slot);
if (!slot) throw Error('Unknown slot');
if (args.ready) {
  await new Backend().ready(slot, args.ready); console.log('ready');
} else if (args.sql) {
  console.log(await new Backend().run(slot, ['d1', 'execute', args.database, '--command', args.sql, (process.env.FOGD_DATA_DIR || '/var/lib/fogd') + '/artifacts/' + args.release, '--json']));
} else {
  const response = await fetch('http://' + slot.nodes[0] + ':8080/' + args.path, {
    method: args.body ? 'POST' : 'GET', headers: {'Content-Type':'application/json', 'X-Fogd-Maintenance':'1'},
    body: args.body ? JSON.stringify(args.body) : undefined, signal: AbortSignal.timeout(60000)
  });
  console.log(JSON.stringify({ status: response.status, body: await response.text() }));
}
`;
export function privateRequest(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '--project-directory', stackRoot, '-f', join(stackRoot, 'compose.yaml'), 'exec', '-T', 'controller', 'node', '--input-type=module', '-e', script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 210000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', cause => { clearTimeout(timer); reject(cause); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error(error || `Private request exited ${code}`)); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(args));
  });
}
export async function transferRequest(env, slot, path, body) {
  const result = JSON.parse(await privateRequest(env, { slot, path, body }));
  try { result.body = JSON.parse(result.body); } catch { /* Preserve diagnostic text for failures. */ }
  return result;
}
