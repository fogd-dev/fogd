import { isDeepStrictEqual } from 'node:util';
import { isIP } from 'node:net';
import { transportPolicy } from '@fogd/runtime/transport';

// A storage identity does not authorize exposing internal native/storage ports.
export function assertRecoveryIngress(config) {
  const controller = config.services.controller, gateway = config.services.workerd;
  if (!isDeepStrictEqual(transportPolicy(controller.environment), transportPolicy(gateway.environment))) throw new Error('Recovery transport profiles differ');
  const bind = controller.environment.FOGD_PUBLIC_BIND_ADDRESS || '127.0.0.1';
  if (!isIP(bind) || (gateway.environment.FOGD_PUBLIC_BIND_ADDRESS || '127.0.0.1') !== bind) throw new Error('Recovery public bind addresses differ');
  const occupied = new Set();
  for (const [name, service] of Object.entries(config.services)) {
    const ports = service.ports || [], target = { controller: 8082, workerd: 8080 }[name];
    if (!Array.isArray(ports) || ports.length > (target ? 1 : 0)) throw new Error('Recovery refuses extra published listeners');
    for (const port of ports) {
      assertPublicPort(port, target, bind);
      if (occupied.has(String(port.published))) throw new Error('Recovery published listeners overlap');
      occupied.add(String(port.published));
    }
  }
}

function assertPublicPort(port, target, bind) {
  if (!port || typeof port !== 'object' || !isDeepStrictEqual(Object.keys(port).sort(), ['host_ip', 'mode', 'protocol', 'published', 'target']) ||
    port.mode !== 'ingress' || port.protocol !== 'tcp' || port.target !== target || port.host_ip !== bind ||
    !/^[1-9][0-9]{0,4}$/.test(String(port.published)) || Number(port.published) > 65535) throw new Error('Recovery refuses unsupported published listeners');
}
