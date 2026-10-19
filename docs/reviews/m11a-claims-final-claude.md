# Claude follow-up: recoverable ownership claims

## Review: m11a claims, follow-up

I found one remaining safety gap, in the new release path, plus a few overclaims to soften. Everything else in the change list checks out against the code. I made no edits, read no credentials and published nothing.

### What I checked and found correct
- **Release guard** (`claims.mjs:58-74`):
  - Release only happens when the reservation's deployment matches the request, and the configured slot and prefix match the pinned values.
  - The app must be pristine: `active`, `uncertain` and `migrations` all empty.
  - `assertUnclaimed` must confirm no owner and no `deploy/` objects.
  - The local delete and the `rejected` status go out in one `save()`. If that write fails, the latch trips, and both outcomes (write landed or not) are tested. The artifact is kept and no bucket objects are deleted.
  - If an owner exists, release is refused (tested by the lost-response test).
- **Reject comes before the quarantine check** in `mutate`, so a quarantined reservation (for example, a lost artifact) can now be released. That closes my earlier finding 1.
- **Startup publication check:** `hasDeployment` runs only when a claim is otherwise valid, and a positive result quarantines the app. Backend errors propagate out of `init()`, which matches what the old `owner()` calls already did, so availability is no worse than before. Earlier finding 2 is closed.
- **`assertClaimRequest`** blocks moving an approval to another app when `request.app` is edited.
- **New check on approve:** a reservation for another deployment blocks approval (`controller.mjs:154`).
- **`deploy/` is the right thing to probe:** `docs/compat.md:53` says publication's last step moves `deploy/current.json`. Publication needs an owner, and release needs no owner, so the two can't interleave without someone editing the bucket by hand.
- Test log: 128 tests pass. MinIO log: PASS.

### Remaining blocker (small; fix before calling release safe)
1. **Release doesn't check whether the same app name owns a different fleet.** `rejectUnclaimed` only checks the reserved slot. Take a reservation on slot-1 for `hello` while slot-2's `fogd-owner.json` also says `hello`. Startup quarantines that with "Multiple bucket slots…".
   - Reject deletes `apps.hello` and succeeds.
   - Until the next restart, `hello` has no record. A new `hello` submit then gets `available()` → slot-1 (slot-2 is in `occupied`), and its approval claims slot-1.
   - Result: two fleets owned by `hello`. After a restart, the live app is quarantined.

   Getting there takes a mismatched backup restore, but the fix is one line. Before deleting, refuse when `[...c.bucketOwners].some(([id, a]) => a === request.app && id !== slot.id)`, or refuse when the quarantine reason is anything other than a claim or artifact mismatch. Add one test for it.

### Low
2. **A claim PUT that lands late can follow a release.** If the SDK reports failure but the `PutObject` is applied server-side afterwards, release can pass `assertUnclaimed` and the owner object appears later. This fails closed (next restart: "no controller record"; a different app hitting that slot gets `Slot owner mismatch`), but the slot stays stuck until someone fixes it by hand. Mention it in the runbook; no code change needed.
3. **No test releases a quarantined reservation**, even though that is the operability case release was added for (artifact deleted or digest mutated, then reject succeeds). The existing release test uses a healthy reservation.
4. **Rolling back to a controller older than m10b and then forward quarantines a live app.** Those older controllers ignore `requirements`. If one activates the app, `app.claim` is left in place next to `active`. When the new controller starts, `claimApproval` fails `initialReservation`, so the working app is quarantined. That is consistent with "earlier controllers unsupported", but it should be stated in the release notes and not just implied by pinned images.
5. **The MinIO probe leaves residue.** It writes into the stack's real `FOGD_BUCKET` under `qualification/claims/<nonce>` and never cleans up. It also leaves `.claim-probe-*` in the controller container's writable layer (gone when the container is recreated). This is harmless unless a slot prefix ever starts with `qualification`; document it or stage under a separate bucket.

### Overclaims to soften
- **"SIGKILL fixtures using fsynced file backend":** SIGKILL proves crash ordering at intent, claimed and confirmed. It does not prove fsync durability, because the OS page cache survives a process kill. Power loss and torn writes are still untested. The kill fixtures also use `claim-backend.mjs`, not the real `Backend`, so the `deploy/` guard in those runs is fixture logic.
- **"Real S3 backend":**
  - It is real MinIO only, not whatever S3 provider production uses.
  - The `IfNoneMatch: '*'` → 412 branch (`backend.mjs:31`) is never run live: the second `claim` returns early after the owner GET, so a concurrent create is never tested.
  - A direct `PutObject` with `IfNoneMatch` on the existing owner key, expecting 412, would show whether the provider enforces it.
  - Read-after-write for ListObjects *is* demonstrated (publish, then the claim is rejected).
- **The MinIO probe runs the working-tree `backend.mjs`** (hashes recorded), not the built image. That is what its stated scope says, so it isn't wrong, but it doesn't qualify the shipped artifact.
- **No live full-controller approval drill:** you stated this yourself, and it means the end-to-end path isn't qualified. Release and startup quarantine have never run against a real fleet, only against fakes and the backend-only probe.

### Still open from the first review (not blockers)
- `validateRetirementState` still checks the claim capability as well; the name no longer fits.
- `route()` and capacity now show a reservation as `paused`, with its slot occupied. That is tested now but not documented.
