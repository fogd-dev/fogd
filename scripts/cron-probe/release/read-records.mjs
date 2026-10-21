import { createRequire } from 'node:module';
import { bucketClient } from '/app/packages/runtime/src/bucket.mjs';
import { qualificationPolicy } from './backend.mjs';

export async function readCronRecords() {
  const policy = await qualificationPolicy(), fleet = policy.fleets.find(fleet => fleet.id === policy.releases.slot), prefix = fleet.prefix;
  const require = createRequire('/app/packages/platform/src/backend.mjs'), { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const client = bucketClient(), Bucket = process.env.FOGD_BUCKET, cell = '.cron:refresh';
  try {
    const read = async Key => JSON.parse(await (await client.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToString());
    const optional = async key => { try { return await read(key); } catch (error) { if (error.$metadata?.httpStatusCode === 404) return null; throw error; } };
    const [owner, waker, leases] = await Promise.all([read(`${prefix}/cells/${cell}/own.json`), optional(`${prefix}/wake/waker.json`), Promise.all(fleet.nodes.map(async node => {
      const lease = await optional(`${prefix}/nodes/${node.id}.json`);
      return { host: node.host, node: lease?.node ?? node.id, expires_ms: lease?.expires_ms ?? 0, missing: lease === null };
    }))]);
    const listing = await client.send(new ListObjectsV2Command({ Bucket, Prefix: `${prefix}/wake/entries/` }));
    if (listing.IsTruncated) throw Error('Unexpected truncated wake listing');
    const rows = await Promise.all((listing.Contents || []).map(async object => {
      try { return { key: object.Key, keyLastModifiedMs: object.LastModified.getTime(), ...await read(object.Key) }; }
      catch (error) { if (error.$metadata?.httpStatusCode === 404) return null; throw error; }
    }));
    return { owner, waker, leases, wakes: rows.filter(row => row?.cell === cell), at: Date.now() };
  } finally { client.destroy(); }
}
