import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedOfflineMounts } from './offline-mounts.mjs';

function fixture(type = 'volume') {
  const input = type === 'volume' ? 'inputs' : '/checkout';
  const args = ['run', '--mount', `type=${type},src=${input},dst=/source,readonly${type === 'volume' ? ',volume-subpath=tree' : ''}`,
    '--mount', 'type=volume,src=results,dst=/results'];
  const container = { HostConfig: { Mounts: [
    { Type: type, Source: input, Target: '/source', ReadOnly: true, ...(type === 'volume' ? { VolumeOptions: { Subpath: 'tree' } } : {}) },
    { Type: 'volume', Source: 'results', Target: '/results', ReadOnly: false },
  ] }, Mounts: [
    { Type: type, ...(type === 'volume' ? { Name: input } : {}), Source: type === 'volume' ? '/daemon/inputs/tree' : input, Destination: '/source', RW: false },
    { Type: 'volume', Name: 'results', Source: '/daemon/results', Destination: '/results', RW: true },
  ] };
  return { args, container };
}
for (const type of ['bind', 'volume']) test(`offline policy binds the declared read-only ${type} source and writable results`, () => {
  const f = fixture(type), report = checkedOfflineMounts(f.container, f.args);
  assert.deepEqual(report.map(m => [m.destination, m.writable]), [['/results', true], ['/source', false]]);
  assert.equal(report[1].type, type); assert.equal(report[1].source, type === 'volume' ? 'inputs' : '/checkout');
  assert.equal(report[1].subpath, type === 'volume' ? 'tree' : null);
});
for (const [name, mutate] of [
  ['changed subdirectory', f => { f.container.HostConfig.Mounts[0].VolumeOptions.Subpath = 'other'; }],
  ['writable input declaration', f => { f.args[2] = f.args[2].replace(',readonly', ''); f.container.HostConfig.Mounts[0].ReadOnly = false; f.container.Mounts[0].RW = true; }],
  ['changed actual source', f => { f.container.Mounts[0].Name = 'other'; }],
  ['extra undeclared mount', f => { f.container.Mounts.push({ Type: 'bind', Source: '/docker.sock', Destination: '/socket', RW: true }); }],
  ['read-only results', f => { f.args[4] += ',readonly'; f.container.HostConfig.Mounts[1].ReadOnly = true; f.container.Mounts[1].RW = false; }],
]) test(`offline policy refuses ${name}`, () => {
  const f = fixture(); mutate(f); assert.throws(() => checkedOfflineMounts(f.container, f.args), { code: 'ERR_ASSERTION' });
});
