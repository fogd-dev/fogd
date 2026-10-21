import test from 'node:test';
import assert from 'node:assert/strict';
import { checkContainer } from '../src/recovery/inventory.mjs';
import { checkMounts } from '../src/recovery/container-isolation.mjs';

function fixture() {
  const service = { read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
    tmpfs: ['/tmp:rw,noexec,nosuid,nodev'], environment: { TOKEN: 'private-value' },
    command: ['node', 'main.mjs'], volumes: [{ type: 'volume', source: 'data', target: '/data' }] };
  const image = { Config: { Cmd: ['node', 'main.mjs'], Entrypoint: null } };
  const container = { Config: { ...image.Config, Env: ['TOKEN=private-value'] },
    HostConfig: { ReadonlyRootfs: true, Privileged: false, CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev' } },
    Mounts: [{ Type: 'volume', Name: 'owned_data', Destination: '/data', RW: true }] };
  return { service, image, container, volumes: { data: { name: 'owned_data' } } };
}
test('sealed inventory accepts declared temporary storage without weakening program or volume permissions', () => {
  const f = fixture(); checkContainer(f.service, f.container, f.image); checkMounts(f.service, f.container, f.volumes);
  f.container.HostConfig.ReadonlyRootfs = false;
  assert.throws(() => checkContainer(f.service, f.container, f.image), /root filesystem differs/);
});
test('inventory refuses undeclared temporary storage, writable read-only volumes and weaker launch restrictions', () => {
  for (const alter of [
    f => { f.container.HostConfig.Tmpfs = { '/app': 'rw' }; },
    f => { f.container.HostConfig.Tmpfs = { '/tmp': 'rw,exec' }; },
    f => { f.container.HostConfig.CapDrop = []; },
    f => { f.container.HostConfig.SecurityOpt = []; },
    f => { f.container.HostConfig.Privileged = true; },
    f => { f.container.HostConfig.CapAdd = ['SYS_ADMIN']; },
    f => { f.service.tmpfs = ['/app']; },
    f => { f.container.Mounts.push({ Type: 'tmpfs', Destination: '/app', RW: true }); },
  ]) {
    const f = fixture(); alter(f);
    assert.throws(() => checkContainer(f.service, f.container, f.image), error =>
      /^(Container (temporary filesystem|launch restrictions|privilege)|Backup supports only|Unexpected container temporary mount)/.test(error.message) &&
      !error.message.includes('private-value'));
  }
  const f = fixture(); f.service.volumes[0].read_only = true;
  assert.throws(() => checkMounts(f.service, f.container, f.volumes), /write permissions differ/);
});
test('ordinary inventory keeps the existing undeclared-isolation path but refuses a hidden tmpfs', () => {
  const f = fixture();
  f.service = { environment: f.service.environment, command: f.service.command };
  f.container.HostConfig = {};
  checkContainer(f.service, f.container, f.image);
  f.container.HostConfig.Tmpfs = { '/app': 'rw' };
  assert.throws(() => checkContainer(f.service, f.container, f.image), /temporary filesystem differs/);
});
test('ordinary inventory accepts declared read-only TLS storage and rejects a writable replacement', () => {
  const service = { volumes: [{ type: 'volume', source: 'tls', target: '/tls', read_only: true }] };
  const container = { Mounts: [{ Type: 'volume', Name: 'owned_tls', Destination: '/tls', RW: false }] };
  const volumes = { tls: { name: 'owned_tls' } };
  checkMounts(service, container, volumes);
  container.Mounts[0].RW = true;
  assert.throws(() => checkMounts(service, container, volumes), /write permissions differ/);
});
