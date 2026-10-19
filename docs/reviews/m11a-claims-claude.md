# Claude review: recoverable ownership claims

No blocking safety bugs. Every crash window I traced fails closed, and the backward-compatibility story holds for any controller from the retirement release (m10b) on. I found one operational gap you should decide on before the producer bootstrap integration, plus a few smaller notes and missing test cases. The claims and platform test files pass (36/36); nothing was edited.

## Write ordering (verified)
- **Reserve before claim:** `prepareActivation` saves the reservation (deployment ID, digest, prefix) before calling `backend.claim`. The "intent" test confirms no bucket owner exists when that save fails.
- **Confirm before publish:** after the claim succeeds, `delete app.claim; await this.save()` runs before `reconcile` and `activate`. The "confirmation" test confirms nothing is published when that save fails.
- **Restart:** the interrupted request becomes `failed` before `inspectOwnership`, and `claimApproval` accepts `failed` with step `preparing-activation`. The approval and digest are re-checked with nothing claimed automatically.
- **Retry:** an absent owner is claimed after the `deploy/` check. A matching owner gets only the `deploy/` check (`unpublished: true`). A foreign owner throws `Slot owner mismatch`.
- **Lost claim response:** the reservation is kept, reject and replacement are refused, and retry after restart activates. Tested.
- **Secret revision:** a retry cannot change it, because `secrets.select` keeps the revision pinned. So `privateConfiguration === Boolean(secretRevision)` cannot drift into a false quarantine.
- **Retirement:** it needs an active app, so a pending reservation can't be retired around.
- **Legacy missing metadata:** still quarantines (`platform.test.mjs:98`). An old-format crash that leaves an owner with no record still goes through `observeOwner` and gets quarantined.

## Findings

1. **Medium (operability): a reservation can never be released.** `controller.mjs:145` refuses reject while `app.claim` exists, even when the bucket has no owner and no external effect ever happened. A quarantined reservation (lost artifact, changed prefix, etc.) also holds its slot until someone hand-edits `state.json`. Before this change, a request whose first claim failed could simply be rejected. A safe release:
   - Inside `exclusive`, if `backend.owner(slot)` is null, delete the reservation and reject in the same save.
   - If an owner exists, keep refusing.

   If you'd rather not, the quarantine and reject messages should at least name the manual recovery step.

2. **Low: published fleets aren't quarantined at startup.** A pending claim on a slot with a matching owner and existing `deploy/` objects passes startup. It then fails on every retry with "Unresolved ownership claim contains a deployment" and is never quarantined. That is fail-closed, but it is a different operator signal from the other proof mismatches. It only counts as an overclaim if the docs say "all mismatches quarantine."

3. **Low (rollback): the capability is never removed.** `reserveClaim` adds `fogd-claim-intent-v1` to `requirements`, and nothing removes it once the claim resolves. After the first new app is activated, the installation can never roll back to a retirement-aware controller from before claims, even with no claim pending. Removing it in the same save as `delete app.claim` (when no other app has a claim) is safe, since both changes land together. If keeping it is intentional, document it.

4. **Low: wording.** "So older controllers fail closed" is only true for controllers from m10b on, which check `requirements`. Older ones ignore the capability. Their old `verifyOwner` still quarantines an app with no owner, and adopts one with a matching owner without the `deploy/` check. That is acceptable but not "fail closed." Also, `validateRetirementState` now gates a capability that has nothing to do with retirement, so consider renaming it (e.g. `validateStateRequirements`).

5. **Low (behavior change):** a reserved but unclaimed app now appears in `route()` as `paused` with a slot (previously `unknown`) and in the capacity report's assignments. That's probably what you want, but it isn't tested or documented.

6. **Coupling (minor):** `claims.mjs` reaches into controller internals (`occupied`, `bucketOwners`, `slots`, `artifact`, `state`). That's fine for one caller. Just note it if the producer bootstrap also needs `inspectOwnership`.

## Test gaps
`pending ownership recovery requires matching approval…` covers prefix, status, secretRevision, resources, artifact bytes and foreign owner. It doesn't cover these checks, each a one-line mutation in the same loop:
- `claim.digest` or `claim.deployment` altered, or pointing at another valid request
- `requirements` missing `fogd-claim-intent-v1` (a legacy record that has a claim)
- `app.active` set, `migrations` non-empty, or `uncertain` set
- `request.step` set to something other than `preparing-activation`
- `request.app` mismatch

Also missing:
- A controller-level test of retry after restart with a matching owner and `deploy/` objects present. The refusal is only tested in the backend unit test.
- A test that a reservation blocks another app from taking its slot (`available('other')`).

## Scope
Queue admission is untouched. Coverage is limited to fake S3 calls and fault injection on real files. There's no real process kill, so atomic rename/fsync under a real crash isn't exercised. There's no live S3 test either, so `IfNoneMatch` behavior and how ListObjects reflects a just-written object (relevant to the `deploy/` guard) aren't confirmed.
