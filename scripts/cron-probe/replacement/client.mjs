import { releaseClient } from '../release/client.mjs';

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
export function replacementClient(fixture) { return releaseClient(fixture, allowedSQL); }
