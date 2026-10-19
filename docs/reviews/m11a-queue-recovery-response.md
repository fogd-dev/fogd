# Queue recovery review response

The first Claude review covered the platform code while the CLI implementation was
still being written. The [original proposal](m11a-queue-recovery-brief.md) and
[review](m11a-queue-recovery-claude.md) remain unchanged.

## Resolved findings

- Historical receipts validate against their recorded retention contract at startup.
  Actions that depend on retention require the current pinned contract. An
  acknowledged receipt from an older runtime does not prevent startup.
- Restore deletes preparation evidence after copying it into a fresh pending
  recovery receipt. Every delivery operation invalidates preparation evidence.
- The first successful recovery observation is immutable. Recovery findings are
  retained cumulatively, including through later acknowledgment and clock correction.
- Docker backup checks actual container image identities and requires each replica
  to use the controller's exact image. The retention contract identifies the pinned
  celld base image and source used by `docker/runtime.Dockerfile`; it is a supported
  build contract, not remote attestation of arbitrary custom images. The controller
  additionally checks its celld version and each replica's approved app generation.
- Pinned celld `harness.js:6310–6321` includes leased rows in physical and backlog
  counts unless marked for purge; `_metrics` defaults to all retained rows.
  Retry paths at `6927` and `7275` change visibility/attempts without changing
  `enqueued_at`. Retention uses original enqueue time. Count discrepancies refuse.
- Snapshot evidence requires an active HTTP route. An approval that pauses the
  route before failing cannot leave usable snapshot evidence.
- Observation records both start and completion time. New arrivals during the
  read are valid; the expiry bound uses the earlier of start and oldest-message time.
- Backup rechecks age after stopping and after archiving/exporting images. There
  is no fixed promised backup-duration window; a slow operation may refuse its
  success manifest and leave the source stopped.
- Admin HTTP, CLI, and page expose pending recovery. Acknowledgment binds both
  active artifact and recovery ID, explicitly accepts possible loss, and leaves
  delivery paused. Version hashes remain private in inspection responses.

## Limits retained

A receipt with mismatched approval, unresolved ownership, or an incompatible runtime
cannot be acknowledged. Restore matching state and images; ordinary approval and
retirement are not escape hatches for uncertain recovered state. Runtime failures
use bounded diagnostics rather than copying process output that may contain private
configuration. Possible expiry remains an explicit reconciliation responsibility.

Kubernetes, expansion, and retirement continue to refuse queues. Public artifact
admission remains closed. The Docker qualification uses privately staged artifacts
and records that distinction. No handler drain or exactly once effects are claimed.


## Second review amendments

The second review identified startup timing and stale acknowledgment findings. Runtime
availability and metadata mismatch now use separate bounded, transient `checkError`
messages. Only possible-loss findings enter the retained audit. The final Docker
drill uses the exact printed all-services Compose start command; the earlier
replica-first proof remains separate evidence.

Acknowledgment binds a review hash over the first observation, latest observed
metrics, retained findings, and transient check error. It checks that hash both
before and after contacting the runtime. A newly available observation, changed
counts, or new finding persists and refuses acknowledgment until the operator
inspects the new review. A stale page cannot accept findings recorded by another
administrator. Query timestamps do not continually invalidate an otherwise unchanged
review.

Restore retains earlier acknowledged recovery receipts under `previous`. Backup
checks the output directory before pausing and prints the partial-pause consequence.
An older-than-prepared timestamp is also a possible-loss finding. New arrivals can
mask a lower count, so count comparison remains a diagnostic rather than a completion
proof. Authenticated preparation reuses the existing administrator session helper.


The simultaneous-start drill also exercised an unconfirmed startup pause. Pending
recovery may retry only that pause operation; other unconfirmed operations remain
blocked. A successful retry creates the first observation, changes the review hash,
and requires another inspection before acknowledgment. A dedicated test covers it.
A newer observation also changes the review hash even when its possible-loss category
was already recorded.
