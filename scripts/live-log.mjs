// Lease log records describe persisted epochs, not the in-memory degraded flag.
// Require a later reopened epoch for every degradation in this container's logs.
export function recoveredLogEpoch(record, logs) {
  const events=logs.split('\n').filter(line=>line.startsWith(`${record.host}-`) && /log ensemble (degraded|open)/.test(line));
  const parsed=events.map(line=>({line,epoch:Number(/\bepoch=(\d+)/.exec(line)?.[1]),degraded:line.includes('log ensemble degraded')}));
  if(!parsed.length || parsed.some(event=>!Number.isSafeInteger(event.epoch)))return false;
  const reopened=parsed.findLast(event=>!event.degraded);
  if(!reopened || record.log?.epoch<reopened.epoch)return false;
  return parsed.every((event,index)=>!event.degraded || parsed.slice(index+1).some(later=>!later.degraded && later.epoch>event.epoch));
}
