import assert from 'node:assert/strict';
import { nextMinuteBoundary, waitForMinuteBoundary } from './minute.mjs';

// Native events, Docker container timestamps and controller observations use the
// VM clock. Host wall time is deliberately excluded from ordering assertions.
function clock(value) { const at = Number(value); assert.ok(/^\d+$/.test(String(value).trim()) && Number.isSafeInteger(at) && at > 0, 'Invalid VM clock response'); return at; }
export async function vmNow(probe) { return clock(await probe.node('console.log(Date.now())')); }

export async function vmWaitUntil(probe, at) {
  assert.ok(Number.isSafeInteger(at) && at >= 0);
  return clock(await probe.node(`while(Date.now()<${at})await new Promise(resolve=>setTimeout(resolve,250));console.log(Date.now());`));
}

export async function vmMinuteBoundary(probe) {
  return clock(await probe.node(`${nextMinuteBoundary.toString()}\n${waitForMinuteBoundary.toString()}\nconsole.log(await waitForMinuteBoundary());`));
}
