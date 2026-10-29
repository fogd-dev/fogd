import assert from 'node:assert/strict';

export function checkedOfflineMounts(container, args) {
  const expected = args.flatMap((value, index) => value === '--mount' ? [args[index + 1]] : []).map(value => {
    const fields = Object.fromEntries(value.split(',').map(field => field.split('=')));
    assert.ok(['bind', 'volume'].includes(fields.type));
    return { type: fields.type, source: fields.src, destination: fields.dst, writable: !value.split(',').includes('readonly'), subpath: fields['volume-subpath'] || null };
  }).sort((a, b) => a.destination.localeCompare(b.destination));
  assert.ok(expected.some(m => m.destination === '/results' && m.writable));
  assert.ok(expected.every(m => m.destination === '/results' || !m.writable && /^\/(?:source(?:\/|$)|app\/)/.test(m.destination)));
  const actual = container.HostConfig.Mounts.map(m => ({ type: m.Type, source: m.Source, destination: m.Target, writable: !m.ReadOnly, subpath: m.VolumeOptions?.Subpath || null }))
    .sort((a, b) => a.destination.localeCompare(b.destination));
  assert.deepEqual(actual, expected, 'Offline mounts differ from requested sources');
  assert.equal(container.Mounts.length, expected.length);
  for (const mount of container.Mounts) {
    const selected = expected.find(m => m.destination === mount.Destination); assert.ok(selected);
    assert.equal(mount.Type, selected.type); assert.equal(mount.RW, selected.writable);
    assert.equal(mount.Type === 'volume' ? mount.Name : mount.Source, selected.source);
  }
  return actual;
}
