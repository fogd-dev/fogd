import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const dir = process.env.FOGD_RUNTIME_DIR || '/tmp/fogd-gateway';
await mkdir(dir, { recursive: true });
await copyFile(new URL('./gateway.js', import.meta.url), join(dir, 'gateway.js'));
const q = JSON.stringify;
const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "gateway", worker = (
      modules = [(name = "gateway.js", esModule = embed "gateway.js")],
      compatibilityDate = "2026-02-24",
      bindings = [
        (name = "APP_HOST", text = ${q(process.env.FOGD_APP_HOST || 'hello.localhost')}),
        (name = "NODE_A", service = "node-a"),
        (name = "NODE_B", service = "node-b")
      ]
    )),
    (name = "node-a", external = (address = ${q(process.env.FOGD_NODE_A || 'celld-a:8080')}, http = ())),
    (name = "node-b", external = (address = ${q(process.env.FOGD_NODE_B || 'celld-b:8080')}, http = ()))
  ],
  sockets = [(name = "http", address = ${q(process.env.FOGD_LISTEN || '*:8080')}, http = (), service = "gateway")]
);
`;
await writeFile(join(dir, 'gateway.capnp'), config);
const child = spawn('workerd', ['serve', join(dir, 'gateway.capnp')], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
