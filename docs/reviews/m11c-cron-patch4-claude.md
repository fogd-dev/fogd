# Claude review: cron retry candidate 4

I found no correctness blocker in the six-retry cap. There is one blocker in the stop-dispatch precondition, but it only applies to rollout or supported-capability claims, not to the disposable qualification. Three documentation fixes are also needed before the note is accurate.

## What I checked

- **Patch versus source.** `patches/celld-0.6.2-cron-retry.patch` was rewritten at 09:32 while I was reviewing; my first read was the older version without the cap. The current file includes the cap at patch line 114, and its cron hunks match `.fogd/celld-cron-source3`. The only other difference in that tree is the preaccept-attachment hunks.
- **Regression.** I applied the current patch to a clean `v0.6.2` checkout of `js.rs` and `harness.js` and ran `scripts/celld-cron-regression.mjs`: 15/15 pass. Source3 also passes 15/15.
- **Native wiring.** `info.retryCount` is the alarm row's total `retry` column (`js.rs:5498`, `js.rs:5510`). Every failure increments it, counted or not (`storage.rs:4459-4461`). It lives in SQLite, so it survives a change of owner. `set_alarm` resets it to 0 (`storage.rs:4205-4213`).

## The six-retry cap works

- **CPU and wall-clock loops now end.** Termination failures bump the retry count without counting against the limit (`js.rs:6417`). Backoff then schedules wakes at +2, +4, +8, +16 and +32 s. The wake at retryCount 6 skips the callbacks and calls `_arm(null, [], false)`, which moves on to the next future occurrence. This fixes B1 from the candidate-3 review.
- **Counted failures improve on stock.** The native ceiling only deletes the alarm on the 7th counted failure (`logic/alarm.rs:27`; `counted_retry` reaches 6 at that point). The JS cap fires at the wake that failure would have produced, so the cron cell advances instead of being deleted and staying dead until the next deploy-load `fetch()`.
- **Order of checks is safe.** A wake with no record and `retryCount > 0` takes the legacy-skip path first. The cap only applies when a record exists. The `__alarm_set` inside the cap's `_arm` changes the alarm generation, so `finish_alarm_handler` won't overwrite it with a native bump (`storage.rs:4414-4416`).

## Inaccuracies in the cap (not blockers)

1. **The cap is per armed alarm, not per occurrence.** Note lines 34-35 say "six attempts for one occurrence." Each JS-level retry calls `__alarm_set`, which resets `retryCount` to 0. A callback that sometimes throws and sometimes times out can therefore get up to six native attempts for each JS retry, and the JS retries themselves allow up to six (`logic/cron.rs:630`). The total is still bounded, so liveness holds; the sentence just overstates it. If you want the bound to be literally per occurrence, store an attempt counter in `owed` and cap on that instead. Otherwise reword the note.
2. **One timing-out callback blocks its siblings every minute.** Callbacks run in sequence (`harness.js:5945`). If an expression always hits its CPU limit, the expressions after it in `due` never run for that occurrence, and the cap then moves past them. This repeats every occurrence. Stock behaves the same way, so it isn't a regression, but the note should say it.
3. **The 6 is a copy of a Rust constant.** `retryCount >= 6` duplicates `RETRY_CEILING` (`logic/alarm.rs:11`) and the regression model's `count < 6`, and nothing links them. A comment naming the Rust constant would cover it.

## Blocker for rollout claims: the stop-dispatch precondition (note lines 38-45)

The precondition is right in substance. The stale-record replay hazard from the candidate-3 review is still real. But as written it can't be carried out and nothing checks it:

- **"Stop cron dispatch across the fleet" names a control that doesn't exist.** Operator pause is still an open M11c obligation (`docs/m11c.md:35-38`, `:73`). The only way to stop dispatch today is to stop every node: any running node that owns `.cron` fires its alarm. Deploy-load `fetch()` arms on every node.
- **"Before resuming dispatch" has no defined moment.** Dispatch resumes as soon as any node starts. The steps that actually work are: stop every node, replace the binary everywhere, then start them. The note should say that and call it full downtime.
- **A violation is silent.** A stock node that joins later (old image tag, autoscaler, rollback) arms T2 with a fresh alarm and leaves the T1 record in place. A native backoff of T2 then replays T1 with `scheduledTime = T1`, and nothing logs it.
- **Fix:** reword the precondition as an all-nodes-stopped cutover. Keep "no supported, rolling or mixed-version claim" until either the M11c pause exists or the record is tied to the alarm generation (the Rust option from the candidate-3 review). With generation binding, a stale record would fall into the existing legacy-skip path instead of a replay. This doesn't block qualification on a disposable install.

## Smaller fixes to the note and packaging

- `docs/patches/celld-cron-retry.md:68` still says "fourteen modeled cases"; it is fifteen now. Lines 63-64 list the covered cases but don't mention the native-retry bound.
- `docker/celld-cron-patched.Dockerfile:2` defaults `CELLD_TESTED_IMAGE` to `fogd-celld-cron-build4:local`. The note's build steps tag `fogd-celld-cron-tested:local` and then build the Dockerfile without `--build-arg`. Followed as written, the steps package whatever `build4` holds, not the image just built. Make the two names match or pass the arg in the note.
- Still open from the candidate-3 review: a CPU kill inside `_arm`'s `transactionSync` skips its `catch`/`finally` (`harness.js:1790-1811`). The cap makes this path run more often, because the capped wake calls `_arm`. The CPU-timeout check should confirm that the wake after a kill can still commit.

## Verdict

This is ready for disposable-install qualification once the note is corrected. It is not ready for any rollout or supported claim until the precondition can actually be executed and enforced (pause control or generation binding). As you said, native runtime qualification hasn't been run: the build failed at apt signature verification. The CPU-overrun check should use a callback that always times out, and should confirm the cell runs exactly six attempts and then fires at the next future occurrence.
