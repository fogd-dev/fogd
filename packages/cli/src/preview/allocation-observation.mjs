import { previewServiceInspection } from './container-plan.mjs';
import { readPreviewHost } from './host-inventory.mjs';
import { assertRegisteredPreviewResources, hostRefusal } from './host-records.mjs';
import { assertPreviewAllocationImage, inspectPreviewGraph } from './stopped-graph.mjs';

// Reuse exact graph checks for lifecycle operations and read-only diagnostics.
// The caller owns any required fence; this observer never starts an operation.
export function previewAllocationObserver({ plan, envelope, allocationId, run, expectedImage, ...options }) {
  const specifications = previewServiceInspection(plan, envelope, options, allocationId);
  let image;
  return async (complete, records, phase) => {
    if (!image) {
      const images = JSON.parse(await run(['image', 'inspect', expectedImage]));
      if (!Array.isArray(images) || images.length !== 1) hostRefusal('allocation-image');
      assertPreviewAllocationImage(plan, images[0], expectedImage); image = images[0];
    }
    const observed = await readPreviewHost(run); assertRegisteredPreviewResources(observed, records);
    const graph = inspectPreviewGraph(plan, observed, image, specifications, allocationId, complete.identities, phase);
    if (graph.inventorySha256 !== complete.inventorySha256) hostRefusal('teardown-target');
    const roles = Object.fromEntries(Object.entries(plan.services).map(([role, service]) => [role, observed.containers.find(value => value.Name === '/' + service.name)]));
    return { observed, roles, graph };
  };
}
