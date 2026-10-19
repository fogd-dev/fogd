I'd go with **a strengthened version of A**. Scheduled jobs run through native Void cron and celld, with no extra scheduler. Before calling M11c done, A needs two fixes and a clear rule for when to add a small celld hold primitive (option B). Plain A as written is a narrowed shortcut, for two reasons:

- **Restore:** "resume" in A means "boot the fleet", and booting fires any stale overdue tick before the operator can do anything.
- **Durability:** a stopped fleet stays stopped only until the next `docker compose up`.

Everything below comes from reading the source; I made no Docker changes and no Cloudflare calls.

## What the source shows (beyond what you listed)

1. **Retries re-run jobs that already succeeded.** Void groups jobs by cron string (`void/.../compile.ts` ~436–460). If one job on an expression fails, the whole expression throws, and celld's retry (`failed.push(index)`) runs every job on that expression again. So the idempotency key has to be per job: `(job, cron, scheduledTime)`. A key per expression or per tick isn't enough. The test fixture needs two jobs on the same cron, one of them failing.
2. **Catch-up after downtime is at most one tick, and it is matched against the new schedule.** In `CelldCronSchedule.fetch()` (harness.js ~5904), an alarm that is already overdue is left alone and fires once with its *original* `scheduledTime`. Occurrences in between are skipped. In `alarm()`, that overdue time is matched against `__cell.crons` from the *currently adopted* deployment (comment ~5880). So:
   - If an update removes or changes that expression, the missed tick is silently dropped.
   - If the new schedule happens to match that minute, a new job runs for an old time.

   This needs a documented rule and a test.
3. **Arming can silently fail.** `spawn_cron_arm` (main.rs ~788–823) gives up after 30s without node authority, or after 5 failed attempts. It only logs, and the schedule stays silent until the next adoption. fogd currently has no way to see whether the schedule is armed: `/state` (main.rs:2883) shows nothing about crons as far as I can tell. A UI showing "last success" can't tell "never armed" apart from "nothing due yet".
4. **Restoring an old snapshot fires a stale tick immediately.** The alarm row lives in the cell's storage, so a restored fleet boots with an overdue alarm and runs it straight away. That repeats an occurrence whose external side effects (emails, API calls) already happened after the snapshot was taken. An occurrence-key table restored from the same snapshot can't stop that.
5. **Stopping a fleet isn't durable on its own.** `compose.yaml` uses `restart: unless-stopped`. That survives a Docker daemon restart, but any `compose up` (installation upgrade, operator redeploy) starts the fleet again and the timers fire.
6. **First activation publishes user code before migrations.** `activation.mjs:46` publishes first when there is no active release and no queue. With crons, celld arms on adoption (main.rs ~873), so a tick can hit an unmigrated schema. The queue bootstrap (`backend.bootstrap` and the bootstrap state in `prepareQueue`) already solves this for queues, but it is tied to queues: it includes queue producers and is gated by `activationQueue`.
7. **Updates already overlap old and new code.** For an active app, `activation.mjs` migrates and then publishes. Between those steps the cron cell's owner node may still be on the old generation, so old scheduled code runs against the new schema. HTTP already has this exposure. Extending the existing expand/contract schema rule to scheduled jobs is honest, but it has to be stated and tested on the node that owns the cron cell.
8. **A failed activation still has jobs running.** `failed()` sets `route = 'paused'`, but approved code that was already published keeps running its schedule. The current "failed / paused" display would be wrong for scheduled jobs.
9. **The internal trigger route is already blocked publicly.** The gateway blocks `/__void/`, so the synthetic `/__void/scheduled` route is unreachable from outside. Add it to the negative tests in `gateway.test.mjs` and `accounts-smoke`. fogd must never call that route itself: its `noRetry` is a stub, and it skips the native retry path.

## Recommendation: A plus a native-first hold, made concrete

**Changes to A:**

- **Migrate before publishing on first activation.** Generalize `backend.bootstrap` and the bootstrap state so that every first activation declaring crons does: placeholder publish (D1 bindings only, no `triggers`), then migrate, then publish user code. The placeholder must contain no crons, so arming is impossible until the schema is ready. This replaces "publish then migrate" for these apps. Simplest is to do it for every first activation.
- **Put the schedule in what the operator approves.** Admit only `triggers.crons`, parse it with the same grammar celld uses, and include it in `resourceIdentity` and the release record. A schedule change then appears as a diff at approval. Keep rejecting other trigger keys and `workflows`.
- **Label the stop control honestly.** Call it "Stop app (HTTP and scheduled jobs)", not "pause". Back it with fogd's durable desired state, and make sure `compose up` and installation upgrades can't start a stopped fleet (for example, keep fleets out of the default compose project, or check desired state before any start).
- **Retirement, expansion and restore keep the stopped-fleet model,** plus a required acknowledgment in the style of `queueRecovery`. Resuming a restored fleet must tell the operator plainly: "at most one overdue occurrence (scheduledTime T) will run immediately on boot".
- **Status is honest.** Failed or paused activations show "scheduled jobs: running on version X (published)" when that is true. Last success or failure comes from the app's own status table, keyed per job and occurrence. Without a hold primitive, the only ways to stop a misbehaving job are to stop the app or to approve a release that drops the expression; per harness ~5970, the cron cell then retires itself.

**Switch to B only if the experiment shows one of these:**

- (a) fogd cannot reliably keep a fleet stopped across installation lifecycle operations;
- (b) an operator must be able to skip the stale tick on restore, i.e. resuming without running it is required;
- (c) fogd cannot detect a schedule that failed to arm (item 3) using node inspection plus the app's status table;
- (d) users actually need jobs paused while HTTP keeps serving. Don't assume this demand exists.

**If B is needed, the smallest useful primitive** is a durable hold flag stored in the bucket that the `celld` CLI can set **while the fleet is stopped**, the same way `celld queue pause` works through `Backend.run`. That matters because a flag kept only in cell storage can't stop the stale tick that fires on boot. The scope:

- When held, `alarm()` skips the handler, re-arms for the next occurrence, and counts the skipped ticks.
- A `celld cron info --json` command reports `{held, alarmAt, running, lastFiredAt, skipped}`.
- fogd waits for `running == false` before treating a hold as fenced.

Leave out:

- a durable `_owed` record of pending retries;
- version admission inside celld (fogd's ordering handles it);
- cancelling in-flight work;
- any per-occurrence journal.

Retries stay native: lossy, and capped at the next occurrence. Write that down as best effort, not as job-queue semantics.

**C (a fogd-owned scheduler):** reject it. Nothing in the source shows the native path failing a lifecycle requirement that only a second scheduler could meet.

## First implementation experiment

Rather than option D as a standalone milestone, run one probe through the ordinary approve flow, behind an internal admission flag like the M11a probe:

1. A Void fixture with jobs `ok` and `flaky` on `* * * * *` (flaky controlled by a toggle in D1), plus `nightly` on its own expression. Each run writes `(job, cron, scheduledTime, attempt, version, node, startedAt, finishedAt)` to D1 with a unique key on `(job, cron, scheduledTime)`; duplicate inserts are counted, not rejected.
2. Implement only the generalized bootstrap and admission of `triggers.crons`.
3. Measure on two replicas:
   - executions per occurrence;
   - a flaky failure re-running `ok`;
   - killing the owner in the middle of a handler;
   - an unreachable owner replica;
   - 3 minutes of fleet downtime, counting catch-up runs;
   - an update that changes the expression while an alarm is overdue;
   - a stopped-snapshot restore with an old alarm;
   - `compose up` against a stopped fleet;
   - whether the schedule was armed when one node lacked authority.

The results decide whether to switch to B (criteria a–d) and fill the documented-semantics table.

## Acceptance gates

1. A pending, rejected or unapproved upload never produces a scheduled run. On first activation, the first run is strictly after the migration ledger matches the release; verified by comparing D1 row timestamps with controller step times.
2. Each occurrence runs at most once across replicas when no failure is injected. Owner kill and unreachable-owner behavior is measured and documented. Any duplicate counts as a celld bug, not something to accept.
3. A retry re-runs sibling jobs on the same expression, and the fixture's per-job keys prevent duplicate business records.
4. Downtime and restore catch-up is measured as "≤1 run with the original scheduledTime, intermediate occurrences skipped" and shown in the UI and docs. A schedule change that drops an overdue tick is documented.
5. During an update, any old-version run after migration shows up in the run log with its version, and the fixture's schema change is expand/contract-safe.
6. Stopped fleets stay stopped through a daemon restart, `compose up` and a fogd controller restart. Restore, expansion and retirement require an explicit acknowledgment that names the pending overdue tick.
7. Failed activations correctly show whether scheduled jobs are running and on which version. "Last success" and "last failure" come from the app; the platform shows "armed / not observed" or says it cannot tell.
8. `/__void/scheduled` returns 404 publicly, including encoded variants. fogd never calls it. Run records contain no secrets.
9. `workflows`, other trigger types, and general rules for Durable Object alarms remain rejected or explicitly out of scope, recorded as open M11 items.

The biggest risk is calling A's stop control a "pause". As long as stopping isn't durable (item 5) and booting fires the stale tick (item 4), the operator promise has to be "stop the app", and the restore flow has to warn before the tick runs.
