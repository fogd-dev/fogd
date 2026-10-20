// Read persisted owner/wake metadata without instantiating the cron cell.
export async function cronRecords(probe, script) {
  if (!/^[a-z0-9-]+$/.test(script)) throw Error('Invalid probe script');
  const cell = `.cron:${script}`;
  return JSON.parse(await probe.node(`
    import {createRequire} from 'node:module';import {bucketClient} from './packages/runtime/src/bucket.mjs';
    const require=createRequire('/app/packages/platform/src/backend.mjs'),{GetObjectCommand,ListObjectsV2Command}=require('@aws-sdk/client-s3'),client=bucketClient(),Bucket=process.env.FOGD_BUCKET,prefix=${JSON.stringify(probe.slot.prefix)};
    const read=async Key=>JSON.parse(await(await client.send(new GetObjectCommand({Bucket,Key}))).Body.transformToString());
    const owner=await read(prefix+'/cells/'+${JSON.stringify(cell)}+'/own.json');
    const listing=await client.send(new ListObjectsV2Command({Bucket,Prefix:prefix+'/wake/entries/'}));if(listing.IsTruncated)throw Error('Unexpected truncated wake listing');
    const rows=await Promise.all((listing.Contents||[]).map(async o=>{try{return {key:o.Key,...await read(o.Key)};}catch(e){if(e.$metadata?.httpStatusCode===404)return null;throw e;}}));
    console.log(JSON.stringify({owner,wakes:rows.filter(row=>row?.cell===${JSON.stringify(cell)}),at:Date.now()}));
  `));
}
