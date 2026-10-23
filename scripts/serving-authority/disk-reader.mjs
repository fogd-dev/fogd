import { workerdExecutable } from './workerd-executable.mjs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFile, copyFile } from 'node:fs/promises';

// Only the scratch reader uses this loopback test coordinator. It has no Docker
// socket or write access to the authority volume and receives no credentials.
let pending;
const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/result') {
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) { response.writeHead(413).end(); return; } chunks.push(chunk); }
    console.log('ROUTE_RESULT ' + JSON.stringify(JSON.parse(Buffer.concat(chunks)))); response.writeHead(204).end(); return;
  }
  if (request.method !== 'GET' || pending) { response.writeHead(409).end(); return; }
  pending = { phase: request.url.slice(1), response };
  console.log('ROUTE_PHASE ' + pending.phase);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  if (!pending || line !== pending.phase) { process.exitCode = 1; pending?.response.writeHead(409).end(); return; }
  pending.response.writeHead(204).end(); pending = null;
});
const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [
  (name = "reader-test", worker = (
    modules = [(name = "disk-worker.mjs", esModule = embed "disk-worker.mjs")],
    compatibilityDate = "2026-02-24",
    bindings = [(name = "AUTHORITY", service = "authority"), (name = "CONTROL", service = "control"), (name = "MODE", text = ${JSON.stringify(process.argv[2] || 'initial')})]
  )),
  (name = "authority", disk = (path = "/authority", writable = false)),
  (name = "control", external = (address = "127.0.0.1:${server.address().port}", http = ()))
]);`;
await copyFile('/probe/disk-worker.mjs', '/tmp/disk-worker.mjs');
await writeFile('/tmp/reader.capnp', config, { mode: 0o600 });
const executable = await workerdExecutable();
console.log('ROUTE_EXECUTABLE ' + JSON.stringify(executable));
const child = spawn(executable.path, ['test', '/tmp/reader.capnp'], { stdio: ['ignore', 'inherit', 'inherit'] });
child.on('error', () => { process.exitCode = 1; server.close(); input.close(); });
child.on('exit', code => { process.exitCode ||= code ?? 1; server.close(); input.close(); });
