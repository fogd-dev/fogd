import { defineMiddleware } from 'void';
import { exportSnapshot } from '../src/transfer';
import { importSnapshot } from '../src/import';

export default defineMiddleware(async (c, next) => {
  if (!c.req.path.startsWith('/__fogd/')) return next();
  if (c.req.header('x-fogd-maintenance') !== '1') return c.notFound();
  if (c.req.path === '/__fogd/export' && c.req.method === 'GET') {
    try { return c.json(await exportSnapshot()); }
    catch { return c.json({ error: 'Export requires valid referenced objects, at most 100 rows per table, 64 KiB per file, 1 MiB total file bytes, and 2 MiB JSON' }, 409); }
  }
  if (c.req.path === '/__fogd/import' && c.req.method === 'POST') return importSnapshot(c);
  return c.notFound();
});
