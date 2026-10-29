import assert from 'node:assert/strict';
import { setRefreshSource } from './refresh-client.mjs';
import { pollReplacement } from './replacement-migration.mjs';
import { waitFailureTime } from './failure-phases.mjs';

export async function replacementLostReply({ host, fixture, active, reader, clock, evidence }) {
  evidence.preparationPause = await host.json(['admin', 'dispatch', 'refresh', 'pause']);
  assert.equal(evidence.preparationPause.observed, 'paused');
  evidence.source = await setRefreshSource(host, fixture, 'lost-ack-once');
  evidence.preparationHeld = await reader.observe();
  assert.equal(evidence.preparationHeld.info.paused, true); assert.equal(evidence.preparationHeld.info.nextAlarm, null);
  const now = await clock();
  if (now % 60000 > 40000) await waitFailureTime(clock, (Math.floor(now / 60000) + 1) * 60000 + 1000);
  evidence.resumeRequestedAt = await clock();
  evidence.preparationResume = await host.json(['admin', 'dispatch', 'refresh', 'resume', active.id, active.digest]);
  assert.equal(evidence.preparationResume.observed, 'running');
  evidence.before = await reader.observe(); const time = evidence.before.info.nextAlarm; evidence.time = time;
  assert.ok(Number.isSafeInteger(time) && time % 60000 === 0 && time > evidence.before.completedAt + 5000);
  evidence.first = await pollReplacement('saved result and future persisted retry', reader, observed => {
    const thrown = observed.attempts.some(row => row.scheduled_time === time && row.job === 'advisory' && row.outcome === 'thrown' && row.result_saved_at !== null);
    const retry = observed.bucket.wakes.find(row => row.due_ms === observed.info.nextAlarm && row.due_ms > time && row.due_ms < time + 60000 && row.due_ms > observed.completedAt + 500);
    return thrown && retry;
  }, 90000);
  evidence.retryWake = evidence.first.bucket.wakes.find(row => row.due_ms === evidence.first.info.nextAlarm);
  evidence.completed = await pollReplacement('original occurrence succeeds after lost acknowledgement', reader, observed => ['inventory', 'advisory'].every(job => {
    const attempts = observed.attempts.filter(row => row.job === job && row.scheduled_time === time);
    return attempts.length === 2 && attempts.every(row => row.finished_at !== null) && attempts.some(row => row.outcome === 'success') &&
      observed.occurrences.some(row => row.job === job && row.scheduled_time === time && row.status === 'complete' && row.attempts === 2 && row.duplicates === 1);
  }), 10000);
  assert.deepEqual(evidence.first.bucket.owner, evidence.before.bucket.owner); assert.deepEqual(evidence.completed.bucket.owner, evidence.before.bucket.owner);
  for (const job of ['advisory', 'inventory']) {
    const attempts = evidence.completed.attempts.filter(row => row.job === job && row.scheduled_time === time).sort((a, b) => a.entered_at - b.entered_at);
    assert.deepEqual(attempts.map(row => row.outcome), job === 'advisory' ? ['thrown', 'success'] : ['success', 'success']);
    assert.ok(attempts.every(row => row.release === 'final' && row.cron === '* * * * *' && Number.isSafeInteger(row.result_saved_at)));
    assert.equal(attempts[0].result_saved_at, attempts[1].result_saved_at);
    assert.ok(attempts[1].entered_at >= evidence.retryWake.due_ms && attempts[1].entered_at >= attempts[0].finished_at && attempts[1].entered_at < time + 60000);
    const results = evidence.completed.results.filter(row => row.job === job && row.scheduled_time === time); assert.equal(results.length, 1); assert.equal(results[0].saved_at, attempts[0].result_saved_at);
    const occurrence = evidence.completed.occurrences.find(row => row.job === job && row.scheduled_time === time);
    assert.equal(occurrence.status, 'complete'); assert.equal(occurrence.attempts, 2); assert.equal(occurrence.duplicates, 1);
  }
  evidence.healthySource = await setRefreshSource(host, fixture, 'healthy');
  evidence.future = await pollReplacement('later healthy final-release jobs', reader, observed => ['advisory', 'inventory'].every(job =>
    observed.attempts.some(row => row.job === job && row.scheduled_time === time + 60000 && row.outcome === 'success') &&
    observed.results.some(row => row.job === job && row.scheduled_time === time + 60000) &&
    observed.occurrences.some(row => row.job === job && row.scheduled_time === time + 60000 && row.status === 'complete')), 90000);
  for (const job of ['advisory', 'inventory']) {
    const attempts = evidence.future.attempts.filter(row => row.job === job && row.scheduled_time === time + 60000);
    assert.equal(attempts.length, 1); assert.equal(attempts[0].release, 'final'); assert.equal(attempts[0].outcome, 'success');
    assert.equal(evidence.future.results.filter(row => row.job === job && row.scheduled_time === time + 60000).length, 1);
  }
}
