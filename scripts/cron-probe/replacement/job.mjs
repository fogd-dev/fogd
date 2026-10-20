const instance = crypto.randomUUID();

async function holdSelected(db, attempt, position) {
  const control = await db.prepare("UPDATE cron_replacement_control SET held_time = COALESCE(held_time, ?) WHERE id = 1 AND armed_after IS NOT NULL AND armed_after < ? AND hold_release = ? AND CASE WHEN ? = 'inventory' THEN inventory_position ELSE position END = ? RETURNING *").bind(attempt.scheduled_time, attempt.scheduled_time, attempt.release, attempt.job, position).first();
  if (!control || control.held_time !== attempt.scheduled_time || control.released) return;
  await db.prepare('UPDATE cron_replacement_attempts SET held_at = ? WHERE id = ?').bind(Date.now(), attempt.id).run();
  const until = Date.now() + 20000;
  while (true) {
    await db.prepare('UPDATE cron_replacement_attempts SET last_poll_at = ? WHERE id = ?').bind(Date.now(), attempt.id).run();
    if ((await db.prepare('SELECT released FROM cron_replacement_control WHERE id = 1').first()).released) break;
    if (Date.now() >= until) throw Error('Selected callback was not released before its qualification deadline');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await db.prepare('UPDATE cron_replacement_attempts SET unblocked_at = ? WHERE id = ?').bind(Date.now(), attempt.id).run();
}

export async function replacementJob(release, job, event, env, prepare) {
  const enteredAt = Date.now(), id = crypto.randomUUID();
  const cron = typeof event?.cron === 'string' ? event.cron : '';
  const time = Number.isSafeInteger(event?.scheduledTime) ? event.scheduledTime : null;
  const db = env.DB;
  const attempt = await db.prepare('INSERT INTO cron_replacement_attempts (id,release,job,cron,scheduled_time,entered_at,instance) VALUES (?,?,?,?,?,?,?) RETURNING *')
    .bind(id, release, job, cron, time, enteredAt, instance).first();
  let outcome = 'rejected', originalError;
  try {
    if (!['inventory', 'advisory'].includes(job) || !cron.trim() || time === null || time < 0 || !env.REFRESH_TOKEN) throw Error('Invalid configured native occurrence');
    outcome = 'thrown';
    const work = await prepare(job, event, env);
    await holdSelected(db, attempt, 'before');
    await work.complete();
    const saved = await db.prepare('SELECT saved_at FROM refresh_results WHERE job = ? AND cron = ? AND scheduled_time = ?').bind(job, cron, time).first();
    await db.prepare('UPDATE cron_replacement_attempts SET result_saved_at = ? WHERE id = ?').bind(saved?.saved_at ?? null, id).run();
    await holdSelected(db, attempt, 'after'); outcome = 'success';
  } catch (error) { originalError = error; throw error; }
  finally {
    try {
      const result = await db.prepare('SELECT saved_at FROM refresh_results WHERE job = ? AND cron = ? AND scheduled_time = ?').bind(job, cron, time).first();
      await db.prepare('UPDATE cron_replacement_attempts SET outcome = ?, finished_at = ?, result_saved_at = ? WHERE id = ?')
        .bind(outcome, Date.now(), result?.saved_at ?? null, id).run();
    } catch (error) { if (!originalError) throw error; }
  }
}
