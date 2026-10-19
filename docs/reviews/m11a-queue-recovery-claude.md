# Claude review: queued installation recovery

I reviewed the working tree against your design, without editing anything. The CLI backup and restore halves (`queue-backup.mjs` and `queue-restore.mjs`) don't exist yet, so this covers the platform side only: `queue-snapshot.mjs`, `queue-recovery.mjs`, and the changed runtime, delivery, admin, controller and retirement paths. None of the new paths has tests yet.

## Blockers

**B1. Saved receipts break startup when the pin changes.** `validateRecoveryState` runs `validateSnapshot` on every stored `queueSnapshot` and `queueRecovery.prepared` (`queue-recovery.mjs:26-31`). That check requires `contract` to exactly equal today's `queueRetentionContract` and recomputes `expiresAt` from today's constants (`queue-snapshot.mjs:28-30`).
- The first celld bump or margin change makes every controller holding an acknowledged receipt refuse to start. That directly breaks your rule that startup always keeps the acknowledged receipt without reblocking.
- **Fix:** startup validation should check shape only, using the recorded contract. Compare against the pinned constant only when acting: snapshot creation, CLI backup, restore, and acknowledgement.

**B2. Snapshots are never cleaned up.** `queueSnapshot` is deleted only when the delivery journal is written. A successful backup leaves it in live state forever, and restore copies it into the new fleet. Combined with B1, that stale data is a startup failure waiting to happen.
- **Fix:** restore deletes `queueSnapshot` after copying it into `queueRecovery.prepared`. Either don't validate stray snapshots at startup, or drop them there.

**B3. The diagnosis gets overwritten, so the audit trail is lost.** `inspectRecovery` replaces `receipt.observation` and `receipt.diagnosis` on every startup and on acknowledgement (`queue-recovery.mjs:46`).
- If first boot sees expiry or a lower backlog, and a later check runs with the host clock corrected backwards (or after a celld restart), `diagnosis` is reset to `null` and the first post-restore observation is gone. That contradicts "preserves expiry diagnosis/audit".
- **Fix:** keep a write-once `firstObservation` and an append-only `diagnoses` list. Later checks may add entries but never clear them.

**B4. The runtime version check looks at the controller, not the replicas.** `QueueRuntime.snapshot` runs `this.run(slot, ['--version'])`, and `backend.run` spawns the controller's local `celld` binary (`backend.mjs:46-49`).
- The replicas actually enforce retention, and nothing checks their binary or image. `inspect(node)` checks the app version, not the runtime.
- The recorded `source` and `image` are therefore claims, not verified facts.
- **Fix:** either have the Docker backup CLI compare each replica container's image digest to `contract.image` and fail otherwise, or have each replica report its runtime version. Until one of those exists, don't record image identity as verified.

**B5. Must confirm in pinned celld 0.6.2 that in-flight messages count in the backlog.** The expiry bound is the oldest message timestamp plus the retention period.
- If a message held by a running handler is excluded from `backlogCount` and `oldestMessageTimestamp` (pause doesn't drain handlers), a handler failure puts an older message back. It then expires before `expiresAt`, and the count check misses it.
- `stored === backlogCount` doesn't settle this unless `stored` includes those messages.
- Also confirm that retention runs from the original enqueue time across retries and delays.
- **Fix:** cite the source line for each. If either answer is no, add an explicit observation of in-flight messages or refuse while handlers are running.

**B6. Must confirm that celld's queue pause survives a restart.** On restore, the replicas start before the controller re-pauses in `recoverQueueSnapshots`. If celld doesn't persist the pause, restored work runs before any check. That isn't expiry, but it is unacknowledged execution. This belongs in the private staged Docker qualification as an explicit assertion.

## Should fix

**S1. A failed approval doesn't invalidate the snapshot.** `mutate` → `prepareActivation` sets `route='paused'` and saves before any delivery write. A failure before `prepareQueue` (in `backend.claim`, reconcile, or the digest check) leaves the snapshot valid, because `matchingSnapshot` doesn't check `route` or for activating/failed requests. Then acknowledgement sets `route='active'`, which the source fleet never had.
- **Fix:** have `matchingSnapshot` require `app.route === 'active'`, or have `mutate` delete `queueSnapshot` up front.

**S2. Snapshot timing causes false refusals.** `at` is taken before the `--version`, `info` and `inspect` calls (`queue-recovery.mjs:15`). The HTTP route is still live, so on an empty queue a message enqueued during those calls fails the "future oldest" check.
- **Fix:** use the time before the calls for expiry (the conservative choice) and the time after them for the future-timestamp check.

**S3. The backup can run with almost no time left.** The only age check is `now < expiresAt`, so a snapshot with seconds remaining is accepted and the backup then runs past expiry.
- **Fix:** require a minimum remaining window at snapshot time (several minutes or more) and recheck age in the CLI once writers have stopped.

**S4. Some recovery failures leave the app stuck with no way out.** If the restored state is quarantined, uncertain, or mismatched, `snapshotTarget` throws inside `inspectRecovery`. The catch writes a generic diagnosis, and acknowledgement can then never succeed: it calls `snapshotTarget` again, and `assertQueueDecision` blocks every approval except reject.
- **Fix:** document the exit (re-restore, or retire the app), and record the actual cause instead of a generic message.

**S5. Errors on the startup path are discarded.** The catch in `recoverQueueSnapshots` drops the cause, so "approval differs" and "runtime down" look identical. Store an error code or message (redacted when `privateConfiguration` is set).

**S6. The admin page doesn't show recovery.** `deliveryHTML` never shows recovery status or diagnosis, and has no acknowledge button. An operator sees "resume" missing with no explanation. Show at least a status line; acknowledging through the API only is fine.

## Fine as written

- **Locking:** snapshot and acknowledge run under `controller.exclusive`.
- **Invalidation:** any delivery write deletes the snapshot, since all of them go through `deliveryFor().persist`.
- **Blocked actions:** `resumable` and `assertQueueDecision` block both resume and approval while a recovery is pending.
- **Ordinary pause:** it clears only `deliveryRecoveryError`, never the recovery diagnosis.
- **Downgrade:** the permanent requirement marker blocks old controllers.
- **Storage failure:** this goes through `assertStorage` everywhere I traced.
- **Clock skew across hosts:** celld and the controller share the restore host's clock, so expiry stays consistent. The 60s margin only needs to cover drift inside one host.

## Requirements for the CLI half (not written yet)

- Backup takes the snapshot IDs from this run, not whatever `queueSnapshot` happens to be stored.
- Backup refuses a pending `queueRecovery`.
- `assertQueueFreeRecovery` must learn about `fogd-queue-recovery-v1` without loosening the refusal for Kubernetes, expand and retire.
- Restore checks evidence age before loading any image.
- Restore removes `queueSnapshot` and sets the route to paused, saving through the existing helper with readback.

## Minimum tests

1. Unit tests for `validateQueueObservation` and `queueExpiry`: empty queue, mismatched counts, future oldest timestamp, boundary at `expiresAt - 1` and `expiresAt`.
2. Snapshot, then an observe or pause call deletes `queueSnapshot`. Snapshot, then a failed approval invalidates it (fixes S1).
3. Startup with a pending receipt and an injected expired clock: diagnosis is set, the route is paused, and resume and approval both refuse. Then acknowledge: the diagnosis is kept (fixes B3), the route becomes active, and the queue is still paused. Then resume succeeds.
4. Startup with an acknowledged receipt whose `contract` differs from the current pin still starts (fixes B1).
5. Acknowledge with a wrong ID, a missing `acceptPossibleLoss`, or a changed deployment/digest refuses with no state change.
6. Startup where the runtime is unavailable records a diagnosis, and acknowledging then refuses.
7. In the staged qualification: replicas on a different image refuse (fixes B4), the pause survives a celld restart (B6), and a message held by a running handler during the snapshot is accounted for (B5).
