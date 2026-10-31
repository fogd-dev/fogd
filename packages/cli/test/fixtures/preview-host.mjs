import assert from 'node:assert/strict';

export function emptyPreviewDocker(memory = 6 * 1024 ** 3) {
  const host = { ID: 'engine-fixture', OSType: 'linux', Architecture: 'aarch64', Driver: 'overlay2', MemTotal: memory, NCPU: 8 };
  const records = { container: [], network: [], volume: [] }, calls = [];
  const run = async args => {
    calls.push(args);
    if (args[0] === 'info') return JSON.stringify(host);
    const values = records[args[0]]; assert.ok(values);
    if (args[1] === 'ls') return values.map(value => args[0] === 'volume' ? value.Name : value.Id).join('\n');
    assert.equal(args[1], 'inspect'); return JSON.stringify(values);
  };
  return { host, records, calls, run };
}
