import { validateRoutePolicy } from './route-record.mjs';

export const durableGatewayModules = Object.freeze(['gateway-durable.js', 'gateway-authority.mjs', 'gateway-forward.mjs', 'route-record.mjs']);
const invalid = () => { throw new Error('Invalid durable gateway configuration'); };
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
function gatewayNodes(slots, policy) {
  if (!Array.isArray(slots) || slots.length !== policy.slots.length) return invalid();
  const nodes = [], seen = new Set();
  for (const slot of slots) {
    if (!keys(slot, ['id', 'nodes']) || !policy.slots.includes(slot.id) || seen.has(slot.id) || !Array.isArray(slot.nodes) || slot.nodes.length !== 2) return invalid();
    seen.add(slot.id);
    for (const [index, host] of slot.nodes.entries()) {
      if (typeof host !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) || nodes.some(node => node.host === host)) return invalid();
      nodes.push({ name: `${slot.id}-${index}`, host });
    }
  }
  return nodes;
}
function gatewayListen(value) {
  const match = typeof value === 'string' && /^(?:\*|127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(value);
  if (!match || Number(match[1]) > 65535) return invalid();
  return value;
}
export function durableGatewayConfig({ policy, slots, authorityPath, listen, tls = false }) {
  try { validateRoutePolicy(policy); } catch { return invalid(); }
  if (typeof tls !== 'boolean' || typeof authorityPath !== 'string' || !/^\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(authorityPath) || authorityPath.split('/').some(part => part === '.' || part === '..')) return invalid();
  gatewayListen(listen); const nodes = gatewayNodes(slots, policy), q = JSON.stringify;
  const modules = durableGatewayModules;
  const bindings = ['(name = "ROUTE_AUTHORITY", service = "authority")', `(name = "ROUTE_POLICY", text = ${q(JSON.stringify(policy))})`,
    ...nodes.map(node => `(name = ${q(node.name)}, service = ${q(node.name)})`)];
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "gateway", worker = (
      modules = [${modules.map(name => `(name = ${q(name)}, esModule = embed ${q(name)})`).join(',')}],
      compatibilityDate = "2026-02-24",
      bindings = [${bindings.join(',')}]
    )),
    (name = "authority", disk = (path = ${q(authorityPath)}, writable = false)),
    (name = "internet", network = (allow = [])),
    ${nodes.map(node => `(name = ${q(node.name)}, external = (address = ${q(node.host + ':8080')}, http = ()))`).join(',')}
  ],
  sockets = [(name = "http", address = ${q(listen)}, ${tls ? 'https = (options = (), tlsOptions = (keypair = (privateKey = embed "key.pem", certificateChain = embed "cert.pem")))' : 'http = ()'}, service = "gateway")]
);
`;
}
