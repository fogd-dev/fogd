import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export async function checkedNativeDefaults() {
  const receipt = JSON.parse(await readFile('docs/evidence/m11c-runtime-binding.json', 'utf8'));
  const root = '.fogd/celld-binding-build2/source', sources = {};
  for (const name of ['crates/celld/engine_api.rs', 'crates/celld/actor.rs', 'crates/celld/runtime.rs', 'crates/celld/generation.rs', 'crates/celld/pool.rs', 'crates/logic/alarm.rs', 'crates/logic/lib.rs']) {
    const value = await readFile(join(root, name), 'utf8');
    assert.equal(createHash('sha256').update(value).digest('hex'), receipt.nativeBuild.sourceFiles[name], 'Default timing facts require the checked native source');
    sources[name] = { sha256: receipt.nativeBuild.sourceFiles[name], value };
  }
  assert.match(sources['crates/celld/engine_api.rs'].value, /positive_or\("CELLD_HANDLER_BUDGET_S", 300\)/);
  assert.match(sources['crates/celld/actor.rs'].value, /DEFAULT_OPERATION_DEADLINE_MS: u64 = 15_000/);
  assert.match(sources['crates/celld/runtime.rs'].value, /REAP_INTERVAL: Duration = Duration::from_secs\(30\)/);
  return { generationReapIntervalMs: 30000, handlerBudgetSeconds: 300, operationDeadlineMs: 15000, sourceFiles: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, source.sha256])) };
}
