import { QueueRuntime } from '../../packages/platform/src/queue-runtime.mjs';
export function queueRuntime(probe) {
  return new QueueRuntime({ run: (slot, args) => probe.cli(args, slot), inspect: node => probe.deployment(node) });
}
