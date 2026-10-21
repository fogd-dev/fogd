import assert from 'node:assert/strict';
import { activationClient } from '../activation/client.mjs';

export function releaseClient(fixture, allowedSQL) {
  const probe = activationClient(fixture), cli = probe.cli;
  probe.accesses = []; probe.quiet = false;
  probe.recordAccess = kind => { if (probe.quiet) throw Object.assign(new Error('No replica requests are allowed during the autonomous dispatch window'), { code: 'FOGD_QUIET_WINDOW' }); probe.accesses.push(kind); };
  probe.cli = (args, target = probe.slot) => {
    probe.recordAccess(args[0]);
    if (args[0] !== 'd1') return cli(args, target);
    assert.deepEqual(target, probe.slot); assert.equal(args.length, 7);
    assert.deepEqual(args.slice(0, 4), ['d1', 'execute', 'refresh-db', '--command']); assert.equal(args[6], '--json');
    assert.ok(allowedSQL(args[4]), 'Diagnostic SQL must use a fixed fixture template');
    assert.match(args[5], /^\/var\/lib\/fogd\/artifacts\/[a-f0-9-]{36}$/);
    return probe.compose(['exec', '-T', '-e', `CELLD_BUCKET=s3://${fixture.profile.bucket}/${target.prefix}`, 'controller', '/usr/local/bin/celld', ...args]);
  };
  probe.deployment = async host => {
    probe.recordAccess('deployment'); assert.ok(probe.slot.nodes.includes(host));
    return JSON.parse(await probe.node(`const response=await fetch('http://'+${JSON.stringify(host)}+':8081/state',{signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('Replica state unavailable');console.log(JSON.stringify((await response.json()).deployment));`));
  };
  const cleanupPause = probe.cleanupPause;
  probe.cleanupPause = () => { probe.recordAccess('cleanup-pause'); return cleanupPause(); };
  probe.state = () => Promise.all(probe.slot.nodes.map(async host => ({ host, deployment: await probe.deployment(host) })));
  return probe;
}
