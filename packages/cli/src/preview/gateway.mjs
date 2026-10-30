import { mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gatewayExecutable, assertGatewayExecutable } from '../../../runtime/src/gateway-executable.mjs';
import { previewControlSlots } from './control.mjs';
import { supervisePreviewProcess } from './supervisor.mjs';

export function previewGatewayConfig(input) {
  const nodes = previewControlSlots(input.grant.preview).flatMap(slot => slot.nodes.map((host, i) => ({ name: `${slot.id}-${i}`, address: `${host}:8080` })));
  nodes.push({ name: 'CONTROLLER', address: 'controller:8083' });
  const q = JSON.stringify, bindings = nodes.map(node => `(name=${q(node.name)}, service=${q(node.name)})`);
  bindings.push(`(name="APP_HOST",text=${q(new URL(input.grant.target.origin).hostname)})`, `(name="GATEWAY_TOKEN",text=${q(input.config.gatewayToken)})`);
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name="gateway",worker=(modules=[(name="gateway.js",esModule=embed "gateway.js")],compatibilityDate="2026-02-24",bindings=[${bindings.join(',')}])),
    ${nodes.map(node => `(name=${q(node.name)},external=(address=${q(node.address)},http=()))`).join(',')}],
  sockets=[(name="https",address="*:8080",https=(options=(),tlsOptions=(keypair=(privateKey=embed "key.pem",certificateChain=embed "cert.pem"))),service="gateway")]
);`;
}

export async function runPreviewGateway(input, signal) {
  await assertGatewayExecutable();
  const directory = await mkdtemp(join(tmpdir(), 'fogd-preview-gateway-'));
  let observed;
  try {
    for (const [name, bytes] of [['key.pem', input.config.tls.key], ['cert.pem', input.config.tls.cert], ['gateway.capnp', previewGatewayConfig(input)]]) await writeFile(join(directory, name), bytes, { mode: 0o600, flag: 'wx' });
    await copyFile(new URL('../../../runtime/src/gateway.js', import.meta.url), join(directory, 'gateway.js'));
    observed = await supervisePreviewProcess({ executable: gatewayExecutable, args: ['serve', join(directory, 'gateway.capnp')], env: {}, expiresAt: input.grant.expiresAt, signal });
    return observed;
  } finally {
    // Missing child-exit observation retains its private files for inspection.
    if (observed?.childExitConfirmed) await rm(directory, { recursive: true, force: true });
  }
}
