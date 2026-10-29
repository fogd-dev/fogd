import { runObservationHelper } from '../observe/helper.mjs';
import { compareCandidate, comparisonContext, retainedResources } from './compatibility.mjs';

const program = `import{open}from'node:fs/promises';import{constants}from'node:fs';
import{Controller}from'./packages/platform/src/controller.mjs';import{assertLiveName}from'./packages/platform/src/retirement.mjs';
const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>1048576)throw Error('candidate bound');chunks.push(chunk);}
const {release,capabilities}=JSON.parse(Buffer.concat(chunks));
const file=await open('/data/state.json',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
let bytes;try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>4194304)throw Error('state bound');const buffer=Buffer.alloc(4194305);let size=0;while(size<buffer.length){const{bytesRead}=await file.read(buffer,size,buffer.length-size,size);if(!bytesRead)break;size+=bytesRead;}if(size>4194304)throw Error('state bound');bytes=buffer.subarray(0,size);}finally{await file.close();}
const retainedResources=${retainedResources.toString()};const comparisonContext=${comparisonContext.toString()};
console.log(JSON.stringify((${compareCandidate.toString()})(JSON.parse(bytes),release,capabilities,{Controller,assertLiveName})));`;

export async function compareInstalledRelease(installation, backing, release, run) {
  const controller = backing.volumes.find(volume => volume.role === 'controller');
  if (!controller) throw new Error('Controller backing path is unavailable');
  const capabilities = { cronApps: true, queueApps: installation.config.services.controller.environment.FOGD_QUEUE_APPS === '1' };
  const inputText = JSON.stringify({ release, capabilities });
  if (Buffer.byteLength(inputText) > 1048576) throw new Error('Candidate metadata exceeds observation bound');
  const text = await runObservationHelper(installation, { purpose: 'doctor-compatibility',
    mount: `type=bind,src=${controller.mountpoint},dst=/data,readonly`, code: program, inputText }, run);
  const result = JSON.parse(text);
  if (!validComparison(result)) throw new Error('Invalid compatibility observation');
  return result;
}

function validComparison(result) {
  if (!result || !['supported', 'unsupported', 'unverified'].includes(result.status)) return false;
  const reasons = { supported: ['compatible'], unsupported: ['resource-identity', 'cron-transition', 'migration-history', 'quarantined', 'retired', 'queue-admission', 'cron-admission'], unverified: ['state'] };
  if (!reasons[result.status].includes(result.reason)) return false;
  const keys = ['status', 'reason', ...(result.status === 'supported' ? ['existingApp', 'r2Added', 'appliedMigrations', 'pendingMigrations'] : [])];
  return Object.keys(result).length === keys.length && Object.keys(result).every(key => keys.includes(key)) && (result.status !== 'supported' ||
    (typeof result.existingApp === 'boolean' && ['r2Added', 'appliedMigrations', 'pendingMigrations'].every(key => Number.isSafeInteger(result[key]) && result[key] >= 0)));
}
