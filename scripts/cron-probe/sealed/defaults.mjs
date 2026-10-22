import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';

export async function checkedNativeDefaults() {
  const receipt = JSON.parse(await readFile('docs/evidence/m11c-runtime-binding.json', 'utf8'));
  const root = '.fogd/celld-binding-build2/source', sources = {};
  for (const name of ['crates/celld/engine_api.rs', 'crates/celld/actor.rs', 'crates/celld/runtime.rs', 'crates/celld/generation.rs', 'crates/celld/pool.rs', 'crates/logic/alarm.rs', 'crates/logic/lib.rs', 'crates/celld/main.rs', 'crates/celld/wake.rs', 'crates/celld/dead_node_gc.rs']) {
    const value = await readFile(join(root, name), 'utf8');
    assert.equal(createHash('sha256').update(value).digest('hex'), receipt.nativeBuild.sourceFiles[name], 'Default timing facts require the checked native source');
    sources[name] = { sha256: receipt.nativeBuild.sourceFiles[name], value };
  }
  assert.match(sources['crates/celld/engine_api.rs'].value, /positive_or\("CELLD_HANDLER_BUDGET_S", 300\)/);
  assert.match(sources['crates/celld/actor.rs'].value, /idle_evict_ms: crate::env_vars::positive::<u64>\("CELLD_IDLE_EVICT_S"\)\?/);
  assert.match(sources['crates/celld/actor.rs'].value, /DEFAULT_OPERATION_DEADLINE_MS: u64 = 15_000/);
  assert.match(sources['crates/celld/runtime.rs'].value, /REAP_INTERVAL: Duration = Duration::from_secs\(30\)/);
  assert.match(sources['crates/logic/alarm.rs'].value, /RETRY_CEILING: i64 = 6/);
  assert.match(sources['crates/logic/alarm.rs'].value, /BACKOFF_BASE_MS: Ms = 2_000/);
  assert.match(sources['crates/logic/alarm.rs'].value, /MAX_BACKOFF_SHIFT: i64 = 6/);
  assert.match(sources['crates/celld/main.rs'].value, /DEFAULT_REBALANCE_INTERVAL_MS: u64 = 5_000/);
  assert.match(sources['crates/celld/main.rs'].value, /positive::<u64>\("CELLD_WAKER_TICK_MS"\)\?\.unwrap_or\(60_000\)/);
  assert.match(sources['crates/celld/dead_node_gc.rs'].value, /lease_ttl_ms = tick_ms\.saturating_mul\(3\)/);
  assert.match(sources['crates/celld/wake.rs'].value, /tick_ms\.saturating_mul\(3\)/);
  assert.match(sources['crates/celld/actor.rs'].value, /positive_or\("CELLD_TTL_MS", 10_000\)/);
  return { rebalanceTickMs: 5000, wakerTickMs: 60000, wakerLeaseTtlMs: 180000, nodeLeaseTtlMs: 10000, alarmRetryCeiling: 6, alarmBackoffBaseMs: 2000, alarmMaxBackoffShift: 6, generationReapIntervalMs: 30000, handlerBudgetSeconds: 300, operationDeadlineMs: 15000, sourceFiles: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, source.sha256])) };
}

export async function verifyNativeTimingEnvironment(probe) {
  const rows = await projectContainers(probe.project);
  for (const slot of probe.slots) for (const host of slot.nodes) {
    const service = probe.config.services[host], actual = rows.find(row => row.Config.Labels['com.docker.compose.service'] === host);
    assert.ok(actual);
    for (const key of ['CELLD_HANDLER_BUDGET_S', 'CELLD_OPERATION_DEADLINE_MS', 'CELLD_WAKER_TICK_MS', 'CELLD_TTL_MS', 'FOGD_RESTART_DELAY_SECONDS', 'CELLD_REBALANCE_INTERVAL_MS', 'CELLD_IDLE_EVICT_S']) {
      assert.equal(service.environment[key], undefined); assert.ok(!actual.Config.Env.some(value => value.startsWith(key+'=')));
    }
  }
  return { hosts: probe.slots.flatMap(slot => slot.nodes), composeAndRunningEnvironmentChecked: true,
    absent: ['CELLD_HANDLER_BUDGET_S', 'CELLD_OPERATION_DEADLINE_MS', 'CELLD_WAKER_TICK_MS', 'CELLD_TTL_MS', 'FOGD_RESTART_DELAY_SECONDS', 'CELLD_REBALANCE_INTERVAL_MS', 'CELLD_IDLE_EVICT_S'] };
}
