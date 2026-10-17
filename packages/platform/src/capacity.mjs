export function pendingDeployments(controller) {
  return Object.values(controller.state.deployments).filter(d => ['pending', 'failed'].includes(d.status));
}

export function capacity(controller) {
  const pending = pendingDeployments(controller);
  const slots = controller.slots.map(slot => {
    const owners = Object.entries(controller.state.apps).filter(([, app]) => app.slot === slot.id)
      .map(([name, app]) => ({ app: name, route: app.route, quarantined: Boolean(app.quarantined) }));
    return { id: slot.id, bucketOwner: controller.bucketOwners.get(slot.id) || null, occupied: controller.occupied.has(slot.id) || owners.length > 0, assignments: owners };
  });
  const byCredential = new Map();
  for (const request of pending) byCredential.set(request.submitter, (byCredential.get(request.submitter) || 0) + 1);
  return {
    observation: 'Controller assignments and cached bucket owners; refreshed on startup and claims. Pending submissions do not reserve slots.',
    slots: { configured: slots.length, occupied: slots.filter(s => s.occupied).length, available: slots.filter(s => !s.occupied).length, items: slots },
    submissions: {
      pending: pending.length, limit: controller.maxPending,
      perCredentialLimit: controller.maxPendingPerCredential,
      byCredential: [...byCredential].map(([id, count]) => ({ id, pending: count, limit: id === 'team-token' ? null : controller.maxPendingPerCredential })),
    },
    artifacts: { ...controller.quota.describe(), accounting: 'retained decoded artifact files, including rejected and superseded deployments; excludes application data and filesystem allocation' },
  };
}
