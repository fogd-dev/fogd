I found two blockers. The persistence approach is sound, but I wouldn't call retry identity fixed until both are closed. All of this is from reading the pinned source and the patch, plus re-running `scripts/celld-cron-regression.mjs` (7/7 pass). I changed nothing.

## Blockers

**B1. The legacy guard also catches the runtime's own alarm retries.**
- When an alarm handler fails (throws or hits its hard timeout), the runtime moves the alarm to `now + backoff` (`storage.rs:4398-4427`, then `4442-4466`). That deadline isn't on a minute, and it no longer equals `owed.armedFor`.
- So the next wake reaches `owed === null && scheduledTime % 60_000 !== 0`, skips the run, and `_arm(null, [], false)` overwrites the stored record with `{retry: 0, owed: null}`.
- Ways in: a scheduled handler that runs past the alarm wall/CPU limit, `transactionSync` throwing (SQLITE_FULL), or a failing drain. This happens on a first occurrence or on a retry wake.
- Stock runtime behaved differently. `cron::matches` rounds the time down to its minute (`logic/cron.rs:426-427`), so stock re-ran the matching expressions. Your negative evidence shows exactly that. The patch turns "re-run with the wrong time" into "silent drop".
- Fix (small):
  - Only apply the legacy skip when `info.retryCount === 0`. `setAlarm` resets `retry=0`; the runtime's backoff increments it.
  - When `info.retryCount > 0` and a record exists, use the record even though `armedFor` doesn't match.
  - When `info.retryCount > 0` and there's no record, use the occurrence `Math.floor(t/60000)*60000` instead of skipping.

**B2. `fetch()` can stall the cron cell for good.**
- `fetch()` returns 204 whenever `this._owed !== null`, and `_owed` is now stored and reloaded.
- If the alarm row is gone but the record survives, every deployment-load `fetch()` returns early and the cron never fires again. Ways the row can go: the runtime gives up retrying and deletes it (`storage.rs:4455`), or an external delete or restore.
- The old in-memory `_owed` self-healed when the object was rebuilt. Fix: return early only when `getAlarm() === this._owed.armedFor`; otherwise re-arm.

## Correct as written
- **Atomicity.**
  - The `__alarm_set` / `__alarm_delete` calls and `__storage_put` go through the same SQLite transaction.
  - `publish_alarm` holds publication back while not in autocommit, and the outermost commit registers the wake-entry gate (`storage_ops.rs:739-741`). Rollback cleans up the watcher.
  - This matches the Workflow cell's `StorageTransaction` (`harness.js:8742-8756`).
  - Skipping `setAlarm`'s `_flushPendingPuts` is fine: the cron cell never queues async puts.
  - In-memory fields are assigned only after commit, so they stay correct on rollback.
- **Owner killed before commit:** the alarm row and generation are unchanged, so the survivor fires at `armedFor` and the record matches. Killed after commit: the new record and alarm are both durable. Callbacks that succeeded in an interrupted attempt re-run (at-least-once). Fine, but say so in the patch note.
- **Internal sync APIs:** `kv.get` in the constructor and `transactionSync` at depth 0 are valid on the root storage. The `.cron:` scope is reserved, so the `__cron_retry_v1` key can't collide with user data.
- **Mixed or downgraded runtimes:** a stale record only matches on exact millisecond `armedFor` equality. With B2 fixed, that's harmless.

## Minor
- The record is loaded only in the constructor. If an instance can survive losing and regaining ownership without being rebuilt, its in-memory `_owed` is stale. Reading `kv.get` at the top of `alarm()` and `fetch()` is cheap and removes the question.
- Duplicate expressions (e.g. two `* * * * *`): `indexOf` collapses both onto the first index, so it runs twice. That's harmless, but check whether deploy deduplicates them.
- In `alarm()`, `due` is computed before the legacy check. Move the check up so the order reads clearly.

## Harness
- It runs the real class, which is good, and the rollback case does exercise a failure inside the transaction.
- The model can't reach B1 or B2:
  - It never passes `retryCount`.
  - It has no runtime backoff path.
  - It never deletes the alarm while a record survives.
- Its `__cron_plan` ignores `fired`, so it matches all expressions every time. That happens to agree with real minute-rounding for these two expressions only.
- Add these cases:
  1. A backoff wake (`retryCount: 1`, fractional time, record present): the record is used and only the failed expression runs at the original minute.
  2. A backoff wake with no record: it runs at the rounded-down minute and isn't skipped.
  3. Record present, alarm row missing, then `fetch()`: the cell re-arms.
  4. A `transactionSync` throw inside a retry wake, then the runtime backoff: identity is kept.

## Negative control
It's valid. `retry-identity` shows:
- The owner went from epoch 1 to 2 (a → b), with the same release hash on both.
- The kill happened at `…080864`, before the deadline at `…084015`. Both expressions then ran at `scheduledTime = …084015` on a new instance, at `…123840`, after the kill.
- The sibling re-run plus the fractional time prove the stock bug.

What it doesn't cover:
- It doesn't exercise the runtime-backoff path (B1).
- The survivor took about 40s to fire, which is under the next occurrence. Keep the `< next occurrence` margin check, or a later run could pass for the wrong reason.

## Before declaring it fixed
1. Fix B1 and B2, and add harness cases 1–3.
2. Make `scripts/cron-retry.mjs` take an expected outcome. On the patched build it should assert exactly one retry event: `cron: '* * * * *'`, `scheduledTime: initial.scheduledTime`, from a new instance, after the kill. It should also assert the sibling didn't re-run.
3. Add one patched-runtime run that forces the runtime backoff path, e.g. a scheduled handler that hangs past the alarm timeout once. That shows B1 is closed end to end.
4. Update the patch note:
   - The legacy skip applies only to `retryCount === 0`.
   - Callbacks may run again (at-least-once) if a crash lands before commit.
   - Retries of the old in-memory kind, written by a pre-patch runtime, are lost.
