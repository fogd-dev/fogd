import { isIPv4 } from 'node:net';

// Only a fixed owner result leaves this read-only helper. No app or SDK text is copied.
export async function readLogOwner(input, { Backend, validateRuntimePolicy }) {
  try {
    const { env, profile, expected, address } = input;
    if (!isIPv4(address) || typeof expected?.app !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(expected.app)) return { owner: 'unconfirmed' };
    const policy = validateRuntimePolicy(profile, env), fleet = policy.fleets.find(value => value.id === expected.slot);
    const slot = JSON.parse(env.FOGD_SLOTS).find(value => value.id === expected.slot);
    if (!fleet || !slot || slot.prefix !== fleet.prefix) return { owner: 'unconfirmed' };
    const owner = await new Backend({ ...env, S3_ENDPOINT: 'http://' + address + ':9000' }).owner(slot);
    return { owner: owner?.app === expected.app ? 'matched' : 'unconfirmed' };
  } catch { return { owner: 'unconfirmed' }; }
}

export async function main() {
  try {
    let text = '';
    for await (const part of process.stdin) { text += part; if (Buffer.byteLength(text) > 131072) throw new Error('Owner input bound'); }
    const [{ Backend }, { validateRuntimePolicy }] = await Promise.all([
      import('/app/packages/platform/src/backend.mjs'), import('/app/packages/platform/src/runtime-policy.mjs'),
    ]);
    console.log(JSON.stringify(await readLogOwner(JSON.parse(text), { Backend, validateRuntimePolicy })));
  } catch { console.log(JSON.stringify({ owner: 'unconfirmed' })); }
}
