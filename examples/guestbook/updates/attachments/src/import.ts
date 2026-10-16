import type { CloudContext } from 'void';
import { validateSnapshot, MAX_SNAPSHOT } from './transfer-format';
import { restoreSnapshot } from './transfer';

export async function importSnapshot(c: CloudContext) {
  if (c.req.header('x-fogd-maintenance') !== '1') return c.notFound();
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > MAX_SNAPSHOT) return c.json({ error: 'Snapshot request exceeds 2 MiB' }, 413);
  let snapshot;
  try { snapshot = await validateSnapshot(JSON.parse(text)); }
  catch { return c.json({ error: 'Invalid snapshot format, references, limits, or checksums' }, 400); }
  try { return c.json(await restoreSnapshot(snapshot)); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Restore failed' }, 409); }
}
