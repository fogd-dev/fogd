import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { routeAuthorityVolume } from '../runtime/durable-config.mjs';
import { durableSnapshotLayout } from './durable-bundle.mjs';
import { volumeHelper } from './volumes.mjs';

const unconfirmed = () => Object.assign(new Error('Durable data restoration is unconfirmed; keep the destination stopped and retain every target volume, archive and record for inspection'), { code: 'DURABLE_RESTORE_DATA_UNCONFIRMED' });

// Static helper run by the pinned image's node. Only the fixed mode argument
// varies; archives arrive on stdin and are never executed or interpolated.
// Root state.json exclusion is anchored, and --keep-old-files refuses to
// replace the fresh state through any alias; the caller rechecks it anyway.
const helperCode = `import{lstat,readdir,readFile}from'node:fs/promises';import{spawnSync}from'node:child_process';import{createHash}from'node:crypto';
const root='/data',tar='/bin/tar',sync='/bin/sync',mode=process.argv[1];
const guard=['--keep-old-files','--anchored','--no-wildcards','--exclude=./state.json','--exclude=state.json'];
const run=(file,args)=>{if(spawnSync(file,args,{stdio:['inherit','ignore','ignore'],env:{}}).status!==0)process.exit(1);};
async function walk(dir){let entries=0,links=0;for(const item of await readdir(dir,{withFileTypes:true})){entries++;if(item.isSymbolicLink())links++;else if(item.isDirectory()){const sub=await walk(dir+'/'+item.name);entries+=sub.entries;links+=sub.links;}}return{entries,links};}
async function state(){const stat=await lstat(root+'/state.json',{bigint:true}).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
if(!stat)return null;if(!stat.isFile())return{type:'other'};
return{type:'file',dev:String(stat.dev),ino:String(stat.ino),uid:String(stat.uid),gid:String(stat.gid),mode:String(stat.mode),nlink:String(stat.nlink),size:String(stat.size),mtime:String(stat.mtimeNs),sha256:createHash('sha256').update(await readFile(root+'/state.json')).digest('hex')};}
const common=['--numeric-owner','-C',root];
if(mode==='survey')console.log(JSON.stringify({...await walk(root),state:await state()}));
else if(mode==='extract'||mode==='extract-controller'){run(tar,[...common,...(mode==='extract'?[]:guard),'-xpf','-']);run(sync,['-f',root]);console.log('ok');}
else if(mode==='compare'||mode==='compare-controller'){run(tar,[...common,...(mode==='compare'?[]:guard.slice(1)),'--compare','-pf','-']);console.log('ok');}
else process.exit(1);`;

const readOnly = { readonly: true, entrypoint: '/usr/local/bin/node', capabilities: ['DAC_OVERRIDE'] };
// Numeric ownership and mode restore needs exactly these; nothing else.
const writable = { readonly: false, entrypoint: '/usr/local/bin/node', capabilities: ['CHOWN', 'FOWNER', 'FSETID', 'DAC_OVERRIDE'] };
const helperArgs = mode => ['--input-type=module', '-e', helperCode, mode];

function bounded(output) {
  if (typeof output !== 'string' || output.length > 4096 || !/^[\x20-\x7e]+\n?$/.test(output)) throw unconfirmed();
  return output.trimEnd();
}
async function survey(readVolume, image, volume) {
  const value = JSON.parse(bounded(await readVolume(image, volume, helperArgs('survey'), { ...readOnly, maxOutputBytes: 4096 })));
  if (!Number.isSafeInteger(value?.entries) || !Number.isSafeInteger(value.links)) throw unconfirmed();
  return value;
}
const freshState = value => value.entries === 1 && value.links === 0 && value.state?.type === 'file' && value.state.nlink === '1';
async function helper(readVolume, image, volume, mode, input, options) {
  if (bounded(await readVolume(image, volume, helperArgs(mode), { ...options, input, maxOutputBytes: 4096 })) !== 'ok') throw unconfirmed();
}

function restorationPlan(directory, config, profile) {
  const policy = validateRuntimePolicy(profile);
  if (policy.schema !== 3 || policy.routing !== 'durable') throw unconfirmed();
  // Execution policy, enrollment and route authority are never data roles.
  const roles = durableSnapshotLayout(config, policy).archiveVolumes.filter(role => role !== routeAuthorityVolume);
  const volumes = roles.map(role => config.volumes[role]?.name);
  if (!roles.includes('controller') || volumes.some(name => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(name)) || new Set(volumes).size !== volumes.length) throw unconfirmed();
  return { image: policy.image, targets: roles.map((role, index) => ({ role, volume: volumes[index], archive: join(directory, `${role}.tar`) })) };
}

// Internal step after independent family/image/archive verification, fresh
// stopped resources, execution policy install and fresh route enrollment.
// Copies only data roles beside the fresh controller state; a failure after
// any copy starts is retained as-is, never cleaned or retried here.
export async function restoreDurableData(directory, config, profile, { readVolume = volumeHelper } = {}) {
  try {
    const { image, targets } = restorationPlan(directory, config, profile);
    for (const target of targets) if (!(await lstat(target.archive)).isFile()) throw unconfirmed();
    let original;
    for (const { role, volume } of targets) {
      const found = await survey(readVolume, image, volume);
      if (role === 'controller' ? !freshState(found) : found.entries !== 0) throw unconfirmed();
      if (role === 'controller') original = found.state;
    }
    for (const { role, volume, archive } of targets) {
      const controller = role === 'controller';
      await helper(readVolume, image, volume, controller ? 'extract-controller' : 'extract', archive, writable);
      if (controller) {
        const after = await survey(readVolume, image, volume);
        if (after.links !== 0 || !isDeepStrictEqual(after.state, original)) throw unconfirmed();
      }
      await helper(readVolume, image, volume, controller ? 'compare-controller' : 'compare', archive, readOnly);
    }
    return { roles: targets.map(target => target.role) };
  } catch { throw unconfirmed(); }
}
