export const jobs = ['inventory', 'advisory'];
export const modes = ['healthy', 'retry-once', 'offline', 'lost-ack-once'];
class SourceFailure extends Error {}

function occurrence(job, event) {
  if (!jobs.includes(job) || typeof event.cron !== 'string' || !event.cron.trim() || !Number.isSafeInteger(event.scheduledTime) || event.scheduledTime < 0) throw new Error('Invalid refresh occurrence');
  return [job, event.cron, event.scheduledTime];
}

function source(job, scheduledTime, mode, attempt) {
  if (job === 'advisory' && (mode === 'offline' || (mode === 'retry-once' && attempt === 1))) throw new SourceFailure('The local advisory source is unavailable. A later attempt can recover.');
  const minute = Math.floor(scheduledTime / 60000);
  return job === 'inventory' ? `${20 + minute % 7} sample items available` : ['Collection on time', 'Collection delayed ten minutes', 'Extra collection available'][minute % 3];
}

export async function refreshJob(db, job, event, clock = Date.now) {
  const key = occurrence(job, event), mode = (await db.prepare('SELECT mode FROM refresh_settings WHERE id = 1').first()).mode;
  const attemptedAt = clock();
  const record = await db.prepare(`INSERT INTO refresh_occurrences (job,cron,scheduled_time,initial_mode,last_attempt_at) VALUES (?,?,?,?,?)
    ON CONFLICT(job,cron,scheduled_time) DO UPDATE SET attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at RETURNING *`).bind(...key, mode, attemptedAt).first();
  if (record.status === 'complete') {
    await db.prepare('UPDATE refresh_occurrences SET duplicates = duplicates + 1 WHERE job = ? AND cron = ? AND scheduled_time = ?').bind(...key).run();
    return;
  }
  try {
    const value = source(job, event.scheduledTime, mode, record.attempts);
    await db.batch([
      db.prepare('INSERT INTO refresh_results (job,cron,scheduled_time,value,saved_at) VALUES (?,?,?,?,?) ON CONFLICT(job,cron,scheduled_time) DO NOTHING').bind(...key, value, attemptedAt),
      db.prepare("UPDATE refresh_occurrences SET status = 'complete', error = NULL, completed_at = ? WHERE job = ? AND cron = ? AND scheduled_time = ? AND status != 'complete'").bind(attemptedAt, ...key),
    ]);
    // Simulate a failed acknowledgement after the durable business result, so
    // the real native scheduler retries an already-completed job.
    if (job === 'advisory' && mode === 'lost-ack-once' && record.attempts === 1) throw new SourceFailure('The advisory reply was lost after saving its result.');
  } catch (error) {
    const message = error instanceof SourceFailure ? error.message : 'Refresh did not complete. Check the stored result before retrying.';
    await db.prepare("UPDATE refresh_occurrences SET status = 'failed', error = ? WHERE job = ? AND cron = ? AND scheduled_time = ? AND status != 'complete'").bind(message, ...key).run();
    throw error;
  }
}

export async function scheduledRefresh(job, event, env) {
  if (!env.REFRESH_TOKEN) throw new Error('Required refresh configuration is missing');
  return refreshJob(env.DB, job, event);
}

export async function summary(db) {
  const setting = await db.prepare('SELECT mode FROM refresh_settings WHERE id = 1').first();
  const history = (await db.prepare('SELECT * FROM refresh_occurrences ORDER BY scheduled_time DESC, job LIMIT 20').all()).results;
  const views = await Promise.all(jobs.map(async job => ({ job,
    latest: await db.prepare('SELECT * FROM refresh_occurrences WHERE job = ? ORDER BY scheduled_time DESC LIMIT 1').bind(job).first(),
    lastSuccess: await db.prepare('SELECT * FROM refresh_results WHERE job = ? ORDER BY scheduled_time DESC LIMIT 1').bind(job).first(),
  })));
  return { mode: setting.mode, jobs: views, history };
}

export async function changeMode(db, mode) {
  if (!modes.includes(mode)) throw new Error('Unknown source mode');
  await db.prepare('UPDATE refresh_settings SET mode = ? WHERE id = 1').bind(mode).run();
}
