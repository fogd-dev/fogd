import { DispatchControl, initialControl, validateControl } from './dispatch-control.mjs';

const contract = { identity: 'queue', pattern: /^[a-zA-Z0-9_][a-zA-Z0-9_.:$-]*$/, noun: 'delivery', title: 'Delivery', outcomeCode: 'QUEUE_OUTCOME_UNKNOWN', validate: validateDelivery };

// Preserve the queue journal format and public interface over shared dispatch logic.
export function initialDelivery(queue, activation) { return initialControl(queue, activation, contract); }
export function validateDelivery(state) { validateControl(state, contract); }
export class Delivery extends DispatchControl {
  constructor(options) { super({ ...options, contract }); }
}
