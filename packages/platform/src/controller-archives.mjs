import { archiveRotationReview, stageArchiveRotationSecrets, rotateAppArchiveRecovery } from './app-archive-rotation.mjs';
import { appArchiveRotationCapability } from './app-archive-rotation-state.mjs';
import { isDeepStrictEqual } from 'node:util';
import { appArchiveCapability, validateAppArchives } from './app-archive.mjs';
import { approveAppArchiveRecovery } from './app-archive-approval.mjs';
import { decisionReviewToken } from './decision-history.mjs';
import { hasDurableRuntimeMode, validateRuntimePolicy } from './runtime-policy.mjs';
import { routePolicy } from './route-restoration-plan.mjs';
import { recoverQueueSnapshots } from './queue-recovery.mjs';
import { recoverCronSnapshots } from './cron-recovery.mjs';
import { archiveHeld } from './app-archive-gate.mjs';

const unavailable = () => Object.assign(new Error('App has no available archive recovery review'), { code: 'APP_ARCHIVE_REVIEW_UNAVAILABLE' });

export class ControllerArchives {
  #profile;
  constructor(controller, profile) {
    this.controller = controller;
    this.#profile = profile === null ? null : validateRuntimePolicy(profile);
    if (!this.enabled) return;
    const slots = this.#profile.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
    if (!hasDurableRuntimeMode(this.#profile) || !controller.routes.durable || !isDeepStrictEqual(slots, controller.slots) ||
      !isDeepStrictEqual(routePolicy(this.#profile), controller.routes.options.policy)) throw unavailable();
  }
  get enabled() { return this.#profile !== null; }
  // Archive protocol validation owns detached records. Existing validators receive
  // only live apps; retained releases and pins stay accounted. This view is never persisted.
  liveState(state) {
    if (!this.enabled) {
      if (Object.hasOwn(state, 'appArchives') || Object.values(state.apps).some(archiveHeld)) throw new Error('Controller state requires an unsupported platform capability');
      return state;
    }
    validateAppArchives(state, this.#profile);
    const archived = new Set(Object.entries(state.apps).filter(([, app]) => app.archive).map(([name]) => name));
    return { ...state, requirements: state.requirements.filter(value => ![appArchiveCapability, appArchiveRotationCapability].includes(value)),
      apps: Object.fromEntries(Object.entries(state.apps).filter(([name]) => !archived.has(name))) };
  }
  #record(name) {
    if (!this.enabled) throw unavailable();
    const records = validateAppArchives(this.controller.state, this.#profile), app = this.controller.state.apps[name];
    const record = records[app?.archiveRecovery?.archive];
    if (record?.status !== 'restored' || record.name !== name) throw unavailable();
    return record;
  }
  review(name) {
    return this.controller.exclusive(async () => {
      await this.controller.routes.checkReady();
      const record = this.#record(name);
      if (this.controller.state.apps[name].archiveRecovery.rotation) throw unavailable();
      const release = this.controller.state.deployments[record.app.active];
      return { app: name, state: 'pending', execution: 'held',
        selection: { archive: record.id, identity: record.identity, snapshot: record.restoration.snapshot,
          deployment: release.id, digest: release.digest, secretRevision: release.secretRevision },
        review: decisionReviewToken(this.controller, release.id),
        notice: 'Approve the exact retained release before resuming HTTP or acknowledging background recovery. Approval leaves execution held.' };
    });
  }
  reviewRotation(name) {
    return this.controller.exclusive(async () => {
      await this.controller.routes.checkReady(); this.#record(name);
      return archiveRotationReview(this.controller, this.#profile, name);
    });
  }
  stageRotation(name, input) { return stageArchiveRotationSecrets(this.controller, this.#profile, name, input); }
  async rotate(name, input, context) {
    const record = this.#record(name);
    if (input?.archive !== record.id) throw unavailable();
    const result = await rotateAppArchiveRecovery(this.controller, this.#profile, input, context);
    return this.#diagnose(result);
  }
  #diagnose(result) {
    return this.controller.exclusive(async () => {
      await recoverQueueSnapshots(this.controller); await recoverCronSnapshots(this.controller);
      return result;
    });
  }
  async approve(name, input, context) {
    const record = this.#record(name);
    if (input?.archive !== record.id) throw unavailable();
    const result = await approveAppArchiveRecovery(this.controller, this.#profile, input, context);
    // Diagnosis follows the saved owner approval. It may pause/inspect native
    // controls, but cannot acknowledge recovery or resume execution.
    return this.#diagnose(result);
  }
}
