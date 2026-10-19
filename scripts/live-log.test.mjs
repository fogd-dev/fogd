import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoveredLogEpoch} from './live-log.mjs';
const record={host:'slot-2-a',log:{state:'open',epoch:6,ensemble:['slot-2-b']}};
const open=epoch=>`slot-2-a-1  | INFO log ensemble open; fleet acks enabled epoch=${epoch}`;
const degraded=epoch=>`slot-2-a-1  | WARN log ensemble degraded; acks ride the bucket epoch=${epoch}`;
test('persisted open lease does not hide in-memory degradation',()=>{
  assert.equal(recoveredLogEpoch(record,[open(5),degraded(5)].join('\n')),false);
  assert.equal(recoveredLogEpoch(record,[open(5),degraded(5),open(6)].join('\n')),true);
});
test('recovery needs a newer epoch on the same host, also visible in its lease',()=>{
  for(const final of [open(5),open(7),open(6).replace('slot-2-a','slot-2-b')])assert.equal(recoveredLogEpoch(record,[open(5),degraded(5),final].join('\n')),false);
});
test('a later degradation invalidates earlier recovery',()=>{
  assert.equal(recoveredLogEpoch(record,[open(5),degraded(5),open(6),degraded(6)].join('\n')),false);
});
test('missing or malformed transition evidence fails closed',()=>{
  assert.equal(recoveredLogEpoch(record,''),false);
  assert.equal(recoveredLogEpoch(record,open('unknown')),false);
});
