import { join } from 'node:path';
import { readJson, saveJson } from '../../src/store.mjs';
export function claimBackend(dir, afterClaim = () => {}) {
  const ownerPath = slot => join(dir, `owner-${slot.id}.json`);
  return {
    owner: slot => readJson(ownerPath(slot), null),
    hasDeployment: async () => Boolean(await readJson(join(dir, 'published.json'), null)),
    async assertUnclaimed(slot) { if (await readJson(ownerPath(slot), null) || await readJson(join(dir, 'published.json'), null)) throw Error('Not pristine'); },
    async claim(slot, app, { unpublished = false } = {}) {
      const owner = await readJson(ownerPath(slot), null);
      if (owner && owner.app !== app) throw Error('Owner mismatch');
      if (unpublished && await readJson(join(dir, 'published.json'), null)) throw Error('Already published');
      if (!owner) await saveJson(ownerPath(slot), { app, assignedAt: new Date().toISOString() });
      afterClaim();
    },
    async publish() { await saveJson(join(dir, 'published.json'), { published: true }); return 'fixture-version'; },
    async ready() {}, async applicationReady() {}, async migrate() {}, async applied() { return []; },
  };
}
