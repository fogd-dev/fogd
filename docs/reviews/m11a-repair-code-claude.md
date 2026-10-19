I found no blockers. The core property holds: the candidate's approval (status, pinned secret revision, `replaces`) and the new delivery hold are saved together in one atomic `state.json` write, before the pause command runs. Both the persistence-failure test and the SIGKILL test show restart loading one of two consistent states, as stand-in proof only. All 74 tests in `queue-replacement.test.mjs` and `queue-activation.test.mjs` pass.

The test file grew while I was reviewing it. The HTTP/CLI, secret-pinning, failed-preflight and pre-bootstrap tests are now in it, and I included them. `scripts/queue-probe/*` and `scripts/queue-repair.mjs` also appeared mid-review; I didn't review them.

## Traced and sound
- **Order of checks before any runtime effect:** the replacement tuple is checked (`replacementFor`), then the candidate's artifact digest, resource compatibility and secret selection. After that the old artifact's digest is checked, then the preflight runs under the old approval. Only then does the candidate's own applied-SQL check run, against the newly reconciled `app.migrations`.
- **Every failure exit leaves one hold owner:**
  - Preflight throws: the candidate was never changed, the old request keeps the hold, and its step and error are untouched.
  - Transfer throws before the intent write: the candidate is restored in place.
  - Transfer throws after the intent write: the candidate owns the hold, is marked `failed`, and its error is redacted.
  - A metadata write fails: the storage latch throws first.
- **The `uncertain` pointer is either null or the hold owner.** The preflight reconciles before the transfer, the `migrate` guard backs that up, and `replacementFor` refuses when `uncertain` is a third deployment.
- **Resume can't be left committed.** If the old request failed at `releasing-delivery` after resume may have committed, the preflight's `hold(old)` re-establishes pause before any reconcile writes.
- **Your pending-phase bootstrap argument holds.** `resourceChanges` requires `d1` and `queues` to be identical, and `Backend.bootstrap` (`backend.mjs:63`) reads only `compatibility_date` from the artifact. The pre-bootstrap test pins this: two bootstraps, one publish.
- **Retries:** a retry with the matching tuple returns null from `replacementFor` and takes the ordinary path. A plain `approve` also works, because the candidate now owns the hold.

## Issues, most important first
1. **A failed transfer can leave the app permanently redacted** (`queue-replacement.mjs:301`). `transfer()` sets `app.privateConfiguration ||= Boolean(selected.revision)` (and `route`) before `hold()`. On a failure before the intent write, the catch restores the request but not `app`, so the next save persists `privateConfiguration: true`. From then on, every error for that app is redacted, even though no private approval ever took effect. It fails safe, but it contradicts "restores unpersisted candidate". Fix: snapshot and restore `app.privateConfiguration` in the same catch branch.
2. **Make the `uncertain` invariant a startup check.** If `uncertain` is ever set to something other than the hold owner, the app wedges:
   - retrying the hold owner hits the `migrate` guard, after it has already paused again;
   - replacement refuses in `replacementFor`;
   - any other approval is blocked by `assertQueueDecision`;
   - queue requests skip the pre-reconcile in `prepareActivation` (`controller.mjs:184`).

   I found no path that reaches this state today. But one line in `validateAppQueue`, `if (app.uncertain && app.uncertain !== app.delivery.hold) throw`, would catch it at load instead of mid-activation.
3. **A startup conflict blocks every app.** The new throw in `interruptQueueActivation` aborts `init` for the whole controller, and the message names neither the app nor the deployment. Failing closed is right, but at minimum include the IDs so an operator can find the record. Quarantining just that app would be the narrower option.
4. **Chained replacement leaves a dead button.** Take old request O, candidate C replacing O, then D replacing C. C keeps `replaces = O` and can never be approved again: same tuple gives "Held deployment/digest changed", D's tuple gives "Replacement predecessor changed". `approvalButtons` still renders "Approve replacement" for C, and it always returns 400. Hide the button when `request.replaces` is set and doesn't match the current hold, or document "resubmit".
5. **A lost response after full success isn't idempotent.** If the response is lost after the candidate went `active`, the retry gets "Deployment is not pending or retryable" and the CLI exits 1. The idempotence claim only covers the failure paths. That's acceptable if the docs say to check `fogd admin list`.

## Test gaps (stand-in level)
- The SIGKILL test's old request fails at publish with no migrations, so `uncertain` is already null. No crash test kills the process inside the preflight, between the reconcile save and the transfer write. Expected result: old still holds the hold, `uncertain` is null and `app.migrations` is extended. It's cheap to add to the fixture.
- No test rejects the old artifact after the transfer. This was the accepted behaviour from the plan review; pin it.
- No test covers finding 1 (pre-intent failure with a secret revision on a non-private app).

## Not covered by this proof
- **Partial migrations:** whether the D1 SQL is atomic per migration file is still your live INSERT-then-invalid-SQL probe. Until it passes, "unapplied SQL may change" is only safe under the stand-in.
- **Real runtime ordering:** the SIGKILL test proves the journal and state ordering against a persisted stand-in runtime, not celld pause semantics or how real D1 ledger reads behave while paused.
- **Admission:** public queue upload is still closed; nothing in this diff opens it.
