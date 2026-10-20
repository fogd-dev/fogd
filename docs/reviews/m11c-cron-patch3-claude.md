# Claude review: cron retry candidate 3

I found one correctness blocker. It isn't in the new native op itself. It's in the termination path that candidate 3 reasons about, and it makes one sentence in the patch note false. The guard swap from candidate 2 to candidate 3 is correct.

The 14 modeled cases pass when I run them against `.fogd/celld-cron-source3`. That tree's cron hunks match `patches/celld-0.6.2-cron-retry.patch`; the only other difference is the preaccept-attachment patch, which is also applied there.

## The native guard is correct

- **Entry before JS runs.** `storage::begin_alarm_handler` runs in the dispatch turn before `__fireAlarm` is called (`js.rs:5505`). A `fetch()` that runs after that point sees the flag. This closes the window before JS entry that the old `_active` counter could not see.
- **Cleared on every exit.** Every exit path goes through `finish_alarm_handler_with_retry_policy`, which removes the entry first (`storage.rs:4409`). That covers a successful settle (`js.rs:3448`), a rejection (`js.rs:5661`), a dispatch that never started (`js.rs:5556`), and termination, budget expiry or a stuck handler (`runtime.rs:3551` → `turn_finish_alarm`). Eviction also removes it (`storage.rs:911`). Termination never skips cleanup, because none of this depends on JS.
- **Stale entries heal.** If an entry is ever left behind, the next dispatch of the same row overwrites it in `begin_alarm_handler` and then clears it. The guard is tied to the row's lifecycle instead of the JS instance's, which is strictly better than S1's counter.
- **No race.** From the second check through the commit, `fetch()` runs in a single turn. `getAlarm()` is microtask-only (`harness.js:1704`), and `_arm` has no `await` before `transactionSync`. No alarm can begin in between, so the second `__alarm_active` check is redundant but harmless.
- **Not exposed to apps.** The op is passed only as an internal harness parameter (`js.rs:6491`).

## B1 (blocker): CPU and wall-clock failures retry forever, pinned to T

- CPU termination goes through `finish_turn` → `fail_in_turn` and does not settle the alarm (`js.rs:4395-4435`). The drive loop then settles it with `turn_finish_alarm` → `settle_alarm(false, false)` (`js.rs:6417`). Wall-clock expiry and stuck handlers take the same path.
- `alarm_retry` only applies `RETRY_CEILING` when `counts_against_limit` is true (`logic/alarm.rs:27`). These failures therefore never use up the ceiling, and backoff repeats every 128 s or less, with no end.
- With the persisted record, every one of those wakes has `retryCount > 0` and re-runs occurrence T's expressions with `scheduledTime = T`. That includes siblings that already succeeded and callbacks that called `noRetry`. `_arm` is never reached, so no later occurrence is ever armed. One cron callback that reliably exceeds its CPU or wall budget stalls the whole cron cell on T indefinitely.
- Stock also loops, but it reports a changing fractional time, so this is a liveness problem, not a regression. It does contradict `docs/patches/celld-cron-retry.md:33-34` ("Exhausting native retries removes the alarm…"), which is not true for these failure classes.
- Gate 3 as written ("exceed the CPU limit once") will not expose it.
- Fix: cap it in JS. At the top of `_runAlarm`, if `owed !== null && info.retryCount >= N` (where `retryCount` counts uncounted retries too), log, drop the owed occurrence and `await this._arm(null, [], false)`. Then correct the note and add a gate case where the CPU overrun is deterministic and expect the cell to move on to T+60 after N attempts.

## The uniform-fleet restriction: right in substance, but nothing enforces it

- The hazard is real: a stock owner arms T2 with `set_alarm` (retry=0, new generation) and leaves the T1 record in place. A native backoff of T2 then replays T1.
- Nothing enforces the rule, and a normal rolling binary upgrade breaks it: the first patched owner writes `__cron_retry_v1`, and a stock node can take over the cell later in the same rollout. Re-upgrading after a rollback has the same problem, because stock never touches the key.
- Two ways to handle it:
  - **Procedure only:** state in the note that a full-fleet replacement with cron dispatch stopped is a precondition. The disposable qualification install already satisfies that, so this doesn't block qualification. It does block any supported or rollout claim, especially while M11c holds don't exist.
  - **Remove the restriction:** you're already patching Rust, so bind the record to the alarm generation. `ActiveAlarm.generation` is already stored (`storage.rs:4379`). Have the op return the active generation, have `_arm` record the generation it wrote (read it back inside the transaction on the same connection), and in `alarm()` treat a mismatch as having no identity, which leads to the existing legacy-skip path. A stale record then becomes the documented skip instead of a replay.

## Concrete gaps this revision introduces (not repeats of the existing list)

1. **The guard is per isolate.** It reads the active-alarm map that belongs to the isolate the cell is open in (`storage.rs:59-62`). If a deploy-load `fetch()` for `.cron` can run in a new deployment's isolate while the previous isolate is still running the alarm, the new isolate sees `false`. Its `getAlarm()` also isn't hidden there, so it can re-arm over the running handler. The old JS counter had the same scope, so this isn't a regression. Gate 6 should run the race across a real redeploy, not only a cold instance in one isolate.
2. **The model doesn't exercise the native lifecycle.** "Host settlement releases arming" only toggles a boolean. It proves the JS doesn't cache the flag, not that the native code clears it, so only gate 5 settles S1. The model's `getAlarm` also hides the row for any active handler, while native hides it only when the generation matches (`storage.rs:4222`). That's harmless for the current code, but worth knowing.
3. **Note only:** a CPU kill that lands inside `_arm`'s `transactionSync` skips its `catch`/`finally` (`harness.js:1788-1810`). That leaves the savepoint and `_activeSyncTransaction` open, and with `actor_scope: None` nothing resets them (`js.rs:2828`). This affects all harness code that uses `transactionSync` and isn't specific to this patch, but the patch note shouldn't imply `_arm` itself survives termination.

## Verdict

Hold. Fix B1 with the retry cap and correct the note. Then either add generation binding or state the stop-dispatch full-fleet replacement as an explicit precondition. After that I see no remaining JS-side blockers. The native build, owner-loss and CPU-timeout qualification are still unrun, as you said.
