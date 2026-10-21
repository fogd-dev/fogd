import { isDeepStrictEqual } from 'node:util';
// Experimental M11c transport. The controller must serialize publication and
// dispatch operations. Replica observations are not an atomic release fence.
export class CronRuntime {
  constructor({ run, inspect, verify, verifyBootstrap }) { Object.assign(this, { run, inspect, verify, verifyBootstrap }); }
  async preflight(slot) { return this.#verify(slot, this.verify); }
  async preflightBootstrap(slot) { return this.#verify(slot, this.verifyBootstrap); }
  async #verify(slot, verify) {
    assertNodes(slot);
    try {
      if (typeof verify !== 'function') throw new Error('Missing runtime identity policy');
      await verify(slot);
    } catch {
      const error = new Error('Cron runtime identity could not be verified; no command was sent');
      error.code = 'CRON_RUNTIME_UNVERIFIED';
      throw error;
    }
  }
  async #command(slot, script, verb) {
    return cronStatus(JSON.parse((await this.run(slot, ['cron', verb, script, '--json'])).trim()));
  }
  async status(slot, script) {
    assertScript(script);
    await this.preflight(slot);
    return this.#command(slot, script, 'info');
  }
  async pause(slot, script) { assertScript(script); return this.#mutate(slot, script, 'pause'); }
  async resume(slot, script, version) {
    assertReplicas(slot, version);
    // On the qualified patched runtime a cold cron cell starts held. Do not use
    // this transport on stock or mixed runtime versions; even info is unsafe.
    const status = await this.status(slot, script);
    if (!status.crons.length) {
      const error = new Error('Cannot resume an empty cron schedule');
      error.code = 'CRON_EMPTY_SCHEDULE';
      throw error;
    }
    const states = await Promise.all(slot.nodes.map(node => this.inspect(node)));
    assertCronGeneration(states, version, script);
    return this.#mutate(slot, script, 'resume');
  }
  async snapshot(slot, script, version) {
    try {
      assertReplicas(slot, version);
      const before = await this.status(slot, script);
      if (!before.paused || before.nextAlarm !== null) throw new Error('Snapshot requires a held schedule');
      assertCronGeneration(await Promise.all(slot.nodes.map(node => this.inspect(node))), version, script);
      const after = await this.status(slot, script);
      if (!isDeepStrictEqual(before, after)) throw new Error('Cron control changed during snapshot observation');
      return after;
    } catch (cause) {
      const error = new Error('Cron snapshot could not confirm the held approved runtime', { cause });
      error.code = 'CRON_SNAPSHOT_UNCONFIRMED'; throw error;
    }
  }
  async #mutate(slot, script, verb) {
    await this.preflight(slot);
    try {
      const reply = await this.#command(slot, script, verb);
      const observed = await this.status(slot, script);
      if (reply.paused !== (verb === 'pause') || observed.paused !== reply.paused || observed.revision < reply.revision) throw new Error('Cron dispatch state not confirmed');
      if (observed.paused && observed.nextAlarm !== null) throw new Error('Held cron alarm is still armed');
      return observed;
    } catch (cause) {
      const error = new Error(`Cron ${verb} outcome unknown; observe status before retrying`, { cause });
      error.code = 'CRON_OUTCOME_UNKNOWN';
      throw error;
    }
  }
}

function assertScript(script) {
  if (typeof script !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(script)) throw new Error('Invalid cron script name');
}

function cronStatus(value) {
  if (typeof value?.paused !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('Invalid cron control state');
  if (value.nextAlarm !== null && (!Number.isSafeInteger(value.nextAlarm) || value.nextAlarm < 0)) throw new Error('Invalid cron alarm observation');
  if (!Array.isArray(value.crons) || !value.crons.every(cron => typeof cron === 'string' && cron.length > 0)) throw new Error('Invalid cron expressions');
  // A null alarm is also possible during a running callback. Expose it without
  // inferring a drain, cancellation or application outcome.
  return { paused: value.paused, revision: value.revision, nextAlarm: value.nextAlarm, crons: [...value.crons] };
}

function assertCronGeneration(states, version, script) {
  const residents = [];
  for (const state of states) {
    if (!state || state.version !== version || !Number.isSafeInteger(state.generation) || state.generation < 0 || !state.cells || typeof state.cells !== 'object' || Array.isArray(state.cells)) throw new Error('Replica is not on the approved runtime version');
    for (const [cell, generation] of Object.entries(state.cells)) {
      if (!cell.startsWith('.cron:')) continue;
      if (generation !== state.generation) throw new Error('Cron belongs to an old runtime generation');
      residents.push(cell);
    }
  }
  if (residents.length !== 1 || residents[0] !== `.cron:${script}`) throw new Error('Expected exactly one resident cron cell for the approved script');
}

function assertReplicas(slot, version) {
  if (typeof version !== 'string' || !version) throw new Error('Approved runtime version required');
  assertNodes(slot);
}

function assertNodes(slot) {
  if (!Array.isArray(slot?.nodes) || !slot.nodes.length || !slot.nodes.every(node => typeof node === 'string' && node.length > 0) || new Set(slot.nodes).size !== slot.nodes.length) throw new Error('Distinct replica nodes required');
}
