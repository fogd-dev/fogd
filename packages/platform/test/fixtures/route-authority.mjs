import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeRouteRecord } from '../../src/route-record-store.mjs';

export async function authorityFixture(t, verifyRuntime = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'authority'); await mkdir(dir, { mode: 0o755 });
  const path = join(dir, 'routes.json'), policy = { installation: 'a'.repeat(64), slots: ['one'] }; let fault;
  const options = { path, policy, fresh: true, verifyRuntime, async writePublic(file, record) {
    const failure = fault; fault = null;
    if (failure === 'before') throw new Error('Public write unavailable');
    await writeRouteRecord(file, record, policy);
    if (failure === 'after') throw new Error('Public acknowledgment lost');
  } };
  return { options, async record() { return JSON.parse(await readFile(path, 'utf8')); }, fail: when => { fault = when; } };
}
