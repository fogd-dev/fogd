import { defineHandler } from 'void';
import { db, eq } from 'void/db';
import { storage } from 'void/storage';
import { attachments, messages } from '@schema';
import { MAX_FILE, objectKey, sha256 } from '../../src/transfer-format';

export const GET = defineHandler(async () => db.select().from(attachments));
export const POST = defineHandler(async c => {
  const form = await c.req.formData();
  const file = form.get('file'); const messageId = Number(form.get('messageId'));
  if (!(file instanceof File) || file.size > MAX_FILE || !file.name || file.name.length > 200 || !Number.isSafeInteger(messageId)) {
    return c.json({ error: 'Choose a file up to 64 KiB and an existing message' }, 400);
  }
  if (!(await db.select().from(messages).where(eq(messages.id, messageId))).length) return c.json({ error: 'Message not found' }, 404);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const row = { id: crypto.randomUUID(), messageId, name: file.name, size: bytes.length, sha256: await sha256(bytes) };
  // Immutable random keys; an interrupted SQL insert can leave an orphan object.
  await storage.put(objectKey(row.id), bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
  await db.insert(attachments).values(row);
  return row;
});
