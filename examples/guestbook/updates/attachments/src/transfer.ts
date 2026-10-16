import { db, asc, eq } from 'void/db';
import { storage } from 'void/storage';
import { messages, attachments, transferState } from '@schema';
import { decode, encode, objectKey, sha256, snapshotDigest, validateSnapshot, MAX_FILE, type Snapshot } from './transfer-format';

export async function exportSnapshot() {
  const [rows, files] = await db.batch([
    db.select().from(messages).orderBy(asc(messages.id)).limit(101),
    db.select().from(attachments).orderBy(asc(attachments.id)).limit(101),
  ]);
  if (rows.length > 100 || files.length > 100) throw new Error('Export exceeds 100 rows per table');
  const objects = [];
  for (const row of files) {
    const object = await storage.get(objectKey(row.id));
    if (!object || object.size > MAX_FILE) throw new Error('Missing or oversized attachment');
    objects.push({ ...row, data: encode(new Uint8Array(await object.arrayBuffer())) });
  }
  return validateSnapshot({ format: 'fogd-guestbook-v1', messages: rows, attachments: objects });
}

async function claimRestore(snapshot: Snapshot, digest: string) {
  const [receipt] = await db.select().from(transferState).where(eq(transferState.id, 'restore'));
  if (receipt) {
    if (receipt.digest !== digest) throw new Error('Destination belongs to another restore');
    if (receipt.status === 'complete') return true;
    if (receipt.status !== 'pending') throw new Error('Unknown restore state');
  }
  const [rows, files] = await db.batch([db.select().from(messages).limit(1), db.select().from(attachments).limit(1)]);
  if (rows.length || files.length) throw new Error('Restore requires an empty destination');
  const objects = await storage.list({ limit: 101 });
  const allowed = new Set(snapshot.attachments.map(file => objectKey(file.id)));
  if (objects.truncated || objects.objects.some(object => !receipt || !allowed.has(object.key))) throw new Error('Destination bucket is not empty or contains unrelated objects');
  await db.insert(transferState).values({ id: 'restore', digest, status: 'pending' }).onConflictDoNothing();
  const [claimed] = await db.select().from(transferState).where(eq(transferState.id, 'restore'));
  if (claimed?.digest !== digest) throw new Error('Another restore claimed the destination');
  return false;
}

async function restoreObjects(snapshot: Snapshot) {
  for (const file of snapshot.attachments) {
    const key = objectKey(file.id);
    const existing = await storage.get(key);
    if (existing) {
      if (existing.size !== file.size || await sha256(new Uint8Array(await existing.arrayBuffer())) !== file.sha256) throw new Error('Partial restore object differs; inspect the destination');
    } else {
      await storage.put(key, decode(file.data), { httpMetadata: { contentType: 'application/octet-stream' } });
    }
  }
}

export async function restoreSnapshot(snapshot: Snapshot) {
  const digest = await snapshotDigest(snapshot);
  if (await claimRestore(snapshot, digest)) return { digest, alreadyRestored: true };
  await restoreObjects(snapshot);
  // D1 batch commits rows and completion together. R2 writes above are retryable.
  await db.batch([
    db.update(transferState).set({ status: 'complete' }).where(eq(transferState.id, 'restore')),
    ...snapshot.messages.map(row => db.insert(messages).values(row)),
    ...snapshot.attachments.map(({ data: _data, ...row }) => db.insert(attachments).values(row)),
  ]);
  return { digest, alreadyRestored: false };
}
