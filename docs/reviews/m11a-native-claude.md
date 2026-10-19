# Claude review: native imports qualification

I'd hold the crash qualification until the probe is changed: as written, its result looks the same whether or not the kills actually did anything. The initial and update probes look sound; they need a few tighter assertions, not a re-run.

## Blockers for this fixture

**1. High: the crash probe can't tell a replica kill apart from a handler-budget timeout** (`scripts/queue-native-crash.mjs:9`)
- `delayMs: 30000` is longer than the fixture's 20 s handler budget (`context.json` records `handlerBudgetSeconds: 20`).
- So both attempts would end with no completion even if nothing were killed. The outcome would be the same: 2 attempts, `status: accepted`, no results, `stored: 0`.
- `queue-qualification.md` already says a handler that runs past the budget leaves no late marker, so a budget timeout really can look exactly like this.
- The PASS line ("two killed consumers…") is a claim the test doesn't actually check.
- **Fix:** use a delay that finishes inside the budget, e.g. 12–15 s.
  - Record when each attempt was observed starting and when the stop happened. Assert the stop came before start + delay.
  - Then "no completion" really is caused by the kill.
  - Optionally add a control job with the same delay and no kill, and assert it completes.

**2. Medium: "without a failure row" is only half checked** (`queue-native-crash.mjs:23`)
- `failed(db, id, false)` writes `status='accepted'` plus an error message.
- So if the catch block ran after a non-final attempt, the job would still show `accepted`. The status check only rules out the catch running on the final attempt.
- **Fix:** add `assert.equal(exhausted.error, null)`, which rules out the catch block on either attempt.

## Should fix (assertions that are weak or rely on the schema)

**3. Medium: no live duplicate-delivery case** (`scripts/queue-native.mjs:26`)
- The m11a acceptance list asks for "duplicate delivery". Line 26 re-submits a job that is already complete, so nothing is sent; the probe's own "idempotent submission" check is this same case.
- Results can't be duplicated anyway because the `(job_id, position)` primary key plus `ON CONFLICT DO NOTHING` prevent it.
- **Fix:** while paused, POST the same `{id, text}` twice, resume, and assert `attempts === 1` and the row count matches. Since `processJob` skips jobs that are already complete, `attempts` is what shows the second delivery was a no-op.

**4. Low–medium: the update probe doesn't check for redelivery** (`scripts/queue-native-update.mjs:33-34`)
- `processor: ['v1']` can't show that v2 never touched the held job: an early return or a conflict no-op would leave the same rows.
- **Fix:** assert `held.attempts === 1`, `pending.attempts === 1`, and `queue('info').stored === 0` before the final pause. The evidence shows 1/1 today, but nothing asserts it.

**5. Low: the paused-gate check looks at results, not handler starts** (`queue-native.mjs:23`)
- **Fix:** also assert `attempts === 0`. That proves the handler never started, which is a stronger statement than "it didn't finish in 2 s".

**6. Low: consumer settings are trusted as emitted** (`scripts/queue-probe/native.mjs:15-16`)
- Only the consumer's queue name is checked. The `max_retries: 1` coming from Void's `export const maxRetries` is what the crash and poison counts depend on.
- **Fix:** `deepEqual` the whole consumer object, so a Void change fails at staging rather than mid-probe.

**7. Low: the upload directory can merge with an old one** (`scripts/queue-probe/context.mjs` `upload`)
- `mkdir -p` followed by `cp dir/.` merges into an existing `/tmp/fogd-queue-probe-<slot>-<label>`.
- That folder lives in the controller container, and `requireEmptyFleet` only checks the bucket. A re-run on the same controller could pick up stale migrations or worker files.
- The update probe uploads `native-v2` twice. That's harmless today because the contents are identical.
- **Fix:** `rm -rf` the target first, or add a unique suffix.

**8. Low: probe order is implicit**
- The crash probe asserts `processor === 'v2'`, so it relies on the update probe having run first on the same fleet. The update probe in turn relies on the native probe's v1 deployment.
- Re-runs fail loudly, not falsely (the IDs are fixed, so stale `attempts` values break the polls).
- **Fix:** write down the order in `queue-qualification.md`, or check the current version first.

## Fixture and unit tests (not blocking)

- `queues/imports.ts:11`: the `attempts > maxRetries` rule for marking a job as finally failed, and the `retry-once` mode, have no unit test.
- No offline test applies `0002_processor.sql` and runs the v1 then v2 `resultWrites`, which would cover additive compatibility without a fleet. `fixture.mjs` only loads 0001.
- `submit` ignores `mode`/`delayMs` on a re-submission with the same hash, and re-enqueues `failed` jobs without resetting them. That's fine for a fixture; just note it.
- `build-env.mjs`: the move is a faithful extraction and the test covers it.
  - Nit: in `local.mjs` the new import sits above the `node:` imports.

## Future production admission (not blockers here)

- **Lost work:** a consumer killed on its last attempt leaves the job `accepted` with no error, and the page polls forever. Production needs a reconciliation or outbox sweeper with a lease-based timeout, and a visible stuck state. Manual retry alone isn't enough.
- **Bypassed validation:** `stageNative` strips `queues` before `translateConfig` and adds them back unvalidated. The physical name `imports` isn't per-app, and `QUEUE_IMPORTS` skips the duplicate-binding check. Admission needs both.
- **Credential leakage into builds:** the build env is a denylist. It passes through `GITHUB_TOKEN`, `NPM_TOKEN`, and `CELLD_*`, plus `FOGD_ENV_FILE`, which is the path to `probe.env` and readable by app builds. Admitted builds should use an allowlist.
- **Retry changes the job:** explicit retry rewrites `mode` and `delay_ms`, so a replayed job runs with different options than it was submitted with. A real app must not mutate the job's spec when replaying.
- **No drain:** the update overlap rests on a 12 s held handler and wall-clock timing. That fits the "overlap, not drain" scope, but it shouldn't be described as a drain anywhere.

Nothing was modified. I read only the probe output (`.fogd/m11a-native-*`), and not `probe.env`.
