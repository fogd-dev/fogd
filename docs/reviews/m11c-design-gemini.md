# M11c Design Review: Native Void Scheduled Work (`triggers.crons`)

## 1. Executive Verdict

**Recommendation: Option B (with a strictly bounded, upstreamable `celld` cron control & retry-state patch), preceded by a targeted runtime qualification experiment (Option D as Step 1). Reject Option C. Treat Option A as an incomplete shortcut that violates `fogd`’s existing activation, failure-honesty, and restore contracts unless either patched into Option B or paired with invasive container-stop workarounds.**

### Is Option A an acceptable complete lifecycle or a misleading narrowed shortcut?
As stated, **Option A is a narrowed shortcut with silent operational traps**, not a complete lifecycleon par with M11a/M11b:
1. **Unreachable-replica & post-publish failure lie:** Once [`Backend.publish`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/backend.mjs#L53-L61) writes `deploy/current.json` via [`deploy::write`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/deploy.rs#L946), every healthy replica’s background pointer watcher ([`start_pointer_watcher`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L895-L979)) adopts the deployment within `CELLD_DEPLOY_POLL_S` (30s) and calls [`spawn_cron_arm`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L878) **even if `POST /reload` fails, replica 2 is unreachable, [`ready()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/backend.mjs#L118-L132) fails, or [`applicationReady()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/activation.mjs#L9) fails**. Meanwhile, [`activateRelease`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/activation.mjs#L56-L60) marks the request `failed`, leaves `app.route = 'paused'`, and [`deploymentStatus`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/deployment-status.mjs#L3) reports: *"Publishing failed. The application remains paused"*. Under Option A, HTTP is gated at the gateway ([`gateway.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/gateway.js#L13)), **but `.cron:<script>` is actively running new user code in the background on the healthy replica**.
2. **Restoring an old snapshot immediately fires a missed tick before operator review:** Standard recovery ([`docs/recovery.md`](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/recovery.md#L49)) starts the stack with `docker compose up -d`. When a restored replica boots, [`main.rs`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L4629-L4677) runs [`wake::due_scan`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/wake.rs#L43-L89) and [`spawn_cron_arm`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L784-L819) immediately on node startup. Because the snapshot’s stored alarm has `armed <= Date.now()`, [`CelldCronSchedule.fetch`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/harness.js#L5901-L5905) preserves the past alarm so it fires **once immediately upon container boot**—before the `fogd` controller can even inspect the restored state or wait for operator resume.
3. **Coarse fleet stop destroys co-hosted capabilities:** Stopping the entire app fleet to pause a maintenance timer kills HTTP serving, active M11b WebSockets/SSE, and `celld d1` inspection ([`operator_cell.rs`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/operator_cell.rs#L67-L74) requires live node leases).
4. **Upstream `CelldCronSchedule` in-memory `_owed` eviction bug (see §2.4):** Evicting `.cron` while a retry backoff alarm is armed in the same minute causes `celld` to re-run **all** matching expressions for that minute (including ones that already succeeded) with a **non-minute-aligned `controller.scheduledTime`**.

---

## 2. Source-Grounded Hard Blockers & Correctness Findings

### 2.1 First-Deploy Publish-Before-Migrate Race
In [`activateRelease`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/activation.mjs#L47-L50), non-queue first deployments run `publish()` **before** `migrate()`:
```js
if (!app.active) {
  await publish();
  await migrate();
}
```
This exists because `celld` replicas block at startup on [`fleet::wait_for_deployment_pointer`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L3808) until a deployment pointer exists in the bucket, and `celld d1 migrations apply` ([`Backend.migrate`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/backend.mjs#L98-L100)) requires live node leases via [`Reachable::open`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/operator_cell.rs#L67-L74).
* **Blocker:** If `publish()` publishes user code with `triggers.crons`, [`adopt_deployment`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L869-L878) immediately runs [`spawn_cron_arm`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L784-L819). Any minute boundary crossed while waiting for replicas, validating `/`, or applying D1 migrations executes `scheduled()` against an **unmigrated D1 schema**.
* **Fix (Required in both A and B):** Generalize [`Backend.bootstrapQueueInfrastructure`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/backend.mjs#L63-L74) into an app-free D1/resource bootstrap worker (`fetch() -> 503`, `d1_databases`, no `triggers`, no user code) before `migrate()` on first activation.

### 2.2 `.cron` Security & Operator Routing Gap in Upstream `celld`
In [`crates/logic/cron.rs`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/logic/cron.rs#L33-L43), the cron durable object class is `.cron` (`reserved_cell(script) = ".cron:<script>"`). However, [`deploy::RESERVED_CLASSES`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/deploy.rs#L89) only lists `[".d1", "__Queue", ".workflow"]`, and [`generation.rs`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/generation.rs#L357-L369) explicitly sidesteps adding `.cron` to `RESERVED_CLASSES`. That omission has two consequences in [`main.rs`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L2938-L3046):
1. **Unauthenticated `/do/.cron:<script>` exposure:** On the internal port, `/do/<cell>` ([`main.rs`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L3009-L3015)) blocks reserved classes via `reserved_class_of(&cell)` (which calls [`deploy::is_reserved_class`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/deploy.rs#L170-L172)). Because `.cron` is omitted, `/do/.cron:<script>` is **not** blocked on the internal listener.
2. **Authenticated `/runtime/.cron:<script>` rejection:** The authenticated operator endpoint `/runtime/<scope>` ([`main.rs`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L2948-L2954)) checks `if !celld::deploy::is_reserved_scope(&scope)` and returns `403 FORBIDDEN ("only a runtime class is served on /runtime/")`.
* **Crucial insight:** [`arm_cron_schedule`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L751-L778) does **not** use HTTP `/do/`; it invokes [`dispatch_do_call`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L761) in-process. Adding `celld_logic::cron::RESERVED_CLASS` to [`deploy::RESERVED_CLASSES`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/deploy.rs#L89) (and simplifying [`generation::reserved_classes`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/generation.rs#L361-L370)) simultaneously closes unauthenticated `/do/.cron:<script>` and enables [`Reachable::open`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/operator_cell.rs#L53-L87) to talk to `.cron:<script>` over authenticated `/runtime/`—the exact same transport used by `celld d1` and `celld queue`.

### 2.3 Eager Generation Adoption Moves `.cron` Before Readiness
In [`adopt_deployment`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L873-L878), whenever a node adopts a new generation (either via `POST /reload` or the 30s background [`start_pointer_watcher`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L895-L979)):
1. `state.actor_table.move_classes(&generation.reserved_classes(), &generation.version)` immediately moves `.cron` to the new generation version.
2. `spawn_cron_arm(&state, &generation)` immediately spawns an async loop that arms `.cron:<script>`.
3. Even if `spawn_cron_arm` were skipped, an already-armed `.cron` cell whose alarm fires at the next minute boundary resolves its script via the moved `actor_table` entry and calls [`selfScheduled`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/harness.js#L5938) on the **new** generation immediately.
* **Implication for Updates:** Unlike HTTP (where `fogd`’s gateway holds traffic or routes to the old target until readiness completes), native `.cron` switches to the new generation as soon as `deploy/current.json` is written. Furthermore, if an old generation’s `scheduled()` execution is still in-flight (or in `ctx.waitUntil`) on replica A when replica B adopts the new generation at a minute boundary, **old and new callbacks can overlap**. Thus, in **both** Option A and Option B, update migrations run *after* `publish()` ([`activation.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/activation.mjs#L50-L53)), or if moved before `publish()`, D1 schema changes **must be backward/forward-compatible** across the adjacent active and incoming releases.

### 2.4 Bug in Upstream `CelldCronSchedule` When Evicted During Retry
Compare [`CelldCronSchedule`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/harness.js#L5883-L5930) with [`celld_logic::cron::matches`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/logic/cron.rs#L426-L433):
* `this._owed = { at, indices, armedFor }` is stored only in JS heap memory ([`harness.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/harness.js#L5891)), while the retry deadline `plan.armAt` (e.g., `12:00:00.000 + 2000ms = 12:00:02.000`) is persisted via `this._state.storage.setAlarm(plan.armAt)` ([`harness.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/harness.js#L5978)).
* The comment at [`harness.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/harness.js#L5886-L5890) assumes that if the `.cron` actor is evicted (idle eviction, rebalance handoff, or node restart) before the retry alarm fires, `_owed` is `null` and *"without this record the wake matches no expression, runs nothing, and drops the failed tick in silence."*
* **What actually happens in source:** When the alarm fires at `info.scheduledTime = 12:00:02.000` on a fresh instance (`_owed === null`), [`alarm(info)`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/harness.js#L5920-L5922) sets `occurrence = info.scheduledTime` (`12:00:02.000`) and calls `__cron_plan(crons, 12:00:02.000, ...)`. Inside Rust, [`matches(cron, at_ms)`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/logic/cron.rs#L426-L427) computes `let minutes = at_ms.div_euclid(60_000)`!
  * If the retry backoff falls within the **same minute** (`12:00:02.000`), `div_euclid(60_000)` is the **same minute**, so `matches()` returns `true` for **all** expressions that matched `12:00:00.000`! It then re-runs **every** expression for that minute (even expressions that already succeeded on the first attempt) AND passes `controller.scheduledTime = 12:00:02.000` (violating the minute-boundary `scheduledTime` invariant at [`harness.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/harness.js#L5928) and breaking application idempotency keys that use `controller.scheduledTime` directly).
  * If the retry backoff crosses into the **next minute**, `matches()` evaluates the wrong minute (either dropping the retry or prematurely running the next minute’s schedule with a non-zero second offset).

### 2.5 Void Multi-Job Fan-Out & Idempotency Key Contract
In [`compile.ts`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/void/packages/void/src/router/compile.ts#L425-L463), Void compiles a single Worker `scheduled(controller, env, ctx)` handler that dispatches **all** `app/crons/*.ts` modules matching `controller.cron` concurrently via `Promise.all(tasks)` and throws `new AggregateError(errors, ...)` if any job fails.
* Because `CelldCronSchedule` tracks failure per cron **expression index** ([`harness.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/harness.js#L5947)), if two Void jobs share `"* * * * *"` and job B throws while job A succeeds, `CelldCronSchedule` retries the `"* * * * *"` expression, causing Void’s `scheduled()` router to re-invoke **both job A and job B**.
* Therefore, occurrence identity for deduplication/status recording must be keyed by **`(jobName, cron, Math.floor(scheduledTime / 60000) * 60000)`**, not by `cron` alone.

---

## 3. Comparison of Options (A, B, C, D)

| Lifecycle Dimension | Option A: Unpatched `celld` + App-Free Bootstrap + Fleet-Stop Pause | Option B: Minimal Upstreamable `celld` Cron Control + `fogd` Delivery Gate | Option C: `fogd`-Owned Scheduler + Bridge | Option D: Runtime Qualification Only |
| :--- | :--- | :--- | :--- | :--- |
| **Void DX & Portability** | Preserved (`export default defineCron`, `wrangler.json` `triggers.crons`). | Preserved (`export default defineCron`, `wrangler.json` `triggers.crons`). | **Degraded.** Void’s `/__void/scheduled` ([`compile.ts`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/void/packages/void/src/router/compile.ts#L482-L493)) stubs `noRetry() {}`; requires stripping `triggers.crons` or custom bundle wrapper. | N/A (no product admission). |
| **First Deploy & D1 Readiness** | Safe **only if** app-free D1 bootstrap runs before first user `publish()`. | Safe: app-free D1 bootstrap + `.cron` held paused in SQLite until `migrate()` & `applicationReady()` pass. | Safe (controller dispatches after `active`). | Verifies behavior only. |
| **Post-Publish Failure / Unreachable Replica** | **Unsafe / Misleading.** If `publish()` writes `deploy/current.json` and replica 2 fails `ready()`, replica 1 auto-arms `.cron` while `fogd` marks release `failed` and `route: paused`. Requires stopping fleet containers on failed publish to be honest. | **Safe & Honest.** `.cron` is persisted as `paused` (or fenced to `approvedVersion`) before `publish()`; unconfirmed/failed publish never runs new `scheduled()` code on healthy replicas. | Safe, at cost of split scheduler brain. | Does not solve. |
| **Operator Pause vs. Fleet Stop** | **Coarse Fleet Stop Only.** Cannot pause cron without stopping all app containers (kills HTTP, WebSockets, D1 CLI). | **Independent Cron Pause.** `celld cron pause/resume/info` pauses `.cron:<script>` while HTTP, WS, D1, and R2 stay live. | Independent pause in controller. | N/A |
| **Eviction / Owner Loss During Retry** | **Buggy.** `_owed` is RAM-only; eviction during retry either drops retry or re-runs all expressions with non-minute `scheduledTime`. | **Fixed.** Persisting `_owed` + `_retry` in `.cron` SQLite storage preserves exact retry target and `scheduledTime` across eviction/handoff. | Managed by `fogd` journal. | Exposes bug during probe. |
| **Stopped Backup / Restore of Old Snapshot** | **Unsafe with `docker compose up -d`.** Restored replica immediately fires overdue snapshot alarm at boot before operator resume. Requires rewriting `restore` to keep app replicas stopped. | **Safe.** `fogd` pauses cron during backup or holds `.cron` paused / fenced; even on raw crash snapshot, operator can hold/inspect before resuming to `next_across(now)`. | Safe if controller starts paused. | Does not solve. |
| **Retirement & Slot Reuse** | Requires stopping fleet + wiping `.cron` SQLite / `wake/entries` + slot-reuse guard. | `celld cron pause` + `retired` journal state + slot-reuse guard (mirrors [`queue-retirement.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/queue-retirement.mjs)). | Controller stops loop. | N/A |

### Can Option A Be Strengthened to Be Honest?
If you wanted to make Option A honest *without* touching `celld`, you would have to:
1. Add app-free D1 bootstrap before first user publication.
2. Treat any error after `Backend.publish` starts as a **tainted live publication**: if `ready()` or `applicationReady()` fails, `fogd` must either immediately `docker compose stop` the app’s replica containers or surface a distinct `background-unverified` state instead of claiming *"The application remains paused."*
3. Replace independent schedule pause with a full **app-fleet container stop** (`docker compose stop celld-1 celld-2`), which takes down HTTP, live WebSockets, and `celld d1` CLI access.
4. Change [`fogd restore`](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/recovery.md#L49) so restoring an archive with a scheduled app does **not** start replica containers until an explicit operator resume command is run—and even then, when replicas start, the first overdue tick from the old snapshot will still fire immediately on boot unless `fogd` first deploys a triggerless manifest to the bucket before starting the replicas!
5. Accept or work around the upstream `_owed` eviction bug in [`harness.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/harness.js#L5891).

**Conclusion on A vs. B:** Doing all of (2)–(4) in `fogd` is *more* complex, *more* invasive to recovery/operations, and delivers a *worse* product (no timer pause without killing the whole app, plus the `_owed` eviction bug) than making a small, surgical, upstreamable patch to `celld` under **Option B**. `fogd` already carries a small, well-documented `celld` patch pattern from M11b ([`docs/patches/celld-preaccept-attachment.md`](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/patches/celld-preaccept-attachment.md)); Option B is the clean architectural fit.

---

## 4. Minimal Native Primitive Boundary for Option B (Avoiding Overengineering)

Option B must **not** turn `.cron` into a durable job queue or workflow engine. Specifically:
* **Keep** upstream’s single-next-occurrence model: when a retry backoff `armAt` reaches or exceeds the next scheduled minute `next_across`, [`cron_rearm`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/logic/cron.rs#L597-L618) yields to the next occurrence and drops the remaining retry attempts.
* **Keep** upstream’s downtime semantics: after downtime, at most one overdue alarm is processed (or skipped on explicit `resume`), and the timer advances to `next_across(crons, Date.now())` without replaying every missed historical minute.

### Exact Minimal `celld` Patch Surface (~150–200 LOC total)
1. **Register `.cron` as a reserved runtime class ([`deploy.rs`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/deploy.rs#L89), [`generation.rs`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/generation.rs#L361-L370)):**
   * Add `celld_logic::cron::RESERVED_CLASS` to `RESERVED_CLASSES`. This blocks unauthenticated `/do/.cron:<script>` and allows [`Reachable::open`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/operator_cell.rs#L53-L87) to reach `/runtime/.cron:<script>` with operator bearer auth.
2. **Persist `_owed`, `_retry`, `paused`, and `approved_version` in `CelldCronSchedule` SQLite storage ([`harness.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/harness.js#L5877-L5982)):**
   * Store a single JSON control record in `this._state.storage.get("__cron_state")` / `put("__cron_state", ...)`:
     * `paused: boolean`
     * `approvedVersion: string | null` (optional generation fence: if set and `this._env.__version !== approvedVersion`, do not invoke `selfScheduled`)
     * `owed: { at: number, indices: number[], armedFor: number } | null`
     * `retry: number`
     * `lastRun: { scheduledTime: number, startedAt: number, finishedAt: number, ok: boolean, error?: string } | null`
   * **Why this fixes eviction:** If `.cron:<script>` is evicted or handed off while a retry alarm is armed, the waking instance loads `owed` and `retry` from SQLite, preserving `controller.scheduledTime = owed.at` and retrying only the failed `owed.indices`.
3. **Control routes on `CelldCronSchedule.fetch(request)` ([`harness.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/harness.js#L5897-L5906)) + `celld cron` CLI subcommand:**
   * Keep `POST http://celld/arm` for internal [`arm_cron_schedule`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/main.rs#L757): if `paused` is `true`, `/arm` does **not** arm or fire an alarm.
   * Add `POST /pause` (sets `paused = true`, clears `owed`/`retry`, calls `deleteAlarm()` so no overdue wake fires while paused or upon snapshot restore).
   * Add `POST /resume` (accepts optional `{ approvedVersion, skipOverdue: true }`, sets `paused = false`, computes `next_across(crons, Date.now())` and arms the future minute so resuming after a pause or snapshot restore **never** fires a stale historical tick).
   * Add `GET /info` (returns `{ script, crons, paused, approvedVersion, armedFor, owed, retry, lastRun }`).
   * Expose `celld cron info|pause|resume <script> [--json]` mirroring [`queue_cli.rs`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/queue_cli.rs#L1-L221).

### Exact `fogd` Platform Integration
1. **Artifact & Manifest Translation ([`artifact.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L118-L129), [`manifest.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/manifest.mjs#L76-L90)):**
   * Admit `triggers: { crons: [...] }`; validate every expression upfront (5-field syntax, non-empty array of strings) and preserve `triggers.crons` in `wrangler.json` for `celld deploy`. Keep `workflows` rejected.
   * Record `schedules: [{ cron }]` in the deployment plan and app state.
2. **Activation & Update Flow ([`activation.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/activation.mjs), [`backend.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/backend.mjs)):**
   * **First deploy of a scheduled app:**
     1. Publish app-free bootstrap worker (503 fetch, `d1_databases` + `queues.producers`, no `triggers`).
     2. Wait for replica readiness (`ready()`).
     3. Pause `.cron:<script>` via `celld cron pause <script>` (so the `.cron` SQLite cell exists with `paused: true`).
     4. Apply D1 migrations (`migrate()`).
     5. Publish real user bundle (`publish()`), wait for `ready()` and `applicationReady()`.
     6. Resume `.cron:<script>` (`celld cron resume <script> --version <approvedVersion>`) and record `schedule.state = 'active'` in `controller.json`.
   * **Update of an existing scheduled app:**
     * Document that update migrations and `scheduled()` handlers must use backward-compatible D1 changes, **or** pause `.cron:<script>` before `publish()`, run `migrate()`, verify `ready()` + `applicationReady()`, and `resume` `.cron:<script>`. (With Option B’s `pause`/`resume`, `fogd` can even gate the new version’s first cron tick until `migrate()` and `applicationReady()` succeed!)
3. **Recovery / Restore / Retirement:**
   * **Restore:** Even if a backup was taken while cron was active, `fogd` recovery verification (`fogd admin schedule info` / recovery gate) can require operator resume, or `fogd backup` can pause `.cron` before snapshot and `restore` can hold `.cron` paused until `fogd admin schedule resume <app>`.
   * **Retirement:** `fogd retire <app>` pauses `.cron:<script>`, stops the app stack, marks schedule delivery `retired`, and blocks same-name slot reuse (`409 Conflict`) until reset, matching [`queue-retirement.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/queue-retirement.mjs#L1-L40).

---

## 5. Recommended Sequence & Smallest Meaningful First Implementation Experiment

### Recommended Implementation Sequence
1. **Step 1 — Native Runtime & Eviction/Restore Qualification (Experiment below):** Run the live probe on the reference Void app’s compiled `scheduled` handler inside a real 2-replica `celld` cluster to prove normal ticks, `ctx.waitUntil`, multi-job fan-out, `noRetry()`, retry backoff, eviction during retry, and overdue snapshot wake.
2. **Step 2 — Minimal `celld` Cron Control & Durable `_owed` Patch:** Add `.cron` to `RESERVED_CLASSES`, persist `{ paused, approvedVersion, owed, retry, lastRun }` in `CelldCronSchedule`, and add `celld cron info|pause|resume`.
3. **Step 3 — `fogd` Admission, App-Free Bootstrap, & Schedule Delivery Controls:** Admit `triggers.crons` in [`artifact.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs), wire first-deploy bootstrap + cron pause/resume into [`activation.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/activation.mjs), and expose operator pause/resume/status in CLI/HTTP/admin UI.
4. **Step 4 — Reference Void App Periodic Maintenance Slice & Full Lifecycle Verification:** Add a real `app/crons/maintenance.ts` (`defineCron`) to the reference Void app that refreshes maintenance/status rows in D1 and exposes last scheduled success/failure, occurrence key, and freshness in the live app UI without an open browser.

### Smallest Meaningful First Implementation Experiment
Extend [`scripts/cron-native.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/scripts/cron-native.mjs) (against a disposable 2-replica `celld` stack) with three focused checks before writing platform admission code:
1. **Multi-Job Void Fan-Out & Partial Failure:** Compile two Void `defineCron` modules sharing `"* * * * *"`, where job A writes to D1 keyed by `(jobName, cron, scheduledTime)` and succeeds while job B fails once then succeeds on retry. Verify that job A is invoked twice by Void’s `scheduled()` dispatcher ([`compile.ts`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/void/packages/void/src/router/compile.ts#L457)) and that the D1 idempotency key prevents duplicate side effects.
2. **Eviction During Retry Reproduction:** Trigger a handler failure at minute $T$ (arming a +2s retry alarm), immediately force eviction/restart of the owning replica before the +2s alarm fires, and observe the waking `alarm(info)` behavior (`controller.scheduledTime` value and expression matching). Verify that persisting `_owed` and `_retry` in `this._state.storage` fixes both the `scheduledTime` drift and duplicate expression execution.
3. **Pause/Resume Over `/runtime/.cron:<script>`:** Verify that adding `.cron` to `RESERVED_CLASSES` allows `Reachable::open` to pause `.cron:<script>` before a minute boundary, hold across a container restart with an overdue alarm, and resume cleanly onto the next future minute without firing the stale tick.

---

## 6. Precise Acceptance Gates for M11c

1. **Gate 1 — Exact Approved Artifact & Portability:** A Void app using `defineCron` (`app/crons/*.ts`) and `triggers.crons` in `wrangler.jsonc` builds via `void build` and deploys through `fogd` without manual manifest edits or synthetic HTTP trigger routes. `workflows` remain explicitly rejected.
2. **Gate 2 — Schema & Secret Readiness Before First Tick:** On first deployment, D1 migrations and secret bindings are applied and verified before `.cron:<script>` is unpaused/armed; zero `scheduled()` invocations occur against an unmigrated schema or unapproved release.
3. **Gate 3 — Multi-Job Idempotency & `ctx.waitUntil`:** With two Void cron jobs sharing an expression and a simulated transient failure in one job, retry succeeds without duplicating D1 side effects in the sibling job, and `ctx.waitUntil` work completes and persists to D1.
4. **Gate 4 — Update & Post-Publish Failure Honesty:** Updating a live scheduled app does not run the new release’s `scheduled()` handler until migrations and readiness succeed; if `publish()` or replica readiness fails mid-activation, `.cron` remains paused/fenced to the previously approved release and operator status accurately reflects live timer state.
5. **Gate 5 — Independent Operator Pause & Resume:** `fogd` operator pause stops future `scheduled()` executions across minute boundaries and replica restarts while HTTP routes, D1 queries, and M11b live WebSocket/SSE connections remain active. Resuming schedules the next future minute without replaying paused historical minutes.
6. **Gate 6 — Retry Across Eviction & Replica Loss:** When a `scheduled()` invocation fails and the `.cron` owner replica is killed or evicted before the backoff alarm fires, the surviving replica recovers `_owed` from SQLite, retries only the failed expression with the original minute’s `controller.scheduledTime`, and honours `controller.noRetry()`.
7. **Gate 7 — Stopped Backup, Restore of Old Snapshot, & Recovery:** Restoring a stopped backup containing a past-due `.cron` alarm does **not** execute `scheduled()` automatically on container startup; scheduled execution remains held until explicit operator recovery acknowledgment/resume.
8. **Gate 8 — Retirement & Slot Reuse:** Retiring a scheduled app halts all timers, cleans up runtime containers, records `retired` state, and rejects same-name slot reuse until explicit operator reset.
9. **Gate 9 — Product Outcome Verification:** The deployed reference Void app performs periodic background maintenance/status refresh in D1 with **no open browser**, and a fresh browser session inspecting the app and `fogd` status sees up-to-date scheduled run timestamps, occurrence keys, and last success/failure state.

