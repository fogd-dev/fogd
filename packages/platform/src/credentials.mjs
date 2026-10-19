import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { appName } from '@fogd/runtime/artifact';
import { readJson, saveJson } from './store.mjs';
import { equal } from './security.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const visible = ({ hash: _hash, ...record }) => record;
export class Credentials {
  #persist;
  constructor(dir, persist = saveJson) { this.#persist = persist; this.path = join(dir, 'credentials.json'); }
  async init() {
    try { this.records = Object.assign(Object.create(null), await readJson(this.path, {})); }
    catch { throw new Error('Cannot read deployment credentials; restore controller storage'); }
  }
  describe() { return Object.values(this.records).map(visible); }
  async issue(name, apps) {
    if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Credential name must be nonempty text of at most 120 characters');
    if (!Array.isArray(apps) || !apps.length || apps.length > 32 || new Set(apps).size !== apps.length) throw new Error('Select 1–32 distinct app names');
    apps.forEach(appName);
    const id = randomUUID(), token = `fogd_${id}.${randomBytes(32).toString('base64url')}`;
    const record = { id, name: name.trim(), apps: [...apps].sort(), issuedAt: new Date().toISOString(), revokedAt: null, hash: digest(token) };
    const next = Object.assign(Object.create(null), this.records, { [id]: record });
    await this.#persist(this.path, next); this.records = next;
    return { ...visible(record), token };
  }
  async revoke(id) {
    const current = this.records[id];
    if (!current) throw new Error('Deployment credential not found');
    if (current.revokedAt) return visible(current);
    const record = { ...current, revokedAt: new Date().toISOString() };
    const next = Object.assign(Object.create(null), this.records, { [id]: record });
    await this.#persist(this.path, next); this.records = next;
    return visible(record);
  }
  authenticate(authorization) {
    const match = /^Bearer (fogd_([a-f0-9-]{36})\.[A-Za-z0-9_-]{43})$/.exec(authorization || '');
    if (!match) return null;
    const record = this.records[match[2]];
    return record && !record.revokedAt && equal(record.hash, digest(match[1])) ? visible(record) : null;
  }
  requireScope(id, app) {
    const record = this.records[id];
    if (!record || record.revokedAt || !record.apps.includes(app)) throw new Error('Deployment credential is revoked or outside its app scope');
  }
}
