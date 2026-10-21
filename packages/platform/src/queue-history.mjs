import { isDeepStrictEqual } from 'node:util';
import { translateQueues } from '@fogd/runtime/queues';

import { artifactOnlyBackgroundRequest } from './background-history.mjs';

export function artifactOnlyQueueRequest(state, request) {
  return artifactOnlyBackgroundRequest(state, request, 'fogd-queue-activation-v1',
    (resources, app) => Boolean(resources.queues) && isDeepStrictEqual(translateQueues(resources.queues, app), resources.queues));
}

export function hasQueueLifecycle(app) {
  return Boolean(app.resources && Object.hasOwn(app.resources, 'queues')) ||
    ['delivery', 'queueBootstrap', 'queueSnapshot', 'queueRecovery', 'deliveryRecoveryError'].some(field => Object.hasOwn(app, field)) || Boolean(app.retirement?.queue);
}
