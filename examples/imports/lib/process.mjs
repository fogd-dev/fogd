import { resultWrites } from './results.mjs';
import { inputHash, jobId, labels } from './input.mjs';
export async function processJob(db, storage, message) {
  const id = jobId(message.body.id);
  const job = await db.prepare('SELECT * FROM import_jobs WHERE id = ?').bind(id).first();
  if (!job) throw new Error('Job record is missing');
  if (job.status === 'complete') return;
  await db.prepare("UPDATE import_jobs SET attempts = attempts + 1 WHERE id = ? AND status != 'complete'").bind(id).run();
  const input = await storage.get(`inputs/${job.input_hash}`);
  if (!input) throw new Error('Retained input is missing');
  if (input.size > 8192) throw new Error('Retained input exceeds the import limit');
  const text = await input.text();
  if (await inputHash(text) !== job.input_hash) throw new Error('Retained input hash mismatch');
  if (job.delay_ms) await new Promise(resolve => setTimeout(resolve, job.delay_ms));
  if (job.mode === 'fail' || (job.mode === 'retry-once' && message.attempts === 1)) throw new Error('Deliberate processing failure');
  const writes = resultWrites(db, id, labels(text));
  writes.push(db.prepare("UPDATE import_jobs SET status = 'complete', error = NULL WHERE id = ?").bind(id));
  await db.batch(writes);
}
export async function failed(db, id, terminal) {
  await db.prepare("UPDATE import_jobs SET status = ?, error = ? WHERE id = ? AND status != 'complete'").bind(terminal ? 'failed' : 'accepted', 'Processing did not complete; retained input can be retried', id).run();
}
