# M11a design review — Claude

**Verdict: revise before probing.** The direction is right: use upstream pause, allow overlap with old handlers, and don't fork. But three of the proposal's premises don't match the pinned source, and each would change the lifecycle design. There is also a cheaper drain option than the proposal assumes. I made no file changes and ran no Docker commands.

## Blockers

**B1. You can't pause a queue on an empty fleet.**
- Upstream never accepts the command. A self-hosted node blocks in `wait_for_deployment_pointer` (`.upstream/celld/crates/celld/main.rs:3808`) until `deploy/current.json` exists. It loads the peer key and deployment only after that, so it isn't serving yet.
- `celld queue` reaches the queue through `operator_cell::live_nodes`, which fails with "needs a running fleet" when no node is live (`operator_cell.rs:195-240`).
- So acceptance step 1 ("prove this can happen on an otherwise empty fleet") will fail.
- The good news is you don't need it. A fresh fogd slot has:
  - an empty queue,
  - HTTP routing paused,
  - fleet nodes only on isolated `fleet-N` networks (`compose.yaml:60-87`),
  - no other producer that M11a admits.
- Nothing can enqueue before the first publish, so the safety comes from "empty and unreachable", not from a pause.
- **Amendment:** at first publish, run publish, then pause, then check `info` shows `stored == 0`, then migrate, mark ready, and resume. Write down the invariant that justifies this. Pause before publish only when the slot already has a deployment pointer (update, restore, re-activation). In those cases nodes are serving and pause works.

**B2. `ready()` doesn't prove which release will receive work after resume.**
- The consumer runs in the generation of the queue cell's isolate, not in whatever release the node's pointer currently names:
  - `op_queue_dispatch` tags the dispatch with `current_generation`.
  - `queue_service` resolves that tag through `generation_by_id`, which still returns old generations while they drain (`runtime.rs:1053`, `cell_runtime.rs:91`).
- `adopt()` says "Requests and cells already on it finish there." The old generation's isolates are freed only once their cells leave (`generation.rs:387-412`).
- fogd's `Backend.ready` checks `/reload` version and health (`backend.mjs:43`). A queue cell that's still resident in the old generation would pass that check. After resume it would deliver new messages to the **old** handler.
- **Amendment:** before resume, require evidence that no cell isolates of the old generation remain. The `/state` census on the node that owns the queue cell would show this. Make it probe question 2a.
  - If the census never empties while the cell is busy, that's the upstream gap to raise.
  - A paused, idle queue cell may get reaped; measure that rather than assume it.

**B3. The upstream defaults can silently lose work, which conflicts with U7.**
- Retention is a fixed 4 days (`logic/queue.rs:37`) and is enforced whether or not the queue is paused. A queue paused too long, or a backup restored after more than 4 days, loses messages when the sweep runs.
- Void emits no `dead_letter_queue` (`plugin-worker-bindings.ts:278-287`), and the default `max_retries` is 3. With no DLQ, an exhausted message is **deleted** (`harness.js` `_settle` / `_leaseBatch`).
- A lease that expires during a pause is reclaimed at resume and counts as an attempt.
- **Amendments:**
  - The app records terminal failure in D1 itself, based on `message.attempts`, before the last attempt runs out.
  - fogd shows `oldestMessageTimestamp` against the retention limit.
  - Restoring a backup older than retention requires the operator to explicitly acknowledge it.
  - Stopped backup requires every consumed queue to be paused, with `info` showing it, before stop. Otherwise the restored nodes start consuming as soon as they boot.

## Specific points

- **Drain.** The proposal says `info` gives no handler-drained receipt. That's true, but a receipt is cheap. `_rearm` already counts live leases (`COUNT(DISTINCT lease_id) … leased_until > ?`), and leases have an enforced bound: admission plus handler budget plus settle budget (`logic/queue.rs:137`).
  - **Preferred:** a small upstream patch adding `liveLeases` to `info`. Then the update order is pause, wait for `liveLeases == 0`, migrate. This removes the overlap of old handlers with the new schema altogether.
  - **Fallback with no patch:** wait one `leaseDurationMs` after the pause commits. Only use this if the probe shows queue handlers are actually killed at their handler budget. That's a deadline the runtime enforces, not a timing heuristic, but test it.
  - Note that a live lease is a conservative stand-in: a crashed handler holds its lease until expiry.
- **Uncertain resume is simpler than the proposal makes it.** `_setPaused` just sets the stored flag to a value, so repeating it is harmless. Persist the intended delivery state in the controller first, call the verb, and confirm with `info.paused`. `Reachable::call` doesn't retry on timeout, so fogd should retry. No extra uncertainty state is needed beyond intended versus observed.
- **Publish interruption.** In `deploy::write`, the queue attachment is written with a CAS before the pointers move. If fogd's 180 s SIGKILL lands between them:
  - Reload fails because the attachment names a different prefix from the one already loaded, so nodes keep serving the old generation, which is safe.
  - A node that **restarts** in this window fails `DeploymentGraph::load` and won't boot.
  - Running publish again fixes it. Add this to probe step 3, and make "republish" the recorded recovery for a failure during publishing.
- **Drop per-app physical names (YAGNI).** Each app is already its own celld fleet (`CELLD_BUCKET=s3://…/<slot.prefix>`), so queue cells are already isolated per app. Renaming queues would only lean on Void's suffix-match fallback for no benefit. Keep the logical names, and include them in approval display and resource history.
- **Narrow the admitted options to what Void actually emits:** producer `queue`/`binding`, and consumer `queue`, `max_batch_size`, `max_batch_timeout`, `max_retries`, `retry_delay`. Reject:
  - `dead_letter_queue`, `max_concurrency`, `delivery_delay`, `script_name`;
  - a release that stops consuming a queue it consumed before. Upstream would quietly set that attachment's consumer to `None` and strand the backlog (`publish_queue_attachments`).

  `compatible()` should enforce these.
- **Admin surface.** The source finding should also list `peek` and `purge`, which exist (`queue_cli.rs:61-66`). fogd should wrap only `info`, `pause` and `resume`. Leave `redrive` out, since it does nothing without a DLQ. `peek` exposes message payloads, so it's out.
- **Outbox design.** Insert the import row (`accepted`), then `send`. A row left `accepted` with no recorded send is what the explicit retry acts on. The consumer upserts by import ID, so a duplicate delivery or a re-send has no effect. Nothing more is needed for M11a.

## The concrete reversible probe

Use a throwaway two-replica fleet (copy `compose.local.yaml`, its own bucket prefix, runtime image pinned by digest) and a probe app with a single queue. The handler sleeps a configurable time and records `(message id, release version, attempts)` in D1.

1. **Empty fleet.** `celld queue pause q` should fail with "needs a running fleet". This records B1.
2. **First publish.** Deploy v1, check `info` shows `stored == 0`, pause, apply migrations, `POST /reload` on both nodes, resume.
3. **In-flight update.**
   - Enqueue N messages, with the handler holding about 20 s.
   - Pause, then poll `info` and `peek`, which shows the `leased` state and `leasedUntil`.
   - Deploy v2 with an additive migration, then reload.
   - Capture `GET :8081/state` on both nodes; watch the draining-generation cell census.
   - Resume, and record the version that handled each message (this answers B2).
   - Repeat with the handler running longer than the handler budget to find out whether queue handlers are killed at it.
4. **Kill points.** SIGKILL `celld deploy` between the attachment write and the pointer write. Restart one node; it should fail to boot. Republish; it should recover. Also kill during pause, migrate and resume, and confirm `info` alone is enough to reconstruct the state.
5. **Restore.** Pause, stop, snapshot the prefix, wipe, restore, start. Confirm `paused: true` and that the message count is unchanged. Repeat with the clock moved forward 5 days to make retention loss visible.
6. **Exhaustion.** A handler that always throws should delete the message after attempt 4 (B3). Confirm the app's own D1 failure row is written.

## Minimum useful scope

One queue, with the consumer in the same script, and only Void-emitted options. The lifecycle:

- **First publish:** publish, pause, check empty, migrate, wait for the queue cell to be on the new generation, resume.
- **Update:** pause, drain (`liveLeases == 0` with the patch, otherwise the lease-duration wait), migrate, publish, wait for the queue cell to be on the new generation, resume.
- **Backup:** pause every queue before a stopped backup.

Admin surface is `info`, `pause` and `resume`. If B2 can't be shown to hold, keep queues rejected and file that as the upstream issue. The rest of M11 can proceed independently.
