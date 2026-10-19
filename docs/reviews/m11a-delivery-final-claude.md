# Claude follow-up: delivery journal

I found no blockers. All 11 tests pass in `delivery*.test.mjs`. The original blocker is fixed:

- The hold is cleared only in the final save, after the runtime confirms the change (`delivery.mjs:53`).
- `completeActivation` requires `confirmed` first (`:77`).
- A refusal or a lost response leaves the hold on disk. `reconcile` then pauses because the hold is in effect.

The integration test uses the real `QueueRuntime`. The rejection it matches comes from `assertReplicaVersion` ("Replica is not on the approved runtime version"), not from Delivery's own check, so it really tests a generation refusal.

## Resolved from the first review
- **#1 (hold dropped on refusal):** fixed by keeping the hold until the runtime confirms. Your approach is simpler than the `{verb, releasing}` record I suggested, and it is correct. The cost is a pause/resume blip when the after-effect case is reconciled.
- **#2 (confirmed state made up from the verb):** fixed. `#apply` checks `status.paused` against the verb, and a contradiction becomes `QUEUE_OUTCOME_UNKNOWN`.
- **#3 (repeated commands):** the live run shows real celld accepts both repeats. `pause` on an already paused queue succeeds (script line 16, right after `hold`), and `reconcile` re-sends `resume` to a running queue (line 32).
- **#4 (no way to tell if the hold is in effect):** fixed with the `effective` and `confirmed` getters.
- **#6:** fixed. The dependencies are private, `reconcile` is renamed, and `initialDelivery` checks for the activation before validating.

## Remaining issues (none blocking)
1. **A refused version is saved as `version`.** After `completeActivation('first','v2')` is refused, the journal on disk holds `version: 'v2', operation: 'resume'`, and the previously approved version is gone. It can't be used while the hold is in place, and every release path overwrites it. Still, `version` now means "last attempted", not "approved". This matters if readiness or audit code reads it. Either write it only in the confirmation save, or document what it means.
2. **Releasing an activation while the operator has paused still checks nothing.** When `desired` is paused, the verb is `pause`, so the version is saved and the hold cleared with no generation check (the old #5). The check only happens later, when the operator calls `resume()`. That is acceptable, but nothing documents that `completeActivation` under an operator pause does not validate the version.
3. **`observe()` doesn't validate what the runtime returns** (`:87`). `status.paused ? ... : 'running'` accepts any truthy value. `QueueRuntime.status` validates, so this only matters for other runtimes. It is inconsistent with `#apply`.
4. **The held activation SIGKILL test checks the calls, not the effect file** (`delivery-crash.test.mjs:46-62`). For `after-effect` it never checks that `runtime.json` shows `paused: false` before `reconcile`, or `paused: true` after it. The operator-resume test does check this (`:25`, `:31`). Adding the same two checks would make the "fsynced fake runtime" claim hold for the activation cases too.
5. **`validateDelivery` still lets unknown keys through.** The spread in `#apply` carries them into every save. This is cosmetic for now, but cheaper to fix while the format is still unreleased at `schema: 1`.

## Overclaim check
- **"Reloading does nothing":** true, and the tests show it. The consequence needs to be stated outright, though. After an `after-effect` crash, the queue can keep running indefinitely while the journal holds the hold, until someone calls `reconcile`. Meanwhile `effective` reads `paused`. Only `confirmed === false` reveals the gap. The controller must treat `effective` as intent, never as the observed state, and must run `reconcile` on startup. That belongs in the controller's task list, not here.
- **Live script:** it covers the journal against real celld, a lost response after a real confirmed resume, a reconstructed object, observe/reconcile, and activation release while the operator has paused. It does **not** cover two things against real celld: lost responses during activation release, and version refusal. Those are covered only by the in-process tests with the real `QueueRuntime` and faked commands. "Restart" here means a new object in the same process; the process restart is covered only by the SIGKILL fixtures. The log is a single PASS line, so the evidence is in the files saved under `.fogd/m11a-delivery-final/`, not in the log.
- **Takeover:** `hold(new, {replaces: old})` works while a release is still uncertain, because the hold still belongs to `old` and it re-applies a pause. That is correct. There is no test for takeover while `operation: 'resume'` is pending; test 6 covers only a clean takeover.

## Still out of scope (unchanged)
- Controller ownership and serialization
- Where the journal lives, plus a revision counter
- Bootstrap
- Authorization for `completeActivation`, `pause` and `resume`
- Readiness checks before `completeActivation`
- Who calls `reconcile` at startup
- Retirement
- Admission limited to one queue
- Hold-transfer policy

I made no edits.
