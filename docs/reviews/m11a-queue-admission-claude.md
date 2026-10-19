I found three blockers. The plan is sound overall, but as written it would let any holder of a scoped deploy credential break the operator's recovery tooling with an upload that is never approved, and the naming rule can't pass `receiveArtifact` as written. I read the code at 9acdd53 and changed no files.

## Blockers

**B1. One unapproved queued upload disables backup permanently, on Docker and on Kubernetes/expansion.**
- `Controller.submit` (`packages/platform/src/controller.mjs:112`) calls `requireQueueCapability` before approval, so a pending upload permanently adds `fogd-queue-activation-v1`. Deployment records are never deleted (the only `delete` is the submit-failure cleanup at line 115).
- On Docker, `queueBackupApps` (`packages/cli/src/recovery/queue-backup.mjs:14`) throws when nothing has been activated or when a queue declaration's app isn't activated or retired. This is the gap you found, and it's real.
- Your proposal misses a second consumer. `assertQueueFreeRecovery` (`packages/cli/src/recovery/queue-safety.mjs:16`) refuses on the marker alone. It is used by Kubernetes backup and restore and by `expand.mjs:15`.
- So once admission is public, one scoped upload to a Kubernetes or expansion installation shuts off those paths for good. The controller doesn't know which platform it runs on (nothing in `main.mjs` or `backend.mjs`), so it can't refuse there today.
- Approving a queued artifact on Kubernetes would also run activation that has never been qualified there.
- Minimal fix: queue submission and approval require a controller opt-in that only the Docker compose stack sets. Without it, refuse queues at `submit` before the marker is written. Use the same artifact-only rule in both recovery gates, or keep Kubernetes and expansion out of scope behind that opt-in.

**B2. The artifact-only predicate, grounded in current transitions.**
- `prepareActivation` sets `request.secretRevision` and `step = 'preparing-activation'`, and saves, before any backend effect (`controller.mjs:178–182`).
- Rejecting a pending request leaves `step` at `'submitted'` (line 161).
- `replaceQueueApproval` also sets `secretRevision` first (`queue-replacement.mjs:57`).
- So the inert test should not rely on status. A request is inert when all of these hold:
  - `status ∈ {pending, rejected}`
  - `step === 'submitted'`
  - `!Object.hasOwn(request, 'secretRevision')`
  - `!state.apps[request.app]`, or that app is already accounted for as activated or retired
  - a valid queue resource shape
- Everything else keeps refusing.
- One gap remains. A first queued approval can fail during the claim, and the operator then rejects it. `rejectUnclaimed` (`claims.mjs:63`) checks the reservation is pristine, calls `assertUnclaimed` and deletes the app record. The request ends `rejected` with `step: 'preparing-activation'` and `secretRevision`, so the strict predicate refuses it forever. That is an ordinary operator action, and it leaves the same unbounded refusal.
- Minimal fix: when `rejectUnclaimed` removes a reservation, persist evidence on the request (slot, prefix, time) in the same save. The predicate accepts that evidence, not the status.
- Failed or held activations still refuse. They are bounded because the operator can retry, and rejection is already blocked while a hold exists.

**B3. Prefixing every name breaks the canonical check.**
- `receiveArtifact` runs `translateConfig` again on the uploaded canonical config and requires it to match exactly (`manifest.mjs:37–39`). D1 and R2 survive this because their names are derived from `binding`, not from the name itself.
- A queue name derived from its own name would be prefixed twice (`imports-imports-…`).
- Rule: if `name.startsWith(app + '-')`, keep it; otherwise use `${app}-${name}`. Applying it twice gives the same result.
- Void dispatch still resolves: the result is either the exact logical name or a unique longest `-name` suffix (`dispatch.ts`). Also reject when two names derive to the same physical name. The one-queue scope makes that impossible anyway, but checking costs nothing.
- Put this in its own module, called from `translateConfig`, so `stageArtifact` and `receiveArtifact` share it.

## Fixed policy scope: right, with a few corrections

- **All four keys must be present and equal to `1`.** If a key is missing, celld applies its defaults: batch 10, timeout 5, retries 3 (`logic/queue.rs:30–32`). Void leaves keys out when they aren't configured (`plugin-worker-bindings.ts:282`). The error should name the keys to set.
- **Drop the "safe ranges" check.** With exact equality it is dead code. Check for integer `=== 1` and reject strings and booleans.
- **Reject options celld accepts but you haven't qualified:**
  - producer `delivery_delay` (`deploy.rs:1618`)
  - consumer `max_concurrency` and `dead_letter_queue` (`deploy.rs:1645`)
  - `script_name`
  - any key under `queues` other than `producers` and `consumers`
  - empty `queues: {}`, or empty arrays in an uploaded config
- **Names:** use `^[a-z0-9-]` plus your length bound. celld only checks a 255-byte cell scope (`logic/cell.rs:18`), so the bound is fogd's choice. I'd use 63 to match the app-name limit and, from memory, Cloudflare's queue-name limit; I didn't confirm that here. Not a blocker.

## resourceIdentity and approval: no changes needed

- Including `queues` only when present matches `resourceChanges`. `isDeepStrictEqual(undefined, undefined)` passes, so old records don't change.
- Queue removal, renaming, policy changes and adding a queue to an already deployed app are already refused.
- The UI already shows `resources`, so the approver sees the physical name.

## Required integrated proofs

The private probes bypassed admission and used unprefixed names:
- `controller-artifact.mjs:19` injects `config.queues` directly.
- `native.mjs` and `repair.mjs` call `translateConfig({ ...queues: undefined })`.
- The names were `imports` and `probe-jobs`.

So the existing evidence doesn't cover the derived-name dispatch path. Your list is the right acceptance bar. Add these:
1. An ordinary `fogd build` and `fogd deploy` of `examples/imports` that produces the derived name, with no bypass. Re-run activation, recovery and retirement acceptance on that artifact.
2. B1 and B2 regressions:
   - a pending-only queued upload, then a successful Docker backup;
   - a claim-failure rejection, then a successful backup;
   - a failed or held activation, then backup still refuses;
   - Kubernetes or expansion either refuses the queued submission or stays usable, depending on the opt-in you choose.
3. A test that `receiveArtifact` accepts its own canonical output, including the case where the name is already app-prefixed.
4. With `max_retries=1`, the second failed delivery is the last one (`exhausted(2,1)`), and there's no dead-letter queue. "Explicit retry" must therefore be an app-level re-enqueue that leaves no duplicate business rows, not a celld `redrive`.

## Future improvements (not blockers)

- Retiring or cleaning up a queued app that was never activated, and stuck behind a held failure.
- Wider policy values, dead-letter queues, multiple queues.
- Kubernetes queue recovery.

The retirement-complete probe (`scripts/queue-probe/retirement-complete.mjs`, untracked) is still running. Its result should be in before this acceptance slice is closed.