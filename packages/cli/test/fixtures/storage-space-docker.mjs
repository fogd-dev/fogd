import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2), file = process.env.FOGD_SPACE_DATA, state = JSON.parse(readFileSync(file)), { config, entry } = state;
appendFileSync(process.env.FOGD_TEST_LOG, JSON.stringify(args) + '\n');
const output = value => console.log(JSON.stringify(value));
if (args[0] === 'info') output({ ID: state.sampled && process.env.FOGD_SPACE_CHANGED_ENGINE ? 'other-engine' : 'test-engine', DockerRootDir: '/var/lib/docker', OSType: 'linux', Architecture: 'arm64', Driver: 'overlay2' });
else if (args[0] === 'volume' && args[1] === 'ls') console.log(Object.entries(config.volumes).filter(([role]) => process.env.FOGD_SPACE_MISSING !== 'all' && role !== process.env.FOGD_SPACE_MISSING && !(state.sampled && process.env.FOGD_SPACE_DISAPPEARS === role)).map(([, value]) => value.name).join('\n'));
else if (args[0] === 'volume' && args[1] === 'inspect') output(args.slice(2).map(Name => {
  const role = Object.keys(config.volumes).find(key => config.volumes[key].name === Name);
  return { Name, CreatedAt: '2026-10-23T02:00:00Z', Driver: process.env.FOGD_SPACE_DRIVER || 'local', Options: process.env.FOGD_SPACE_OPTIONS ? { device: '/private/foreign' } : null,
    Mountpoint: process.env.FOGD_SPACE_BAD_PATH ? '/private/foreign' : `/var/lib/docker/volumes/${Name}/_data`,
    Labels: { 'com.docker.compose.project': process.env.FOGD_SPACE_FOREIGN === role ? 'foreign' : config.name, 'com.docker.compose.volume': role } };
}));
else if (args[0] === 'image' && args[1] === 'inspect') output([{ Id: args.at(-1), Os: 'linux', Architecture: 'arm64', Config: { WorkingDir: '/app', Env: ['PATH=/usr/local/bin:/usr/bin:/bin'] } }]);
else if (args[0] === 'run') {
  const code = args.at(-1);
  if (code.includes('Runtime program must not be a symlink')) output({ binarySha256: entry.binarySha256, supervisorSha256: entry.supervisorSha256 });
  else if (code.includes('programInventory')) output(entry.sourceFiles);
  else if (code.includes('readRuntimePolicy')) output(state.policy);
  else if (code.includes('statfsSync')) {
    state.sampled = true; state.helper = process.env.FOGD_SPACE_LEFTOVER === '1'; writeFileSync(file, JSON.stringify(state));
    if (process.env.FOGD_SPACE_HELPER_FAIL) { console.log('private-helper-diagnostic'); process.exit(17); }
    if (process.env.FOGD_SPACE_BAD_OUTPUT) { console.log('private-invalid-json'); process.exit(0); }
    const mounts = args.filter(value => value.startsWith('type=bind,')).map((_, index) => ({ index, filesystem: 'filesystem-1' }));
    output({ mounts, filesystems: [{ id: 'filesystem-1', device: '2049', type: '61267', observedAt: '2026-10-23T02:00:00.000Z', blockBytes: '4096', fragmentBytes: '0', blocks: '1000', freeBlocks: '200', availableBlocks: '100', inodes: '500', freeInodes: '400' }] });
  } else process.exit(98);
} else if (args[0] === 'ps') { if (process.env.FOGD_SPACE_CLEANUP_FAIL) process.exit(97); if (state.helper) console.log('a'.repeat(64)); }
else if (args[0] === 'rm') { state.helper = false; writeFileSync(file, JSON.stringify(state)); }
else process.exit(99);
