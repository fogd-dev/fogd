I found no remaining correctness blockers. The only material acceptance gap is the Docker regression run of the B1/B2 fixes, which you already said is in progress.

I ran the relevant suites without touching Docker: runtime queues, CLI queue-history, kubernetes and recovery, and platform claims, platform, queue-activation and queue-replacement. **148 of 148 pass.**

**B1 (queue admission gate): fixed.**
- `controller.mjs:101-105` now blocks only new admission. Rejection is always allowed, and so is a same-request retry of a `failed` request that already has `secretRevision`.
- Every path that sets `failed` after approval pins `secretRevision` first: `prepareActivation:187`, the interrupted-activation path at `:60`, and `activation.mjs:58`. So once a queue request holds a delivery hold, it can always be retried with queues off, and the hold can always be cleared.
- One request can be `failed` without `secretRevision`: a replacement that fails before it is pinned (`queue-replacement.mjs:45`). It is correctly treated as new admission. Its app still carries the queue lifecycle, so backup still accounts for it.

**B2 (inert history): fixed, and the unapproved transitions are covered.**
- I walked every way a never-approved queue request can change state:
  - **Pending, then rejected:** the request is still at `submitted` with no `secretRevision`, so it counts as inert.
  - **Pending, then superseded by a non-queue activation (`activation.mjs:26`):** inert.
  - **Pending while another request for the same app name is still activating** (submitted after that request reserved its claim, before it finished): app-absence is no longer required, so this is inert whether the other request finishes, fails and stays failed, or is released.
  - **Never approved, after its app is retired:** the inert-request check runs before the retired-status check in `queue-backup.mjs:16`, so it is inert.
- None of these adds a new permanent backup refusal.
- I also checked whether an orphaned queue capability marker could be left behind. A failed submission rolls back the in-memory request, and the capability marker is saved in the same atomic write as the request. If that write is ambiguous, the storage failsafe stops the controller. So you can't end up with the activation capability recorded and no queued deployment, which would refuse backup forever.
- Requests that were approved and then superseded keep `secretRevision`. They fall through to the claim-release check, which requires `rejected`, so they are never treated as inert. That's correct, and the app still carries the queue lifecycle in every reachable case.

**The released-claim extension: sound.**
- `rejectUnclaimed` writes the receipt only after these checks pass:
  - the claim's fleet configuration still matches;
  - the reservation is pristine (no `active`, no `uncertain`, no migrations);
  - no other fleet owns the app;
  - the backend confirms the slot is unclaimed.
- It writes the receipt in memory, then saves it together with the app deletion and the rejection.
- Nothing that touches queue resources can have run for that request. `prepareQueue` runs only after `backend.claim` succeeds and `app.claim` is deleted, and in that case `rejectUnclaimed` returns early without writing a receipt.
- A rejected request can't be changed again (`mutate` accepts only `pending` or `failed`). So a later approval under the same app name can't give it authority.
- The finish step's supersede loop leaves `rejected` requests alone, so the receipt-bearing request is never rewritten.
- `referencedApproval` still refuses any reference to the request, including from `queueSnapshot` and `queueRecovery`.
- Reusing the same name versus a different name doesn't change the risk of reusing the slot. That risk already existed before the extension.

The remaining open items are your own planned work:
- **Docker regression of the B1/B2 fixes:** the public probe ran on an image built before them, and the run on the current code hasn't finished yet.
- **Integrated acceptance:** update, recovery, retirement and browser acceptance still need to pass before the default can change from off.