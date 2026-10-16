import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const dir = process.env.FOGD_RUNTIME_DIR || '/tmp/fogd-gateway';
await mkdir(dir, { recursive: true });
await copyFile(new URL('./gateway.js', import.meta.url), join(dir, 'gateway.js'));
const q = JSON.stringify;
const slots = process.env.FOGD_SLOTS ? JSON.parse(process.env.FOGD_SLOTS) : null;
const backends = slots ? slots.flatMap(slot => slot.nodes.map((node, index) => ({ name: `${slot.id}-${index}`, address: `${node}:8080` }))) : [{ name: 'NODE_A', address: process.env.FOGD_NODE_A || 'celld-a:8080' }, { name: 'NODE_B', address: process.env.FOGD_NODE_B || 'celld-b:8080' }];
if (slots) backends.push({ name: 'CONTROLLER', address: process.env.FOGD_CONTROLLER || 'controller:8082' });
const bindings = backends.map(b => `(name = ${q(b.name)}, service = ${q(b.name)})`);
bindings.push(`(name = "APP_HOST", text = ${q(process.env.FOGD_APP_HOST || 'hello.localhost')})`);
if (slots) bindings.push(`(name = "GATEWAY_TOKEN", text = ${q(process.env.FOGD_GATEWAY_TOKEN)})`);
const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "gateway", worker = (
      modules = [(name = "gateway.js", esModule = embed "gateway.js")],
      compatibilityDate = "2026-02-24",
      bindings = [${bindings.join(',')}]
    )),
    ${backends.map(b => `(name = ${q(b.name)}, external = (address = ${q(b.address)}, http = ()))`).join(',')}
  ],
  sockets = [(name = "http", address = ${q(process.env.FOGD_LISTEN || '*:8080')}, http = (), service = "gateway")]
);
`;
await writeFile(join(dir, 'gateway.capnp'), config);
const child = spawn('workerd', ['serve', join(dir, 'gateway.capnp')], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
