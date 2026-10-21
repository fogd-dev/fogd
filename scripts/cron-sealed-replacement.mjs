import assert from 'node:assert/strict';
import { qualifyReleases } from './cron-probe/release/qualification.mjs';
import { replacementClient } from './cron-probe/replacement/client.mjs';
import { replacementScenarios } from './cron-probe/replacement/scenarios.mjs';
import { rejectedPublicationGate } from './cron-probe/replacement/rejected-gate.mjs';
import { replacementPostflight } from './cron-probe/replacement/postflight.mjs';

const failureCheck = process.argv[3] === '--failure-check';
assert.ok(process.argv.length === 3 || (process.argv.length === 4 && failureCheck), 'Usage: node scripts/cron-sealed-replacement.mjs NEW_PRIVATE_OUTPUT [--failure-check]');
await qualifyReleases({ kind: 'replacement', directory: process.argv[2], failureCheck, client: replacementClient, scenarios: replacementScenarios, rejected: rejectedPublicationGate, postflight: replacementPostflight,
  scope: 'Private guarded release-runtime replacement on native defaults, with exact artifacts produced by offline ordinary Void/fogd builds. No normal cron admission or generic drain/replay guarantee.',
  message: 'PASS: guarded replacement preserves migration overlap, measured unfinished work and retry identity on native defaults; offline-built artifacts checked, owned project stopped and volumes retained' });
