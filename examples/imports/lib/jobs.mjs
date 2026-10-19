import { InputError, inputHash, jobId, labels, options } from './input.mjs';
export async function getJob(db, id) {
  const job = await db.prepare('SELECT * FROM import_jobs WHERE id = ?').bind(jobId(id)).first();
  if (!job) throw new InputError(404, 'Import not found');
  const rows = await db.prepare('SELECT * FROM import_results WHERE job_id = ? ORDER BY position').bind(id).all();
  return { ...job, results: rows.results };
}
export async function submit({ db, storage, queue }, value) {
  const id = jobId(value.id); labels(value.text);
  const { mode, delayMs } = options(value), hash = await inputHash(value.text);
  // Content-addressed input is retained before the DB record; neither is atomic with send.
  await storage.put(`inputs/${hash}`, value.text);
  await db.prepare('INSERT INTO import_jobs (id, input_hash, mode, delay_ms) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(id, hash, mode, delayMs).run();
  const job = await getJob(db, id);
  if (job.input_hash !== hash) throw new InputError(409, 'That job ID already belongs to different input');
  if (job.status !== 'complete') await queue.send({ id });
  return getJob(db, id);
}
export async function retry({ db, queue }, id) {
  const job = await getJob(db, id);
  if (job.status === 'complete') return job;
  // Explicit retry also clears the fixture's deliberate failure/delay options.
  await db.prepare("UPDATE import_jobs SET mode = 'normal', delay_ms = 0, status = 'accepted', error = NULL WHERE id = ? AND status != 'complete'").bind(id).run();
  await queue.send({ id });
  return getJob(db, id);
}
