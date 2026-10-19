# M11a runtime probe review — Claude

I reviewed the scripts, the four docs, both evidence sets (held and recovery), `controller.mjs` and `backend.mjs`, and the upstream `/state` and budget code. I ran nothing against Docker.

**Verdict:** the evidence supports building M11a on persistent pause plus compatible overlap, with no upstream patch. It does not yet support changing admission. The harness passed for real and its key runs had enough margin, but two of the most important things it observed are saved and never asserted. The biggest remaining risk, an old handler running across a D1 migration, has not been tested at all.

## What the evidence proves

| Claim | Status | Grounding |
|---|---|---|
| Bootstrap pause blocks the first consumer | Proven for a direct Worker | `first-publication.json`: no effects after 3s, backlog 1, then completed under v1 after resume |
| A held v1 handler finishes under v1 | Proven | `held` started 054412 and completed 066416 under v1 |
| Pending work runs under v2 | Proven | `pending` ran under v2 at 056357 |
| **v1 and v2 handlers run at the same time** | Observed, not asserted | v2 finished `pending` 10s **before** v1 finished `held`. So this is real concurrent overlap, not "v1 finishes, then v2 starts" |
| The queue cell moved to the new generation before resume | Observed, not asserted | `held-before-resume` on slot-2-a shows `cells: {"__Queue:…": 4}` with `generation: 4` and version `53966eff…` (v2). `actor.rs:1748` confirms the map is cell → generation. The v1 handler was still counted as an in-flight request (`requests: 1`) in draining generation 3. This answers the earlier review's B2 concern for this run, and shows a v1 handler can settle against a queue cell already on the new generation. |
| Pause with `stored: 0` does not mean quiet | Proven | `wait-until-before`: paused, stored 0, no wait-until event. The R2 write landed at 075497, about 8s later |
| A live-lease count of zero cannot prove no work | Follows from the row above | The message was acknowledged when the handler returned, so its lease was gone while `waitUntil` was still running |
| `max_retries: 1` gives 2 attempts, then deletion | Proven for a handled throw | Attempts 1 and 2 about 1s apart, then `stored: 0` |
| Over-budget handlers get no late effect | Proven, with margin | Attempt 2 started 11:35:16.362, so a 27s handler would have finished at 11:35:43. The evidence was saved at 11:36:01, 18s later. The attempts were 37s apart (my reading: lease expiry). |
| Paused pending and killed work survive stopped backup/restore | Proven | Restore took about 64s, longer than the 37s gap, so the held lease had already expired. The 3s check therefore covered both messages. The held message reran as attempt 2 only after resume. |

**Not proven:** whether `waitUntil` is bounded. Upstream's own comment says the budget "bounds the *response*, not the request: `waitUntil` work continues after the client has been served" (`js.rs:3697`). Also unproven: anything about D1 or migrations, Void code generation, controller crashes, retention, retirement, or termination of non-R2 I/O. "No late completion marker" only means no R2 write after the kill.

A side observation: at `wait-until-before`, the current generation's isolate showed `requests: 1` while the `waitUntil` was pending. That suggests the census can see `waitUntil` work, but it is one sample with no negative control. Don't build a drain on it.

## Harness fixes

1. **`queue-lifecycle.mjs:28`: assert the generation property.** For each consumed queue, exactly one node across `state()` should host `__Queue:*`, its generation should equal that node's `generation`, and that generation's `version` should equal `v2.version`. Without this, a future run could deliver to v1 and still pass whenever v1 happens to write the same markers.
2. **Line 33: assert the overlap.** Add `pending.completed.at < held.completed.at`. That is the condition the compatibility contract depends on. A faster fixture would quietly turn it into a sequential test.
3. **Lines 37–44: turn the `waitUntil` section into a PASS with assertions.** In `wait-until-before`: `paused && stored === 0`, with no `wait-until` stage. In `wait-until-after`: the stage is present. The order of the two snapshots is enough; no clock comparison is needed.
4. **Lines 46–50: prove exhaustion is final.** After `emptyQueue`, wait `retry_delay` plus a margin, assert no attempt 3, and derive the expected count from the consumer's `max_retries` rather than hard-coding `2`.
5. **Line 55: base the over-budget wait on the evidence.** Replace the fixed 8s with "wait until attempt-2 `started.at` + `holdMs` + 5s". The 18s margin made this run valid by luck of sequencing, not by design.
6. **Check every pause/resume through `info`**, not just the verb's response (lines 22, 39, 43, 59, and recovery 16). This is the same intended-versus-observed rule the controller will need.
7. **`queue-recovery.mjs:18`: lengthen the hold.** `holdMs: 5000` left about 3s of slack; the `before` snapshot came 1.1s after start. It fails loudly rather than passing falsely, but it is flaky. Use `budget * 600`, as the lifecycle script does.
8. **Recovery line 34: assert the lease had expired.** Record the stop time and assert that the time of the paused check minus the stop time exceeds the lease gap. Restore took 64s this time, which made the check meaningful, but nothing guarantees that.
9. **Fixture coupling.** Line 15 pauses every slot, so slot-1 must already have a deployment with queues. Document that. Also, the restored stack is left running, so add a cleanup note.

## Bootstrap first-publication safety

The bootstrap is sound as a substitute for "no deployment pointer yet." It runs no app code and attaches no consumer, and the pause survived consumer attachment, both replica restarts, and backup/restore. Remaining risks:

- **Queue set must match exactly.** The bootstrap's producer queue names must equal the approved artifact's consumed queue set, derived from Void's emitted config. Assert set equality before publishing it.
- **Adding a queue to an existing app is unsafe.** The current release has no queue support, so pause fails with `RuntimeFailed` (probe step 2). **Reject adding, removing or renaming queues after first activation in M11a.** That avoids a bootstrap-over-live-app path.
- **A retry after the app publish must not loop back.** The controller has to persist a "bootstrapped" step. If a retry sees `app.active == null` and publishes the bootstrap again, the consumer attachment is cleared (backlog stranded, though the pause still holds). The rule should be "pause and confirm before any publish," and the bootstrap should be chosen only when no pointer exists.
- **Possible simplification (needs a probe).** If `celld d1 migrations apply` works while only the bootstrap is published, the first deployment can use the same order as an update: pause → migrate → publish. That would remove the "publish before migrate" special case at `controller.mjs:199`. If it doesn't work, publishing before migrating is still safe while paused.

## Minimum lifecycle boundary (no upstream patch)

Persist the intended delivery state and the current step before every effect. The flow is:

1. **No pointer yet:** publish the platform bootstrap (exact digest recorded, never `app.active`).
2. Pause each consumed queue and confirm `info.paused`.
3. Migrate (additive only).
4. Publish, then wait for replicas (`ready`).
5. **Generation check:** every resident `__Queue:*` cell is on its node's current generation, and that generation's version is the published one. If not, keep polling or fail, still paused.
6. Resume and confirm `info.paused === false`.

On restart from any step before 6: pause and confirm again (idempotent), then continue. Never resume without a generation check passing in the same attempt.

**The overlap contract to write down:** code from an older release, including its `waitUntil` work, may run against any later additive schema. This includes the window where a v1 handler is still running during migration. Handlers must be idempotent by job ID, and v(n+1) must accept v(n) payloads. **Rollback is the gap here.** Re-approving an older artifact makes v1 consume backlog produced by v2. Reject rollback while `stored > 0`, or require an explicit operator acknowledgement that payloads are compatible.

**Backup:** refuse a stopped backup unless every consumed queue is both intended and observed paused.

**Admin surface:** `info`, `pause` and `resume` only.

An upstream patch is warranted only if gate 3 or gate 4 below fails. A live-lease count is not worth patching for: the `waitUntil` result shows it cannot close the gap.

## Remaining activation gates (each must pass before admission changes)

1. **Controller kill points.** Kill at: bootstrap published / not paused; paused / app not published; published / not migrated; mid-migration; migrated / not resumed; resume sent / not observed. After restart, `info.paused` must be true unless the intent is "resumed" and gate 3 passed. The consumer should write a D1 schema marker, and no consumer effect may show a pre-migration marker.
2. **Interrupted publication.** SIGKILL between the attachment CAS and the pointer write, then restart a node. It should fail to boot; republishing should recover it; the pause should hold throughout.
3. **Generation check as a negative test.** Re-run the held scenario with the generation assertion from fix 1. Also cover the case where the queue cell is not resident: call `info` first so the cell is instantiated, then check.
4. **Migrate with a v1 handler in flight (Void app plus D1).** v1's write succeeds against the migrated schema, v2 handles pending work, and there are no duplicate business rows.
5. **`waitUntil` bound.** Use `waitUntilMs = budget + 15s` and record whether the effect lands. Document the result under the contract either way. It only blocks admission if the schema contract is not additive.
6. **Exhaustion plus a process kill.** With `max_retries: 1`, two crashes delete a message (the recovery run already showed a kill counts as an attempt). The Void app's reconcile/retry path must recover the job from its durable record.
7. **Retention.** Restoring work older than 4 days loses messages, so it needs an explicit acknowledgement. Verify with an upstream test or test clock, not the host clock.
8. **Uncertain pause/resume.** Inject a timeout on the verb; the controller retries and reports intended versus observed state.
9. **Admission negatives.** Reject a dead-letter queue, `max_concurrency`, `delivery_delay`, `script_name`, queue add/remove/rename, and rollback with backlog.
10. **Retirement and isolation.** A retired fleet's queue never resumes in a replacement fleet, and the three-app isolation contract still holds.

**Blockers for any admission change:** gates 1, 3 (with the assertion), 4 and 6. The rest can be done during implementation, but before support is claimed.
