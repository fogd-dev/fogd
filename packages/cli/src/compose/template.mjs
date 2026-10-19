import { addFleet } from './add-fleet.mjs';
const setting = (name, fallback) => '${' + name + ':-' + fallback + '}';
export function fleetCount(value) {
  if (!['2', '3'].includes(String(value))) throw new Error('Docker fleet count must be 2 or 3');
  return Number(value);
}
// Compose expands YAML anchors while --no-interpolate preserves runtime settings.
export function extendTemplate(base, count) {
  count = fleetCount(count);
  const config = structuredClone(base);
  clearDerivedNames(config);
  for (const key of Object.keys(config)) if (key.startsWith('x-')) delete config[key];
  // --no-interpolate normalizes the source's interpolated name incorrectly.
  // Require an explicit installation identity instead of inferring one from output paths.
  config.name = '${COMPOSE_PROJECT_NAME:?Set COMPOSE_PROJECT_NAME for rendered installations}';
  if (count === 2) return config;
  const slots = JSON.parse(config.services.controller.environment.FOGD_SLOTS);
  if (slots.length !== 2 || config.services.workerd.environment.FOGD_SLOTS !== config.services.controller.environment.FOGD_SLOTS) throw new Error('Expected the two-fleet source Compose template');
  const slot = { id: 'slot-3', prefix: setting('FOGD_SLOT_3_PREFIX', 'slots/slot-3'), nodes: ['A', 'B'].map(letter => setting(`FOGD_SLOT_3_${letter}_HOST`, `slot-3-${letter.toLowerCase()}`)) };
  const nodeIds = ['A', 'B'].map(letter => setting(`FOGD_SLOT_3_${letter}_ID`, `slot-3-${letter.toLowerCase()}`));
  return addFleet(config, 'slot-2', slot, nodeIds);
}

function clearDerivedNames(config) {
  for (const kind of ['volumes', 'networks']) for (const [name, item] of Object.entries(config[kind] || {})) {
    if (item.external || (item.name && item.name !== `${config.name}_${name}`)) throw new Error('Rendering requires project-owned resource names in the source template');
    delete item.name;
  }
}
