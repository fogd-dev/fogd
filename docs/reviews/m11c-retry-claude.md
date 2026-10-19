The SIGKILL plan is viable with two changes: don't restart the killed owner until the outcome is recorded, and gate the kill on an observable that shows the retry deadline is durable. Your other two questions: the cold-boot arm does overwrite a future retry deadline, and nothing in the source suppresses eviction permanently.

## What the source says

- **Backoff:** a first failure re-arms at `now + 2000<<1`, so 4 s (`logic/alarm.rs:30-31`, `cron.rs:629`). The retry deadline lands in the same minute as `T`. A fresh object with `_owed === null` therefore runs `matching(crons, T+4s)`, which reruns both expressions with `scheduledTime = T+4000` (`harness.js:5913-5923`).
- **Cold boot overwrites the retry.** `spawn_cron_arm` → `fetch()` on a fresh object (`main.rs:788`, `harness.js:5898-5906`): `_owed` is null and `getAlarm()` returns `T+4s`. If that is still in the future, `_arm(null, [], false)` replaces it with `T+60s`. The retry is silently dropped, a different symptom from the one you're after. If the deadline is already overdue, `fetch` leaves it alone. Only boot and deployment adoption call `fetch`; handoff and the wake/takeover path don't.
- **Eviction isn't permanently suppressed.** With `CELLD_ALARM_RESIDENT_MS=0`, `alarm_is_imminent` only refuses an alarm that is due or firing (`logic/lib.rs:5846`). A refusal waits one more idle period (`lib.rs:6125`), and idle eviction only runs on the 1 s load sample (`main.rs:3429`). Add `CellActive` and the alarm-coverage wait, and a 4 s window simply isn't deterministic. `"stops": 2` in `owner-state.json` already shows eviction works. A third idle run would just be another lottery ticket.
- **Your `instance` marker is weak.** It lives at module scope, and isolates are pooled per script (`isolates.cells.cron-retry`), so it could survive a cell eviction that does rebuild `CelldCronSchedule`. `scheduledTime` is the real signal. The `assert.notEqual(original.instance, retry.instance)` in `cron-retry.mjs` could fail falsely on an idle path. SIGKILL fixes this because the process dies.

## Recommended experiment: SIGKILL, survivor takes over, A stays down

Takeover needs A's node lease to expire (`CELLD_TTL_MS`, default 10 s, `machine.rs:101`) and then B's due scan. So the retry is already overdue when B activates the cell, and B never calls `fetch`. That ordering comes from source, not from elapsed time. Restarting A early would add a `fetch` and with it the overwrite race. Restart A only during cleanup.

**Prerequisites before the kill (all observed, none injected):**
1. In R2, exactly one `* * * * *` event and one `*/1 * * * *` event at minute-aligned `T`, same instance `I1`, and `failed-once` present. The sibling event means the alarm turn has reached its final `_arm`.
2. Owner record `cells/.cron:cron-retry/own.json` shows node A, epoch `e1`; A's `/state` `residents` contains it. Use the bucket reader `live-move.mjs` already has.
3. A new wake publication for `.cron:cron-retry` appears under `wake/entries/<minute(T)>/…` after the sibling event, beyond the one that existed for `T` (`wake.rs:236`). Read its body to confirm the due time is about `T+4000`, if the body carries one. This is the durability gate.
4. `docker kill -s KILL <A>` before `T+4000`, recording `killAt`. If any retry event has `at < killAt`, the run is **inconclusive (missed window)**, not negative.

**Assertions after the kill (A stays down):**
- Owner record shows node B with epoch greater than `e1`, and B's `deployment.version` equals the original release hash.
- B produces events with a new instance `I2 ≠ I1`:
  - `* * * * *` with `scheduledTime % 60000 !== 0`, ≈ `T+4000`;
  - the sibling `*/1 * * * *` reruns with the same `scheduledTime`.
- That confirms the bug.

**How to classify other outcomes, recorded rather than retried blindly:**
- Retry carries `scheduledTime == T` with `I2`: `_owed` survived somehow, which disproves the hypothesis.
- No retry, and the next events are minute-aligned at `T+60s`: a `fetch` overwrite happened. Check B's logs for a cron arm.
- Both expressions rerun at `T` itself: B restored SQLite from before the retry `setAlarm`, so replication was behind the kill. Inconclusive.

## Caveats

- I couldn't confirm from source that cell SQLite replication finishes before the wake entry PUT, so prerequisite 3 is the best gate available, not proof. The last classification above covers the case where it isn't.
- A graceful `docker compose stop A` avoids that replication race, because a drain proves replication before release. The catch: if the drain takes longer than 4 s, the retry fires on A with `_owed` intact, which is a wasted run but not a false result. I'd use SIGKILL first and graceful stop as the second control.
- Neither option patches the runtime, injects a scheduled call, or changes the script mid-run.
