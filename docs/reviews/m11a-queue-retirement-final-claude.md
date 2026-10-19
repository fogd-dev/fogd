**Verdict:** I found no correctness blockers in the code paths. Two things should still be fixed before merge: the queue docs are stale, and the retired state is not validated until the target controller starts. All five blocking items from `.fogd/reviews/m11a-queue-retirement-claude.md` are addressed. I re-ran `queue-snapshot.test.mjs` and `queue-activation.test.mjs` and both pass. I have no live probe result, and the working tree changed while I was reviewing: `retire.mjs`, `queue-recovery.test.mjs` and two new probe scripts appeared.

## Prior blockers

1. **Single state write: fixed.**
   - `restoredQueueState` checks evidence against the untouched source, clones `change.state`, and applies receipts only to apps that aren't retired.
   - `restore.mjs` now writes state once, with `change.state` coming through `queueState`.
   - The source isn't mutated; the `structuredClone` covers it.
2. **Tombstones in `queueBackupApps`: fixed.**
   - The live, retired and accounted split is in place, and a tombstone's deployments are limited to retired, superseded or rejected.
   - The audit is validated here as well as at startup.
3. **Private-version redaction: fixed.**
   - `retirement.queue` is projected through an allowlist (`admin-view.mjs:17-21`).
   - The audit is attached in `retireState`, not in `evidence`, so `retirement.json` stays clean.
   - The new `queue-recovery.test.mjs:168` checks that the version is absent.
   - `retirement` itself is still a spread with only `queue` replaced. That's acceptable because the evidence fields are already public.
4. **Runtime capabilities before creation: fixed.**
   - `requireStateRuntime` derives what to probe from the final state and runs it before `compose create`.
   - It probes only what's required, so old queue-free images still restore.
5. **Startup validation: fixed.**
   - All five operational fields must be absent on a tombstone.
   - The audit and the capability are linked, and the `fogd-queue-activation-v1` marker is required.
   - `assertQueueFreeRecovery` was left unchanged, so expansion and Kubernetes still refuse; a test pins this.

## Should fix (none are live bugs)

- **The retired state isn't validated before Docker resources are created.**
  - `planRetirement` runs `validateRetirementState(state, slots)` on the *source* state, and `restoredQueueState` validates only the source evidence.
  - `validateRetiredQueue` first runs on `retireState`'s output when the target controller starts, after compose create and the volume restore.
  - The guards in `matchingSnapshot` currently guarantee it would pass. That only holds while those guards stay in place.
  - **Fix:** one line in `planRetirement`: validate the returned state against the new slots.
- **`validateRetiredQueue` skips the operational-field check for some tombstones** (`queue-retirement.mjs:21-22`). A tombstone with `delivery` but no `resources.queues` and no audit returns `false` before the check runs.
  - **Fix:** run the operational-field check for every tombstone, before the early return.
- **Delivery-only apps can't be retired at all.** An app with `delivery` but no `resources.queues` gets "requires --stop-queued-work"; passing the flag then gets "requires a queued app". That's safe but a dead end. If the state can't occur, give it one clear refusal message; if it can, decide what should happen.
- **Docs are stale.**
  - `docs/queue-recovery.md:5` still says retirement refuses queued installations.
  - `docs/retirement.md` doesn't mention `--stop-queued-work`, that pending work is abandoned in the old prefix, or that the target's snapshot age is checked only at plan time.

## Missing acceptance checks

**Unit tests:**
1. Retiring a non-queued target while queued survivors exist: no flag needed, the survivor gets a pending receipt, and `fogd-queue-retirement-v1` is not added.
2. `--stop-queued-work` on a non-queued target refuses. The code does this; nothing tests it.
3. Which capabilities get probed. `requireStateRuntime` isn't exported. Pull out a pure `requiredCapabilities(state, change)` and pin three cases:
   - a queue-free retirement probes only `retirement`
   - a restore with only a tombstone probes `queue-retirement`
   - survivors probe `queue-snapshot`
4. Downgrade: an image that has queue recovery but not queue retirement is refused before `compose create`.
5. A second deployment of the retired app in `pending` or `activating` makes `queueBackupApps` refuse. The existing `revived` case only covers the retired approval itself.
6. `planRetirement` rejects an invalid retired state. This depends on the fix above.

**Live probe (judging only from the scripts, not results):**
- Not covered: backing up a tombstone with zero live queued apps. The manifest should have no `queueRecovery`, and restoring that bundle should reach a running controller. `retirement-survivor.mjs` backs up with `replacement` and `survivor` both live.
- The old-prefix fingerprint is first taken *after* the target starts (`retirement-isolation.mjs`). Also take one from the source before `retire`, so you have before, after start, and after replacement traffic.
- Assert `retirement.queue.snapshot.backlogCount >= 1` in the admin view after retirement. It proves the pending `jobId` was snapshotted and then abandoned. Right now the script saves `jobId` but never asserts anything about it.

The parts you said are deliberate hold up: public queue admission stays closed (probe scripts only), and the full delivery, bootstrap and recovery history is kept in private state while the API returns only the allowlist summary.