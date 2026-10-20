// Installed only in a private copy of examples/refresh by the qualification build.
const instance = crypto.randomUUID();

function validateEntry(job, cron, time, env) {
  if (!['inventory', 'advisory'].includes(job) || !cron.trim() || time === null || time < 0) throw Error('Invalid native occurrence');
  if (!env.REFRESH_TOKEN) throw Error('Missing refresh configuration');
}

async function shouldFail(db, attempt) {
  if (attempt.job !== 'advisory') return false;
  if (['no-retry', 'terminal'].includes(attempt.policy)) return true;
  if (attempt.policy !== 'owner-loss') return false;
  const row = await db.prepare('SELECT count(*) AS n FROM cron_fault_attempts WHERE phase = ? AND job = ? AND cron = ? AND scheduled_time = ?')
    .bind(attempt.phase, attempt.job, attempt.cron, attempt.scheduled_time).first();
  return row.n <= 2;
}

export async function faultJob(job, event, env, refresh) {
  const enteredAt = Date.now(), id = crypto.randomUUID();
  const cron = typeof event?.cron === 'string' ? event.cron : '';
  const scheduledTime = Number.isSafeInteger(event?.scheduledTime) ? event.scheduledTime : null;
  const db = env.DB;
  const attempt = await db.prepare(`INSERT INTO cron_fault_attempts (id,job,cron,scheduled_time,entered_at,instance,phase,policy)
    SELECT ?,?,?,?,?,?,phase,policy FROM cron_fault_control WHERE id = 1 RETURNING *`)
    .bind(id, typeof job === 'string' ? job : 'invalid', cron, scheduledTime, enteredAt, instance).first();
  if (!attempt) throw Error('Missing fault policy');
  let noRetry = false, outcome = 'rejected', originalError;
  try {
    validateEntry(job, cron, scheduledTime, env);
    outcome = 'thrown';
    if (await shouldFail(db, attempt)) {
      if (attempt.policy === 'no-retry') { event.noRetry(); noRetry = true; }
      throw Error('Intentional scheduled source failure');
    }
    await refresh(job, event, env); outcome = 'success';
  } catch (error) { originalError = error; throw error; }
  finally {
    try {
      await db.prepare('UPDATE cron_fault_attempts SET outcome = ?, no_retry_called = ?, finished_at = ? WHERE id = ?')
        .bind(outcome, noRetry ? 1 : 0, Date.now(), id).run();
    } catch (error) { if (!originalError) throw error; }
  }
}
