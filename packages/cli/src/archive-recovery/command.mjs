import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { appName } from '@fogd/runtime/artifact';
import { secretNames } from '@fogd/runtime/deployment';
import { configEnv, serverOrigin } from '../local.mjs';
import { controllerGet, boundedJson, discardResponse } from '../client-http.mjs';
import { mutateAdmin, uncertainAdminMutation } from '../admin-mutation.mjs';
import { controllerOrigin, readPrivateJSON, privateJSON, syncDirectory } from '../build-cache/paths.mjs';
import { readSecretInput } from '../secret-input.mjs';
import { recoveryReview, savedRecoveryReview, recoveryApproval, stagedSecrets } from './view.mjs';

const usage = 'Usage: fogd admin archive APP review [--rotation] [--output NEW_FILE] | approve --review FILE [--rotation] | secrets --review ORIGINAL_REVIEW_FILE < values.json';
const operation = { label: 'Archive recovery decision', subject: 'Archive recovery', noun: 'archive recovery decision', feature: 'archive recovery controls',
  unavailable: 'No matching pending archive recovery is available; inspect current state and saved owner decisions before another action',
  timeout: 900000, limit: 65536, uncertainRefusal: true, advice: 'inspect a fresh recovery review and saved owner decisions before another action; do not replay automatically' };
function parse(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { rotation: { type:'boolean' }, output:{type:'string'}, review:{type:'string'} } });
  const [app, action = 'review'] = positionals; appName(app);
  if (positionals.length > 2 || !['review','approve','secrets'].includes(action)) throw new Error(usage);
  if (action === 'review' ? values.review !== undefined || values.output === '' : !values.review || values.output !== undefined) throw new Error(usage);
  if (action === 'secrets' && values.rotation) throw new Error(usage);
  return { app, action, kind: values.rotation ? 'rotation' : 'original', values };
}
async function inspect(command) {
  const env = await configEnv(), origin = controllerOrigin(serverOrigin(env));
  if (!env.FOGD_ADMIN_PASSWORD) throw new Error('Set FOGD_ADMIN_PASSWORD for archive recovery inspection');
  const authorization = `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER || 'admin'}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`;
  let response;
  try { response = await controllerGet(origin, `/v1/apps/${command.app}/archive-recovery${command.kind === 'rotation' ? '/rotation' : ''}`, authorization); }
  catch { throw new Error('Cannot read archive recovery; check endpoint, TLS trust and controller availability'); }
  if (!response.ok) { await discardResponse(response); throw new Error(`Archive recovery review is unavailable (HTTP ${response.status}); inspect controller support and current recovery state`); }
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await discardResponse(response); throw new Error('Controller did not return JSON archive recovery state');
  }
  return recoveryReview(await boundedJson(response,{limit:operation.limit,invalid:'Archive recovery review is unreadable, oversized or interrupted; private contents are withheld'}),command.app,command.kind,origin);
}
async function secrets(command, review) {
  const values = await readSecretInput();
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(value => typeof value !== 'string' || !value || Buffer.byteLength(value)>8192) || Buffer.byteLength(JSON.stringify(values))>32768) throw new Error('Secret input requires nonempty strings, at most 8 KiB each and 32 KiB total');
  const names=secretNames(Object.keys(values)),{secretRevision,...selection}=review.selection;
  const staging={...operation,label:'Archive secret staging',noun:'archive secret staging',method:'PUT',expectedOrigin:review.controller};
  const value=await mutateAdmin(staging,`/v1/apps/${command.app}/archive-recovery/rotation/secrets`,{...selection,values});
  try{return stagedSecrets(value,command.app,names,secretRevision);}catch{throw uncertainAdminMutation(staging);}
}
export async function archiveRecoveryCommand(args) {
  const command=parse(args);
  if(command.action==='review'){
    const review=await inspect(command);
    if(command.values.output){const path=resolve(command.values.output);await privateJSON(path,review);await syncDirectory(dirname(path));}
    console.log(JSON.stringify(review,null,2));return;
  }
  const review=savedRecoveryReview((await readPrivateJSON(resolve(command.values.review),8192)).value,command.app,command.kind);
  if(command.action==='secrets'){console.log(JSON.stringify(await secrets(command,review),null,2));return;}
  const selected={...operation,expectedOrigin:review.controller};
  const value=await mutateAdmin(selected,`/v1/apps/${command.app}/archive-recovery${command.kind==='rotation'?'/rotation':''}/approve`,{...review.selection,review:review.review});
  let result;try{result=recoveryApproval(value,review.selection);}catch{throw uncertainAdminMutation(selected);}
  console.log(JSON.stringify({ ...result, app: command.app, kind: command.kind },null,2));
}
