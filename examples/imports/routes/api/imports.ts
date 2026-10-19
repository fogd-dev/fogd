import { defineHandler } from 'void';
import { db, desc } from 'void/db';
import { importJobs } from '@schema';
import { queues } from 'void/queues';
import { storage } from 'void/storage';
import { getJob, submit, retry } from '../../lib/jobs.mjs';
import { InputError, readJson } from '../../lib/input.mjs';
export const GET = defineHandler(async c => {
  const id = c.req.query('id');
  try { return id ? await getJob(c.env.DB, id) : await db.select().from(importJobs).orderBy(desc(importJobs.createdAt)).limit(20); }
  catch (error) { if (error instanceof InputError) return c.json({ error: error.message }, error.status); throw error; }
});
export const POST = defineHandler(async c => {
  try {
    const value = await readJson(c.req.raw);
    if (!value || typeof value !== 'object') throw new InputError(400, 'Expected an import object');
    const services = { db: c.env.DB, storage, queue: queues.imports };
    return c.json(value.retry ? await retry(services, value.id) : await submit(services, value), 202);
  } catch (error) {
    if (error instanceof InputError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});
