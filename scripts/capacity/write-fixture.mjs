import { writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyFixture } from '../cron-probe/selected/project-copy.mjs';

export async function writeFixture(host, app) {
  if (!['baseline', 'peer'].includes(app)) throw new Error('Unknown write fixture application');
  const project = await copyFixture(host, 'guestbook', `write-${app}`);
  await appendFile(join(project, 'db/migrations/20261016160656_complete_ser_duncan.sql'), `
CREATE TABLE probe_writes (id TEXT PRIMARY KEY NOT NULL, app TEXT NOT NULL);
INSERT INTO messages (id, text, created_at) VALUES (1, '${app} write fixture', '2026-10-23 00:00:00');
`);
  await writeFile(join(project, 'routes/api/write-probe.ts'), `import { defineHandler } from 'void';
export const POST = defineHandler(async c => {
  const value = await c.req.json();
  if (!value || typeof value.id !== 'string' || !/^[a-z0-9-]{1,96}$/.test(value.id)) return c.json({ error: 'Invalid operation identity' }, 400);
  await c.env.DB.prepare('INSERT INTO probe_writes (id, app) VALUES (?, ?)').bind(value.id, '${app}').run();
  if (value.id === 'post-commit-error-control') return c.json({ error: 'Synthetic response failure after commit' }, 502);
  return c.json({ id: value.id, app: '${app}' });
});
export const GET = defineHandler(async c => (await c.env.DB.prepare('SELECT id, app FROM probe_writes ORDER BY id').all()).results);
`);
  return project;
}
