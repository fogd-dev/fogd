import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appName } from '@fogd/runtime/artifact';
import { secretNames } from '@fogd/runtime/deployment';
import { readJson, saveJson } from './store.mjs';

export class Secrets {
  #persist;
  constructor(dir, persist = saveJson) { this.#persist = persist; this.dir = join(dir, 'secrets'); this.execution = join(dir, 'execution'); }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    this.index = Object.assign(Object.create(null), await readJson(join(this.dir, 'index.json'), {}));
    await rm(this.execution, { recursive: true, force: true });
    await mkdir(this.execution, { recursive: true, mode: 0o700 });
  }
  describe() { return structuredClone(this.index); }
  async replace(app, values) {
    appName(app);
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Expected a JSON object of secret values');
    const names = secretNames(Object.keys(values));
    if (Object.values(values).some(value => typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 8192) || Buffer.byteLength(JSON.stringify(values)) > 32768) throw new Error('Secret values must be nonempty strings, at most 8 KiB each and 32 KiB total');
    const revision = randomUUID();
    await this.#persist(join(this.dir, `${revision}.json`), { app, values });
    const next = Object.assign(Object.create(null), this.index, { [app]: { revision, names } });
    await this.#persist(join(this.dir, 'index.json'), next);
    this.index = next;
    return { app, revision, names };
  }
  async select(request, selected) {
    const names = request.requiredSecrets || [];
    if (!names.length) {
      if (selected != null) throw new Error('This deployment does not declare secrets');
      return { revision: null, values: {} };
    }
    const revision = request.secretRevision || this.index[request.app]?.revision;
    if (!revision || selected !== revision) throw new Error('Select the current secret revision before approval; retries must retain their pinned revision');
    let stored;
    try { stored = JSON.parse(await readFile(join(this.dir, `${revision}.json`), 'utf8')); }
    catch { throw new Error('Cannot read the selected secret revision'); }
    if (stored.app !== request.app || names.some(name => typeof stored.values?.[name] !== 'string' || !stored.values[name])) throw new Error('Selected secret revision is missing required values');
    return { revision, values: Object.fromEntries(names.map(name => [name, stored.values[name]])) };
  }
  async materialize(request, artifact, values) {
    if (!(request.requiredSecrets || []).length) return artifact;
    const dir = join(this.execution, request.id);
    await cp(artifact, dir, { recursive: true, errorOnExist: true, force: false });
    const config = JSON.parse(await readFile(join(dir, 'wrangler.json'), 'utf8'));
    config.vars = { ...config.vars, ...values };
    await writeFile(join(dir, 'wrangler.json'), JSON.stringify(config), { mode: 0o600 });
    return dir;
  }
  async cleanup(id) { await rm(join(this.execution, id), { recursive: true, force: true }); }
}
