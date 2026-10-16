import { defineHandler } from 'void';
import { db, eq } from 'void/db';
import { storage } from 'void/storage';
import { attachments } from '@schema';
import { objectKey } from '../../src/transfer-format';

export const GET = defineHandler(async c => {
  const id = c.req.query('id') || '';
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
  if (!row) return c.notFound();
  const object = await storage.get(objectKey(row.id));
  if (!object) return c.json({ error: 'Attachment unavailable' }, 503);
  return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="attachment.bin"', 'X-Content-Type-Options': 'nosniff' } });
});
