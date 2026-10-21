import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptionPlan, interruptionCase } from './policy.mjs';

const policy = () => ({ schema: 2, interruption: interruptionPlan({ 'first-publication': 'a'.repeat(64) }) });
test('interruption cases bind their artifact, fault, slot and writable locations', () => {
  assert.deepEqual(interruptionCase(policy(), 'first-resume'), {
    mode: 'retry', fault: 'resume', artifact: 'first-publication', slot: 'slot-1', dir: '/var/lib/fogd',
    output: '/var/lib/fogd/qualification/cases/first-resume', source: '/var/lib/fogd/qualification/artifacts/first-publication', digest: 'a'.repeat(64),
  });
  for (const name of ['constructor', 'missing', '../first-resume']) assert.throws(() => interruptionCase(policy(), name), /Unqualified interruption case/);
});
test('changed interruption authority or malformed artifact pins refuse before controller initialization', () => {
  for (const alter of [
    p => { p.schema = 1; },
    p => { p.interruption.cases['first-resume'].fault = 'publish'; },
    p => { p.interruption.slot = 'slot-2'; },
    p => { p.interruption.dir = '/tmp'; },
    p => { p.interruption.sourceRoot = '/tmp'; },
    p => { p.interruption.outputRoot = '/app'; },
    p => { p.interruption.artifacts['first-publication'] = 'private-value'; },
    p => { p.interruption.artifacts = Object.create({ 'first-publication': 'a'.repeat(64) }); },
  ]) {
    const p = policy(); alter(p);
    assert.throws(() => interruptionCase(p, 'first-resume'), { message: /^(Unqualified interruption|Interruption (case|location) differs)/ });
  }
});
