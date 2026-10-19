import { createHash, createHmac } from 'node:crypto';
import { queueRetentionContract } from './queue-snapshot.mjs';

// Internal M11a primitive. Admission must constrain the fleet to one consumed queue.
// Callers serialize publication and queue operations; this is an observation gate,
// not an atomic fence against an independent publisher or a drain receipt.
export class QueueRuntime {
  constructor({ run, inspect }) { Object.assign(this, { run, inspect }); }
  async #command(slot, name, verb) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.:$-]*$/.test(name)) throw new Error('Invalid queue name');
    return JSON.parse((await this.run(slot, ['queue', verb, name, '--json'])).trim());
  }
  async status(slot, name) {
    const value = await this.#command(slot, name, 'info');
    if (typeof value?.paused !== 'boolean' || !['stored', 'backlogCount', 'backlogBytes'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) throw new Error('Invalid queue status');
    const oldest = value.oldestMessageTimestamp;
    if (oldest !== null && (!Number.isSafeInteger(oldest) || oldest < 0)) throw new Error('Invalid oldest message timestamp');
    return { paused: value.paused, stored: value.stored, backlogCount: value.backlogCount, backlogBytes: value.backlogBytes, oldestMessageTimestamp: oldest };
  }
  async pause(slot, name) {
    return this.#mutate(slot, name, 'pause');
  }
  async snapshot(slot, name, version) {
    try {
      if ((await this.run(slot, ['--version'])).trim() !== queueRetentionContract.runtime) throw new Error('Queue retention requires the pinned runtime contract');
      const status = await this.status(slot, name);
      const states = await Promise.all(slot.nodes.map(node => this.inspect(node)));
      assertQueueGeneration(states, slot.nodes.length, version, queueCell(name));
      return status;
    } catch (cause) {
      const error = new Error('Approved queue generation or pinned retention runtime could not be confirmed', { cause });
      error.code = 'QUEUE_SNAPSHOT_UNCONFIRMED'; throw error;
    }
  }
  async #mutate(slot, name, verb) {
    try {
      await this.#command(slot, name, verb);
      return await this.#confirm(slot, name, verb === 'pause');
    } catch (cause) {
      const error = new Error(`Queue ${verb} outcome unknown; observe status before retrying`, { cause });
      error.code = 'QUEUE_OUTCOME_UNKNOWN';
      throw error;
    }
  }
  async #confirm(slot, name, paused) {
    const status = await this.status(slot, name);
    if (status.paused !== paused) throw new Error('Queue delivery state not confirmed');
    return status;
  }
  async resume(slot, name, version) {
    if (typeof version !== 'string' || !version) throw new Error('Approved runtime version required');
    // An info call materializes a cold queue cell before checking its generation.
    await this.status(slot, name);
    const states = await Promise.all(slot.nodes.map(node => this.inspect(node)));
    assertQueueGeneration(states, slot.nodes.length, version, queueCell(name));
    return this.#mutate(slot, name, 'resume');
  }
}

export function assertQueueGeneration(states, replicas, version, expectedCell) {
  if (!replicas || states.length !== replicas) throw new Error('Missing replica observations');
  const queues = [];
  for (const state of states) {
    assertReplicaVersion(state, version);
    for (const [cell, generation] of Object.entries(state.cells)) {
      if (cell.startsWith('__Queue:')) {
        if (generation !== state.generation) throw new Error('Queue belongs to an old runtime generation');
        queues.push(cell);
      }
    }
  }
  // info materialized the selected queue. More than one resident queue is outside
  // the initial single-queue contract, even if all happen to use the same release.
  if (queues.length !== 1 || queues[0] !== expectedCell) throw new Error('Expected exactly one resident queue cell');
}

// Pinned celld engine_api.rs: durable_object_id_for_name + queue_cell_scope.
// Names use the shared queue namespace; changing this upstream requires requalification.
export function queueCell(name) {
  const key = createHash('sha256').update('cells:v1:queue:__Queue').digest();
  const head = createHmac('sha256', key).update(name).digest().subarray(0, 16);
  const tail = createHmac('sha256', key).update(head).digest().subarray(0, 16);
  return '__Queue:' + Buffer.concat([head, tail]).toString('hex');
}

function assertReplicaVersion(state, version) {
  if (!state || state.version !== version || !Number.isSafeInteger(state.generation) || state.generation < 0 || !state.cells || typeof state.cells !== 'object' || Array.isArray(state.cells)) throw new Error('Replica is not on the approved runtime version');
}
