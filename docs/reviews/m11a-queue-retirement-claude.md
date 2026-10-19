# Design review: queued Docker retirement and isolation

The design holds up. Most of the risk is in places where today's code already makes assumptions this slice breaks. Everything below comes from reading the code at 513efa9; I made no edits.

## Correctness gaps (blocking)

**1. `restoreInstallation` writes state twice, and the second write wins.** At `packages/cli/src/recovery/restore.mjs:46-48`, the code writes `queueState` and then `change.state` to the same `/data/state.json`. `plan.state` is built from a separate `snapshotState` read, so it has no survivor recovery receipts. On top of that, `restoredQueueState` short-circuits to `assertQueueFreeRecovery` whenever `change` is set (`queue-restore.mjs:12`).
- **Fix:** compute one final state in the plan:
  1. Check the evidence against the untouched source.
  2. Run `retireState`.
  3. Apply survivor receipts.
- Then in restore: `const state = change ? change.state : await restoredQueueState(...)`, followed by a single `writeRetirement(state)`. That also removes the `if (queueState)` / `if (change)` branch pair.
- **The order is forced, not a matter of taste.** `retireState → retirementApp` needs `matchingSnapshot` on the target, which requires `route:'active'` and `queueSnapshot` to be present. Applying the receipts sets `route:'paused'` and deletes `queueSnapshot`. Running retirement after the receipts fails. Running the evidence check after retirement throws "Queue inventory changed", because `queueBackupApps` no longer lists the target.
- So split `restoredQueueState` into `validateQueueEvidence(sourceState, manifest, now)` and `applyQueueRecovery(state, names, evidence, snapshotSha)`. Ordinary restore calls both; retire calls validate, then `retireState`, then apply with the target excluded.
- `restoredQueueState` currently mutates the object it reads. Once that object is shared, `structuredClone` it before transforming, or your "immutable source plan" test will catch the mutation late.

**2. `queueBackupApps` breaks on tombstones in both directions** (`queue-backup.mjs:9-10`):
- The `names` filter is `resources?.queues || delivery`. A tombstone keeps `resources.queues`, so it lands in `names`, and `snapshotTarget` then throws on `app.retirement`.
- If you exclude retired apps from `names`, the deployment check (`value.resources?.queues && !names.includes(value.app)`) refuses the tombstone's historical queued deployments, in any status: retired, superseded or rejected.
- `!names.length` throws, which blocks the zero-live case outright.
- **Rule:** `live` = queued apps that are not retired. `accounted` = `live` plus retired apps whose queue audit validates. Each queued deployment must belong to `accounted`. For tombstones, each such deployment must also be in a non-live status (not pending, failed, active or activating). Refuse only when `accounted` is empty.
- Validate the audit here, not only at controller startup. Otherwise a backup could carry a malformed tombstone that no current runtime will start.

**3. Admin inspection leaks private versions through `retirement`.** `adminApp` (`admin-view.mjs:17`) redacts top-level `delivery`, `queueBootstrap` and `queueSnapshot`, but copies `app.retirement` through unchanged. The nested audit would expose `delivery.version`, `queueSnapshot.version`, `queueRecovery.prepared.version` and the observations.
- **Fix:** use an allowlist projection, not a delete list. For example: `retirement.queue → { queue, snapshot: { id, at, backlogCount }, stopQueuedWork }`. A delete list will silently leak the next nested field someone adds.
- **Same risk in `retirement.json`.** Today `planRetirement` puts `evidence` into both state and that file. If the queue audit goes into `evidence`, the version hashes land on disk outside the controller volume. Keep the audit out of `evidence` and add it only in `retireState`.

**4. The runtime probe doesn't cover zero-live restore.** `requireQueueRecoveryRuntime` runs only when `queueState` is set, and `requireRetirementRuntime` only when `change` is set. An ordinary restore of a zero-live tombstone bundle probes nothing. It then creates target resources and refuses only at controller startup.
- **Fix:** derive the required capabilities from the final state:
  - retirement, if `change.kind === 'retirement'`
  - queue recovery, if any receipt is pending
  - queue retirement, if `requirements` includes it
- Probe them in one `docker run` that imports each constant, before `compose create`. This also replaces the two near-identical probe functions.
- Probe only what is required. Old queue-free images don't export the newer constants, and ordinary restore of those bundles must keep working.

**5. Startup validation must cover every live field, and the whitelists must move together.**
- **Fields that must be absent on a tombstone:** `delivery`, `queueBootstrap`, `queueSnapshot`, `queueRecovery`. Add `deliveryRecoveryError`, which your list omits.
- **Audit/capability link:** `retirement.queue` present requires the capability. A retired app with `resources.queues` but no `retirement.queue` must refuse. That catches a forged or capability-only tombstone.
- **Keep `fogd-queue-activation-v1`:** `validateQueueState` still sees `resources.queues` on the tombstone, so the marker must stay forever. That is also what keeps expansion and Kubernetes refused for any queue history, via `assertQueueFreeRecovery`. Good, but add a test that pins it.
- **Three whitelists to update:** `validateRetirementState` (platform), the list in `queueBackupApps`, and the list in `assertQueueFreeRecovery`. The last must stay without the new capability, so that expansion and Kubernetes refuse via the queue-activation-v1 marker.
- **Downgrade looks safe:** an older controller or CLI hits its own whitelist and refuses rather than guessing. Worth one negative test with an image that has queue recovery but not queue retirement.

## Smaller correctness points

- **Non-queued target, queued survivors.** As designed, this path also opens: `assertQueueFreeRecovery` in `retire.mjs:15` goes away. Add a unit case: no flag required, the survivor still gets its recovery receipt, and no queue-retirement capability is added unless there is an audit.
- **`--stop-queued-work` on a non-queued target.** Refuse it rather than ignore it, so a misread plan fails loudly.
- **Expiry window.** The plan checks evidence age before image load, which can take minutes. That is acceptable, because startup `inspectRecovery` re-diagnoses survivors. Document that only the target's age is gated once, at plan time.
- **Audit validation.** Reuse what already exists rather than writing new validators:
  - `validateSnapshot` for the receipt
  - `validateDelivery` for the journal (with `hold === null`, `operation === null`, `desired === 'paused'`)
  - `queueBootstrap.phase === 'application'`
  - the shape checks from `validateRecoveryState`, if an acknowledged recovery is retained

## Unnecessary complexity

- **Full delivery and bootstrap journals.** Admin consumes only the queue name, snapshot ID/time/count and the stop intention. A `queueBootstrap` at phase `application` carries no information. The delivery journal is mostly a version hash you then have to redact. Retaining `{ queue, snapshot: receipt, recovery: priorAcknowledged|null, stopQueuedWork: true }` is enough for the audit, and leaves fewer fields to validate and redact. If you keep the full journals deliberately, the redaction allowlist in point 3 becomes mandatory rather than nice to have.
- **No new helper module.** Merging the two probes (point 4) and splitting `restoredQueueState` (point 1) covers the factoring. A separate "CLI recovery helper" layer isn't needed.

## Qualification plan

The plan is good. Three additions:
- **Old target prefix:** fingerprint it before retirement, after the target starts, and after the replacement's live traffic. All three must match.
- **Second service:** the replacement on the same logical queue name must see an empty backlog on first `snapshot`, not just "no messages processed".
- **Backup after retirement:** zero-live tombstone backup must produce no `queueRecovery` in its manifest, and restore of it must reach a running controller. With a live replacement in place, the replacement must be the only entry in the manifest's `apps`.

Docs to update with the change: `docs/queue-recovery.md:3-4` and `docs/retirement.md:51-52` both still say retirement refuses queued installations.