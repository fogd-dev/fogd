import assert from 'node:assert/strict';
import { qualifyReleases } from './cron-probe/release/qualification.mjs';
import { failureClient } from './cron-probe/faults/client.mjs';
import { failureScenarios } from './cron-probe/faults/scenarios.mjs';
import { failurePostflight } from './cron-probe/faults/postflight.mjs';

assert.equal(process.argv.length, 3, 'Usage: node scripts/cron-sealed-failures.mjs NEW_PRIVATE_OUTPUT');
await qualifyReleases({ kind: 'failures', directory: process.argv[2], client: failureClient, scenarios: failureScenarios, postflight: failurePostflight,
  scope: 'Private guarded release-runtime failure profile on native defaults, with exact offline-built Void jobs. Native noRetry, owner-loss retry identity, counted sparse failure and autonomous overdue work after full-fleet downtime. No ordinary cron admission, general drain, CPU quota or exactly-once external effects.',
  message: 'PASS: guarded native noRetry, owner-loss retry identity, counted terminal failure and autonomous downtime recovery; offline artifacts checked, owned project stopped and volumes retained' });
