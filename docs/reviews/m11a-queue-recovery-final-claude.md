# Claude follow-up: complete queue recovery flow

# Second review: queued installation recovery

I read the full working diff, the four new modules, the tests, both drill scripts, `docs/queue-recovery.md`, and the recorded evidence. I edited nothing.

Overall: every first-review blocker (B1–B6) and S1–S3 and S6 is addressed in the code. Two new blockers remain, and both are in what happens after the restored controller starts.

## Blockers

**N1. Under the documented start command, the startup check races replica readiness, and a temporary failure is recorded as permanent.**
- Restore prints `docker compose ... up -d --pull never` (`restore.mjs:59`). The docs say to use it (`queue-recovery.md:39`). In `compose.yaml`, the controller only waits for `bucket-init`, so it starts alongside the replicas.
- `QueueRuntime.snapshot` calls `inspect(node)` on every replica (`queue-runtime.mjs:38`). If a replica isn't ready yet, `recoverQueueSnapshots` records "pause or approved generation could not be confirmed" (`queue-recovery.mjs:64`).
- `recordDiagnosis` keeps findings forever, so that boot-timing failure stays in the audit. It reads the same as a real approval mismatch.
- `firstObservation` is then not taken until the operator acknowledges.
- The drill started replicas first (`installation-recovery.mjs:17,23`). So the path that passed qualification is not the path the docs tell operators to run.
- **Fix:**
  - Keep runtime-unavailable as a transient field (`receipt.checkError`, replaced on each check) rather than adding it to `diagnoses`. Keep `diagnoses` for possible-loss findings only.
  - Use separate fixed messages for "approval differs" and "runtime unavailable".
  - Then either print and document replica-first startup, or have the drill use the exact printed command. The second qualifies what users will actually run.

**N2. Acknowledgment runs the check and accepts its result in one step.**
- `acknowledgeQueueRecovery` calls `inspectRecovery` and then marks the receipt acknowledged unconditionally (`queue-recovery.mjs:73-75`).
- Anything found for the first time during that call is accepted without the operator having seen it. That covers an expiry crossed while the receipt sat pending, a lower backlog, or the first successful observation after N1.
- The CLI and the page button both bind only the recovery ID, not the findings that were shown.
- **Fix:**
  - Copy `diagnoses` and `firstObservation` before calling `inspectRecovery`.
  - If the check adds a finding, or sets `firstObservation` for the first time, save and throw "Recovery findings changed; inspect status and acknowledge again".
  - A second call with no new findings goes through. About five lines, no new action needed.

## Should fix

- **S1. Restore drops earlier recovery history.** `queue-restore.mjs:24` replaces any acknowledged `queueRecovery` already in the archived state. If a fleet that was itself restored gets backed up and restored again, its earlier findings and first observation are lost. Fix: store the old receipt as `previous: state.apps[name].queueRecovery ?? null`. It can stay an opaque record that startup doesn't validate.
- **S2. A failed backup can leave delivery paused with no warning.** `prepareQueueBackup` pauses the queue before `mkdir(dir)` runs (`backup.mjs:24-25`). The most common failure, an existing directory, then leaves a running source with its queue paused and nothing printed. Fix: move `mkdir` above `prepareQueueBackup`. On any later failure, add "queue delivery remains operator-paused; resume explicitly" to the error.
- **S3. The smaller-backlog check misses some cases.** Messages that arrive between snapshot and stop can hide a handler finishing during shutdown. That's accepted, but the docs should say this check is not a completion detector. One cheap addition: a restored `oldestMessageTimestamp` older than the prepared one is impossible, so record it as a diagnosis.
- **S4. Duplicated auth code (nit).** `prepareSnapshotRequest` rebuilds the Basic auth header and CSRF fetch that `adminSession()` already does (`platform.mjs:163-168`). Reuse `adminSession`, or factor out its header builder.

## Verified as written

- **Restore refuses early.** It checks evidence before image load or any target change. That evidence must deep-equal the archived `controller.tar` and must not be expired. Missing or legacy evidence refuses, and so does any transformation (`queue-restore.mjs:12,18,20`).
- **Other paths still refuse queues.** Kubernetes backup and restore still go through `assertSnapshotQueueFree`, and expand and retire through `assertQueueFreeRecovery`.
- **Snapshot evidence is bound tightly.** Backup accepts only snapshot IDs from this run. It refuses a pending receipt and refuses mismatched controller and replica images. It rechecks age after stopping and again after `image save`. Every delivery write deletes `queueSnapshot`. `matchingSnapshot` requires active routing and a confirmed operator pause, so a failed approval can't leave usable evidence. Stale snapshots from older versions can't be used because the IDs must match.
- **Downgrade protection works.** The restored state carries `fogd-queue-recovery-v1`, so older controllers refuse to start. Older CLIs refuse queued bundles. Startup checks a historical acknowledged receipt only for shape and the contract it recorded.
- **Redaction:** `adminApp` drops `queueSnapshot` and trims `queueRecovery` to safe fields, and `deliveryView` shows only id, status, diagnosis and timestamps. Error messages are fixed strings. The drill evidence contains no version hash.
- **Serialization:** snapshot and acknowledge both run under `controller.exclusive`. A pending receipt blocks resume and every approval except reject. Pause and observe can't clear findings.
- **Restore write pattern:** restoring the volumes and then overwriting state isn't atomic. The `compose.pending.json` name and readback check make this the same accepted pattern as retirement.

## Minimum tests to add

1. **N2:** start cleanly, then move the clock past `expiresAt`. The first acknowledge refuses and records the expiry finding; the second succeeds.
2. **N1:** startup where `snapshot` throws once. Check that `diagnoses` stays empty, `checkError` is set, and acknowledge then refuses once (new first observation) before succeeding.
3. **CLI:** `queueBackupApps` refuses when an app has a pending `queueRecovery`. One assert in `queue-snapshot.test.mjs`.
4. **Platform:** `init()` refuses a pending receipt when the requirement is missing, and also when `delivery.desired === 'running'`.
5. **S1:** restoring a bundle that already has an acknowledged receipt keeps it under `previous`.
6. **Drill:** start the target with the exact command restore prints, or document replica-first startup as the supported order.

None of this opens public queue admission. The recorded drill is consistent with the claimed scope once the N1 startup order matches what the docs tell operators to run.
