**No blockers.** I read the source itself, not your summary: `queue-activation.mjs`, `activation.mjs`, the diffs to `controller.mjs`, `retirement.mjs`, `backend.mjs` and `resources.mjs`, plus `delivery.mjs` and the new tests. I didn't run any test suites.

## The fixes I checked

- **Capability marker (old item 4):** `requireQueueCapability` now runs when a release is submitted (`controller.mjs:107`). It runs again in `prepareActivation` before the first save, and `step('approved')` comes after that. On startup, `validateQueueState` refuses state that has queue declarations but no marker. An older controller already rejects unknown requirements.
- **Startup isolation (old item 1):** a backend failure in `recoverQueueHolds` is caught for that app only. The route goes to paused, the observation is reset to unknown, the pending pause and its diagnostic are kept, and the loop moves on to other apps. A metadata write failure still sets the storage latch and stops startup for everything, because `assertStorage()` runs first in the catch.
  - Recovery only ever calls `reconcile()`. With a hold in place that can only pause, so it never resumes and never migrates.
  - On retry, `prepareQueue` pauses again before touching the ledger, and only then clears the diagnostic.
- **Bootstrap guard against mismatched restores:** a new bootstrap journal is created only when there is no active pointer and `hasDeployment` is false. A refusal leaves the request failed and the route paused, with no runtime effect. The test covers this.
- **Hold owner check:** it now requires a deployment of the same app with status `failed` or `activating`. I couldn't find a code path that moves a hold owner into another status:
  - reject is refused while a hold exists;
  - `finish()` only marks other deployments superseded after the hold is released;
  - retirement is refused.

  Validation runs before the interrupt rewrite, so `activating` has to be allowed, and it is.
- **Retirement:** refused for any app with queue resources or a delivery journal, checked before anything else.
- **Bootstrap temp files:** these now go under `os.tmpdir()`. Only `compatibility_date` is read from the artifact, so no secret values are written there. A temp directory left behind by a SIGKILL no longer counts against the artifact quota.

## Remaining limits

1. **Startup still waits on recovery.** Listeners don't start until every held app has been through recovery: up to 180s of `ready()` per node, plus a pause timeout. It's bounded and no longer restart-loops, but several held apps add up.
2. **A missing slot still blocks every app.** `Queue fleet is missing` at `queue-activation.mjs:53` is thrown outside the per-app catch, so a held app whose slot is gone from config stops startup for all apps. That is a config or metadata mismatch, so it's arguably correct, but it isn't isolated.
3. **The recovery diagnostic is only in `state.json`.** Nothing in the API or admin view returns `deliveryRecoveryError`. An operator has to read the state file or notice the route is paused.
4. **A bootstrap at `phase: 'pending'` is not fenced.** If one is restored from a stale backup while the bucket holds a newer consumer, a retry can still republish the bootstrap over it. You've documented this and don't claim it is closed.
5. **Old items 3 and 6 are still open.** That's the stuck permanent hold whose pending submissions count toward the global `maxPending`, and the unconstrained bootstrap declarations (producers, D1, `compatibility_date`). Both are listed in `docs/queue-activation.md` as gates to clear before admission opens.
6. **The diagnostic-clearing test is incomplete.** "Failed startup pause retains intent" checks that the pause is confirmed after a restart, but never approves a retry to show `deliveryRecoveryError` is then cleared. The code does clear it.
7. **Minor:** the body of `validateAppQueue` is indented four spaces; the rest of the file uses two.

The Docker probe on the final image is still pending, and so is whether celld can pause the queue during the bootstrap phase on that image.
