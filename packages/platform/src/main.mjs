import { Controller } from './controller.mjs';
import { Backend } from './backend.mjs';
import { server } from './http.mjs';

const required = key => { const value = process.env[key]; if (!value) throw new Error(`${key} is required; run fogd up to initialize local credentials`); return value; };
const credentials = { user: required('FOGD_ADMIN_USER'), password: required('FOGD_ADMIN_PASSWORD'), deploy: required('FOGD_DEPLOY_TOKEN'), gateway: required('FOGD_GATEWAY_TOKEN') };
const slots = JSON.parse(required('FOGD_SLOTS'));
if (!Array.isArray(slots) || !slots.length || new Set(slots.map(s => s.id)).size !== slots.length || new Set(slots.map(s => s.prefix)).size !== slots.length) throw new Error('Invalid fleet slots');
for (const slot of slots) {
  if (!/^[a-z0-9-]+$/.test(slot.id) || !/^[a-z0-9/-]+$/.test(slot.prefix) || slot.prefix.split('/').some(p => !p || p === '..') || slot.nodes.length !== 2 || slot.nodes.some(n => !/^[a-z0-9.-]+$/.test(n))) throw new Error('Invalid fleet configuration');
}
const controller = new Controller({ dir: process.env.FOGD_DATA_DIR || '/var/lib/fogd', slots, backend: new Backend(), baseDomain: process.env.FOGD_BASE_DOMAIN || 'localhost', maxPending: Number(process.env.FOGD_MAX_PENDING || 20) });
await controller.init();
const http = server(controller, credentials);
http.listen(Number(process.env.FOGD_CONTROL_PORT || 8082), process.env.FOGD_CONTROL_BIND || '0.0.0.0', () => console.log('fogd approval controller ready'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { http.close(); setTimeout(() => process.exit(), 30000).unref(); });
