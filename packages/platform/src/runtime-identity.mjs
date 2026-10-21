import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const digest = text => createHash('sha256').update(text).digest('hex');
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// A caller-supplied binary profile is policy, not evidence of qualification.
// Deployment/recovery must separately prevent runtime replacement during use.
export class RuntimeIdentity {
  #profile;
  constructor({ profile, identify, cliDigest, members }) {
    this.#profile = structuredClone(profile);
    Object.assign(this, { identify, cliDigest, members });
  }
  async verify(slot) {
    try {
      const fleet = expectedFleet(this.#profile, slot);
      const before = await this.members(slot);
      assertMembership(before, fleet.nodes);
      if (await this.cliDigest() !== this.#profile.binarySha256) throw new Error('CLI binary mismatch');
      const namespace = digest(`s3://${this.#profile.bucket}/${fleet.prefix}`);
      await Promise.all(fleet.nodes.map(async node => {
        const observed = await this.identify(node.host);
        if (!isDeepStrictEqual(observed, { schema: 1, binarySha256: this.#profile.binarySha256,
          nodeSha256: digest(node.id), namespaceSha256: namespace })) throw new Error('Node identity mismatch');
      }));
      const after = await this.members(slot);
      assertMembership(after, fleet.nodes);
      if (!isDeepStrictEqual(before, after)) throw new Error('Membership changed');
    } catch {
      const error = new Error('Runtime identity policy refused the fleet');
      error.code = 'RUNTIME_IDENTITY_REFUSED';
      throw error;
    }
  }
}

function expectedFleet(profile, slot) {
  if (!profile || profile.schema !== 1 || !sha256(profile.binarySha256) ||
    typeof profile.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(profile.bucket) ||
    !Array.isArray(profile.fleets)) throw new Error('Invalid runtime identity profile');
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

function assertMembership(members, nodes) {
  if (!Array.isArray(members)) throw new Error('Missing membership inventory');
  const expected = new Map(nodes.map(node => [node.id, node.host])), seen = new Set();
  for (const member of members) {
    if (!member || !expected.has(member.node) || seen.has(member.node) ||
      member.key !== `${member.node}.json` || member.addr !== `${expected.get(member.node)}:8081` ||
      typeof member.processKey !== 'string' || !member.processKey) throw new Error('Unexpected fleet membership');
    seen.add(member.node);
  }
}
