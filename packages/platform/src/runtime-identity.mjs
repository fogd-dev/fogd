import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { verifyIdentityProof, storageOrigin } from './runtime-identity-proof.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// A caller-supplied binary profile is policy, not evidence of qualification.
// Deployment/recovery must separately prevent runtime replacement during use.
export class RuntimeIdentity {
  #profile;
  constructor({ profile, identify, cliDigest, members, now = Date.now, challenge = () => randomBytes(32).toString('hex') }) {
    this.#profile = structuredClone(profile);
    Object.assign(this, { identify, cliDigest, members, now, challenge });
  }
  async verify(slot) { return this.#verify(slot, true); }
  async bootstrap(slot) { return this.#verify(slot, false); }
  async #verify(slot, requireLeases) {
    try {
      const fleet = expectedFleet(this.#profile, slot);
      const before = await this.members(slot);
      assertMembership(before, fleet.nodes, requireLeases, this.now());
      if (await this.cliDigest() !== this.#profile.binarySha256) throw new Error('CLI binary mismatch');
      const namespace = `s3://${this.#profile.bucket}/${fleet.prefix}`;
      const storage = digest(JSON.stringify([namespace, storageOrigin(this.#profile.storage.endpoint), this.#profile.storage.region]));
      const authorities = new Map(await Promise.all(fleet.nodes.map(async node => {
        const challenge = this.challenge();
        const observed = verifyIdentityProof(await this.identify(node.host, challenge), challenge);
        if (!isDeepStrictEqual(observed, {
          schema: 2, binarySha256: this.#profile.binarySha256, nodeSha256: digest(node.id),
          namespaceSha256: digest(namespace), storageSha256: storage,
          processKeySha256: observed.processKeySha256,
        })) throw new Error('Node identity mismatch');
        return [node.id, observed.processKeySha256];
      })));
      assertAuthorities(before, authorities);
      const after = await this.members(slot);
      assertMembership(after, fleet.nodes, requireLeases, this.now());
      assertAuthorities(after, authorities);
      if (!isDeepStrictEqual(stableMembership(before), stableMembership(after))) throw new Error('Membership changed');
    } catch {
      const error = new Error('Runtime identity policy refused the fleet');
      error.code = 'RUNTIME_IDENTITY_REFUSED';
      throw error;
    }
  }
}

function expectedFleet(profile, slot) {
  if (!profile || profile.schema !== 2 || !sha256(profile.binarySha256) ||
    typeof profile.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(profile.bucket) ||
    !Array.isArray(profile.fleets)) throw new Error('Invalid runtime identity profile');
  assertStorage(profile.storage);
  const matches = profile.fleets.filter(fleet => fleet?.id === slot?.id);
  if (matches.length !== 1) throw new Error('Fleet identity is not declared');
  const fleet = matches[0];
  if (typeof fleet.prefix !== 'string' || fleet.prefix !== fleet.prefix.split('/').filter(Boolean).join('/') ||
    slot.prefix !== fleet.prefix) throw new Error('Fleet namespace mismatch');
  assertExpectedNodes(fleet.nodes);
  if (!Array.isArray(slot.nodes) || !isDeepStrictEqual([...slot.nodes].sort(), fleet.nodes.map(node => node.host).sort())) throw new Error('Fleet hosts mismatch');
  return fleet;
}

function assertExpectedNodes(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('Missing node identities');
  const hosts = new Set(), ids = new Set();
  for (const node of nodes) {
    if (!node || typeof node.host !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(node.host) ||
      typeof node.id !== 'string' || !node.id || node.id.includes('/') || hosts.has(node.host) || ids.has(node.id)) throw new Error('Invalid or duplicate node identity');
    hosts.add(node.host); ids.add(node.id);
  }
}

function assertMembership(members, nodes, required, now) {
  if (!Array.isArray(members) || (required && members.length !== nodes.length)) throw new Error('Missing membership inventory');
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid lease observation time');
  const expected = new Map(nodes.map(node => [node.id, node.host])), seen = new Set();
  for (const member of members) {
    if (!member || !expected.has(member.node) || seen.has(member.node) ||
      member.key !== `${member.node}.json` || member.addr !== `${expected.get(member.node)}:8081` ||
      !sha256(member.processKey)) throw new Error('Unexpected fleet membership');
    assertLeaseTime(member.expiresMs, required, now);
    seen.add(member.node);
  }
}

function assertAuthorities(members, authorities) {
  if (members.some(member => digest(member.processKey) !== authorities.get(member.node))) throw new Error('Lease authority does not match the process');
}

function assertStorage(storage) {
  if (!storage || typeof storage.endpoint !== 'string' || typeof storage.region !== 'string' || !storage.region) throw new Error('Missing storage identity');
  storageOrigin(storage.endpoint);
}

function stableMembership(members) {
  return members.map(({ key, node, addr, processKey }) => ({ key, node, addr, processKey }));
}

function assertLeaseTime(expiresMs, required, now) {
  if (!Number.isSafeInteger(expiresMs) || expiresMs < 0 || (required && expiresMs <= now)) throw new Error('Missing or expired node lease');
}
