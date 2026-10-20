# Claude review: cron retry candidate 2

**Verdict:** The JS logic in candidate 2 has no blockers. B1 and B2 from the first review are closed. It is not qualified yet: the build-stage run you described as in progress has actually failed, and the native proofs below have not been run.

## The build failed
`.fogd/m11c-cron-candidate2-build.log` stops at 19:50 with `No space left on device (os error 28)`, then `could not compile celld` and exit code 101. Nothing is building. Free some Docker or BuildKit disk space and rerun it before any native gate.

## Fixes confirmed against the native code
- **B1.** `set_alarm` resets `retry=0` and gives the alarm a new generation (`storage.rs:4045`, `4211`). Native backoff increments `retry` (`storage.rs:4459`). So `info.retryCount > 0` reliably means "native backoff of the alarm this cell armed", and using the pending record in that case is correct. Hard timeouts, rollback inside `_arm`, and a dispatch that never ran (`js.rs:5556`) all keep the record intact.
- **The every-turn record.** Every alarm the cell arms now has its identity committed in the same transaction. With no record, a wake is skipped only when `retryCount > 0` or the time isn't on a minute. Since you've ruled out guessing a time by rounding, that is the right boundary.
- **Upgrade path.** That path writes only `kv.put` inside `transactionSync`, so the alarm generation is unchanged and `finish_alarm_handler` still deletes or bumps the original row. Correct.
- **B2.** `fetch()` heals a missing row and keeps a backoff deadline (`armed !== owed.armedFor`). For a normal pending occurrence it re-arms from the current `crons`, which also applies a deploy that changed the schedule. Correct.
- **Race between a cold `_ready()` and `fetch`.** `begin_alarm_handler` hides the alarm before `__fireAlarm` awaits `_ready()`. When a fetch resumes from the same promise first, its `getAlarm()` resolves one microtask later. By then the alarm continuation, queued earlier, has run `_active++`, so the second check catches it. Running all of `alarm()` inside that one microtask gap isn't possible. The two-check pattern holds.
- **Expression changes.** Removing an expression filters it out. Reordering is handled because identity is by expression, not index. If every owed expression was removed, `_arm` just arms the next occurrence. Duplicate expressions still collapse to one index, which is harmless.

## Should fix, or prove natively

**S1. `_active` can stay stuck after a CPU-limit termination.**
- The CPU-limit paths (`js.rs:2579`, `2745`) call `terminate_execution` with `actor_scope: None`. V8 termination unwinds without running JS `finally` blocks, so `alarm()` never runs `_active--`.
- `take_execution_termination_in_context` only resets the instance when `actor_scope` is set (`js.rs:2828`). In the source I read, I found nothing that discards the cron instance after a CPU kill.
- If the instance survives, every later `fetch()` on it returns 204. The row can still disappear, for example after six counted failures the ceiling deletes it (`storage.rs:4455`). The cron then stays dead until that instance is rebuilt, which likely means the next deploy.
- Stock heals at roughly the same point, so this is not worse than stock. But it does cancel the B2 heal in exactly the hard-timeout case this patch exists for.
- Fix: base the guard on the host's view of the handler, not a JS counter. `storage::active_alarm_scheduled_time(scope)` already exists, and a small `__alarm_active` op could expose it. That entry is removed when the event settles (`settle_alarm` → `finish_alarm_handler`), even after a termination.
- Or prove natively that the instance is discarded after a CPU kill.
- My trace of the termination path was not exhaustive, so treat this as likely, not certain.

**S2. A stale record can be reused if a stock node runs the cron cell.**
- Sequence: a patched node writes the record for T1. A stock node then owns the cell, fires T1, and arms T2 with `setAlarm`, so `retry=0` and the record is untouched. T2 hard-times out on the stock node, which bumps `retry` to 1. A patched node adopts the cell.
- Result: `retryCount > 0` with the record for T1, so the patched node re-runs T1's expressions with `scheduledTime = T1`, and T2 is lost.
- This only happens with a mixed fleet or a rollback. Don't solve it by guessing a time. Add a rollout rule instead: no stock node may own a `.cron` cell once a patched node has written `__cron_retry_v1`. On rollback, delete that key.
- Put this in the patch note next to the existing note on bounded legacy loss.

## Minor, document only
- **noRetry and successful siblings.** If an expression called `noRetry()` and a later expression then hard-times out, the native retry runs every expression in the record again, including the `noRetry` one. That follows from the at-least-once behaviour you already state. Mention `noRetry` explicitly.
- **Backoff can pass the next occurrence.** Native backoff is not capped at the next occurrence (up to 128s per step). With `* * * * *`, a late wake for T runs T, then `_arm` uses `Date.now()`, so T+60 is skipped. Stock behaves the same and Cloudflare doesn't backfill either. Note it rather than fix it.
- **A schedule change before the first fire.** A normal-occurrence wake with `retryCount === 0` uses the expressions stored at arm time. If a deploy changes `crons` and the fire comes before `fetch()` re-arms, an expression added for that minute is missed once. Recomputing from current `crons` would close this (`armedFor === scheduledTime` and `kind === "occurrence"`). It's optional because `fetch()` already re-arms on deploy.
- **Ceiling exhaustion.** Six counted native failures delete the row, and only `fetch()` brings it back. That behaviour existed before this patch, but the gates should measure it.

## Native gates still needed
1. **Build.** Get a successful build, then rerun the 13-case regression against the built candidate. The 13 passes in `.fogd/m11c-cron-candidate2-regression.log` are from the JS harness, which stubs the storage and alarm calls.
2. **Retry after owner loss.** Kill the owner before the retry commits. Expect exactly one retry event, for the failed expression only, with `scheduledTime` equal to the original T, from a new instance, and no sibling re-run. Keep the check that it fires before the next occurrence.
3. **Hard timeout on a first occurrence.** Have the handler exceed the CPU limit once. The wake has `retryCount ≥ 1` and a fractional time, and `controller.scheduledTime === T`. Cover a backoff that crosses a minute boundary too.
4. **Hard timeout on a scheduled retry wake.** Identity is kept and the scheduled-retry count continues.
5. **`_active` after a CPU kill.** After step 3, delete the row or exhaust the ceiling, then trigger a deploy-load `fetch()`. The cell must re-arm. This settles S1.
6. **Concurrent `fetch()` during an active handler.** Run it on a cold instance, with the deploy-load fetch racing the alarm. The hidden alarm must not be overwritten. The generation should change only via `_arm`.
7. **Rollback in `_arm`.** Inject a failure into `transactionSync` (for example SQLITE_FULL). The native retry uses the record from before the failure.

Native `.cron` registration still depends on a non-empty `crons` list, and hold controls are separate. Both are outside this patch, as you said.
