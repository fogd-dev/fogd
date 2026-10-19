The design holds up. The one key safety property is real: `deliveryFor`'s persist callback saves the whole `state.json`, and `saveJson` writes it atomically (temp file, fsync, rename, then directory fsync). So the new hold owner and the candidate's approval metadata always land on disk together, before the pause command. I found no unsafe window in the transfer itself. The draft in your working tree (`queue-replacement.mjs` plus the `mutate` diff) mostly matches the design. Below are the holes and simplifications, most important first.

## Unsafe or lossy boundaries

1. **Preflight overwrites the original failure step.** `queue-replacement.mjs:26` writes `previous.step = 'replacement-preparation:…'` and saves it. A failed preflight then leaves the held request showing the preflight step next to the error from the original failure. The recorded step is exactly the evidence the error text tells operators to check ("Check the recorded step"). You only need the saves to persist `queue-bootstrap-intent` and the bootstrap phase, so use `step = () => controller.save()`. If you want progress visible, put it in a separate field. This also covers your "record replacement preparation" item without losing anything.

2. **Nothing stops a stray `activating` record from taking the hold at startup.** `controller.mjs:54` calls `interruptQueueActivation`, which sets `hold = request.id` for any `activating` request, whoever owns the hold. In `transfer()`, the candidate is set to `activating` (with its pinned revision and `replaces`) in memory before `hold()` runs. If `hold()` throws before its first `#save`:
   - the catch at line 35 sees `hold !== request.id`, does no rollback, and rethrows;
   - the next unrelated save persists a candidate that is `activating` but doesn't own the hold;
   - the next restart hands it the hold with no reconcile and no review.

   Under `exclusive` this is currently unreachable (the `replaces` mismatch and busy checks can't fire), but nothing enforces that. Two cheap fixes:
   - In `init`, refuse to start if an `activating` request's app has a hold owned by a different request. Holds are never taken over silently, so this check holds on every legitimate path.
   - In the catch, restore the candidate's `status`, `step`, `secretRevision` and `replaces` when `app.delivery.hold !== request.id`.

3. **Add a root-cause guard in `migrate()`.** `activation.mjs:15` unconditionally sets `app.uncertain = request.id`. Your design only keeps the original evidence because the preflight reconciles first. Add `if (app.uncertain && app.uncertain !== request.id) throw …` at the top of `migrate`. Every path goes through that function, so a future caller that skips the preflight fails closed instead of erasing the evidence. That's one line, and it's better than relying on ordering.

4. **The pending-phase bootstrap in the preflight is unnecessary and uses a different input.** The preflight bootstraps from the raw `controller.artifact(previous.id)`, but the original attempt used the materialized execution directory. If the phase is still `pending`, migrations never ran (`migrate` comes after `prepareQueue`), so `app.uncertain` must be null and there is nothing to reconcile. Simpler: when the phase is `pending`, assert `!app.uncertain`, skip the preflight effects, and transfer. The candidate's own `prepareQueue` then bootstraps under its approval. That removes the path where the bootstrap is retried with the old artifact.

5. **The "partial SQL applied" case can't be proven by the stand-in.** `reconcileLedger` only sees ledger rows. If D1 can commit part of a migration file without writing its `d1_migrations` row, your rule that unapplied SQL can change lets the corrected SQL run against a half-applied schema. Only the live D1 test can settle this. If D1 isn't atomic per migration, document that corrected migrations must tolerate a partial predecessor.

## Your questions

- **Gaps in preflight, transfer, catch and startup:** apart from items 1, 2 and 4, none found:
  - Before the transfer write, the held request still owns the hold and the candidate is `pending`.
  - After it, the candidate owns the hold and is either `activating` (restart marks it `failed`) or `failed`.
  - A storage failure in the persist callback trips the global latch. Restart then loads one of those two consistent snapshots.
  - Operator delivery controls go through `controller.exclusive` (`admin-delivery.mjs:64`), so they can't interleave with the preflight.
- **Old-controller compatibility:** no hole found.
  - `replaces` is stored on the deployment record, not in the delivery journal, so the journal's unknown-field check doesn't trip.
  - The HEAD controller retries the candidate through ordinary approve, and it rejects a `replaces` body it ignores because `assertQueueDecision` sees another hold owner. That fails safe.
  - After the transfer, both old and new controllers allow rejecting the original artifact, since it no longer owns the hold and `uncertain` is null. That's acceptable because its migrations have already been folded into `app.migrations`. State this deliberately in the doc.
- **Secret pinning:** the draft is right. `select` runs before any effect, so the revision is validated early. Nothing is pinned until the transfer write. A failed preflight leaves the candidate unpinned, so a retry must name the current revision, and a stale UI render gets rejected, which is what you want. Make sure the redacted preflight error never ends up in `previous.error` with details from a private request. Right now it is only thrown back to the caller, which is fine.
- **Explicit replacement vs implicit latest candidate:** explicit is safer. It binds both digests under `exclusive`, so a newer upload can't win a race, and old servers fail closed.

## Simplifications

- **Drop the repeat-repair acceptance (line 13).** After a transfer, ordinary approve already covers retrying the candidate. A repeat repair could just fail with "candidate X owns the hold; approve it", which is one fewer path to test.
- **Shrink the preflight.** The pending case is item 4. For `ready` and `application`, `prepareQueue(previous)` amounts to: check the bootstrap is ready, `delivery.reconcile()`, then `controller.reconcile()`. That is close to `recoverQueueHolds`' per-app body, so you could pull out a shared single-app helper instead of passing the old request through `prepareQueue`.
- **Update the docs.** `docs/queue-activation.md:67-72` and `:98` still say replacement is refused or pending.
