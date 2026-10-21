import assert from 'node:assert/strict';
import { activationClient } from '../activation/client.mjs';

function allowedSQL(sql) {
  if ([
    'SELECT * FROM cron_replacement_attempts ORDER BY entered_at,id;',
    'SELECT * FROM refresh_results ORDER BY scheduled_time,job;',
    "SELECT name FROM d1_migrations WHERE name = '0003_compatible.sql';",
    'UPDATE cron_replacement_control SET released = 1 WHERE id = 1;',
  ].includes(sql)) return true;
  return /^SELECT \* FROM refresh_occurrences WHERE scheduled_time = [1-9][0-9]* ORDER BY job;$/.test(sql) ||
    /^UPDATE cron_replacement_control SET armed_after = [1-9][0-9]*, held_time = NULL, released = 0, hold_release = '(old|new)', position = 'before', inventory_position = '(none|after)' WHERE id = 1 RETURNING \*;$/.test(sql);
}
export function replacementClient(fixture) {
  const probe = activationClient(fixture), cli = probe.cli;
  probe.cli = (args, target = probe.slot) => {
    if (args[0] !== 'd1') return cli(args, target);
    assert.deepEqual(target, probe.slot); assert.equal(args.length, 7);
    assert.deepEqual(args.slice(0, 4), ['d1', 'execute', 'refresh-db', '--command']); assert.equal(args[6], '--json');
    assert.ok(allowedSQL(args[4]), 'Replacement SQL must use a fixed fixture template');
    assert.match(args[5], /^\/var\/lib\/fogd\/artifacts\/[a-f0-9-]{36}$/);
    return probe.compose(['exec', '-T', '-e', `CELLD_BUCKET=s3://${fixture.profile.bucket}/${target.prefix}`, 'controller', '/usr/local/bin/celld', ...args]);
  };
  probe.deployment = async host => {
    assert.ok(probe.slot.nodes.includes(host));
    return JSON.parse(await probe.node(`const response=await fetch('http://'+${JSON.stringify(host)}+':8081/state',{signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('Replica state unavailable');console.log(JSON.stringify((await response.json()).deployment));`));
  };
  probe.state = () => Promise.all(probe.slot.nodes.map(async host => ({ host, deployment: await probe.deployment(host) })));
  return probe;
}
