import { defineHandler } from 'void';
import { db } from 'void/db';
import { storage } from 'void/storage';
import { entries } from '@schema';
import ledger from '../../durable-objects/ledger';

export const PUT = defineHandler(async c => {
  const value = await c.req.json();
  if (!value || typeof value.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value.id)
    || typeof value.title !== 'string' || value.title.length > 200
    || typeof value.body !== 'string' || value.body.length > 65536) {
    return c.json({ error: 'Expected id, title (up to 200 characters), and body (up to 64 KiB)' }, 400);
  }
  // These are idempotent operations, not a transaction across three services.
  await storage.put(`entries/${value.id}`, value.body, { httpMetadata: { contentType: 'text/plain' } });
  await db.insert(entries).values({ id: value.id, title: value.title }).onConflictDoUpdate({ target: entries.id, set: { title: value.title } });
  const count = await ledger.get('global').record(value.id);
  return { id: value.id, count };
});

export const GET = defineHandler(async () => {
  const rows = await db.select().from(entries);
  return {
    entries: await Promise.all(rows.map(async row => ({ ...row, body: await (await storage.get(`entries/${row.id}`))?.text() }))),
    count: await ledger.get('global').count(),
  };
});
