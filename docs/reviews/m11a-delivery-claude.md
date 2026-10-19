# Claude review: delivery journal

I reviewed `delivery.mjs` and its test against `queue-runtime.mjs` and `store.mjs`. All 5 tests pass. The overall shape is right: the journal is written before any runtime call, a runtime failure leaves the outcome unknown, a failed save blocks the instance until it is reloaded from disk, and building it from saved state does nothing to the runtime. The module has one blocker and a few smaller issues.

## Blocker in this module

**1. `completeActivation` clears the hold on disk before the resume check runs (`delivery.mjs:65`, `:40-41`).**
- `#apply` saves `{hold: null, version, operation: 'resume'}` first, and only then calls `runtime.resume`.
- `QueueRuntime.resume` checks the runtime version and the queue cell's generation before it sends any command (`queue-runtime.mjs:38-42`). If that check fails (wrong version, old generation, a replica missing), nothing was changed. The hold is still gone for good.
- The result is a journal with no hold, `desired: running`, and a resume waiting. The next `retry()` resumes as soon as the check passes. Meanwhile any `hold(other)` can take ownership.
- This is the bad-migration case you care about: a refused activation should keep its hold.
- Simply keeping the hold until the resume is confirmed doesn't work either. A crash after the resume took effect would make `retry()` pause the queue again (the hold forces a pause).
- Suggested fix: record which activation is releasing the hold, e.g. `operation: {verb: 'resume', releasing: 'first'}`. When the error is a definite refusal (no `code`, so it was thrown before `#mutate`), restore the hold. On `QUEUE_OUTCOME_UNKNOWN`, leave the resume waiting as it does now. The same `{verb, releasing}` record would also serve a future hold-transfer policy.
- Missing test: a version mismatch during `completeActivation` should leave `hold === 'first'` on disk. That test would fail today.

## Other issues in this module

**2. The confirmed state is made up from the verb (`:42`).**
- `#apply` ignores what `runtime[verb]` returns and writes `observed` from the verb name, with its own timestamp.
- The real `QueueRuntime` does confirm before returning. Any other runtime (including the test fake, which never checks) is trusted blindly.
- Fix: write `observed` from the returned `status.paused`, and fail if it doesn't match the verb. That is one line.

**3. Retrying after a crash assumes the runtime commands are idempotent.**
- If the process dies after the command takes effect but before the confirmation is saved, `retry()` sends `queue pause` to a queue that is already paused (or resume to one already running).
- If the CLI treats that as an error, `#mutate` turns it into `QUEUE_OUTCOME_UNKNOWN` every time, and the journal never settles.
- Your file-backed fake should accept repeated commands only if real celld does. That needs checking against celld, not assuming.

**4. `hold` doesn't mean the queue is paused, and nothing exposes when it is.**
- After `hold()` fails, `hold` is set but the queue may still be running.
- After `observe()`, `observed` can read `paused` while `operation: 'pause'` is still waiting, because observe doesn't clear the operation.
- The migration gate needs "hold set, nothing waiting, and observed matches what should be in effect". Today the controller would have to copy line 35 to work that out.
- Suggest a small getter that returns the state that should be in effect and whether it is confirmed. Otherwise the pause-vs-resume rule will exist in two places.

**5. `completeActivation` can already be used as a hold release (`pause()` then `completeActivation(failed, v)`).**
- With `desired` paused, line 35 picks pause, so the hold is lifted without resuming.
- The cost: `version` records the bad build as approved, and there is a window with no hold where an operator `resume()` would start the queue on it. (`resume()` still checks the version, so the risk is a bad migration paired with a matching version.)
- Until a real hold-transfer policy exists, write down that this path is not allowed, or check for it in the controller.

**6. Smaller items**
- The test fake reports `observed: paused` without confirming anything, and no test drives `Delivery` against a `QueueRuntime` wired to fake `run`/`inspect`. Add one; it would have caught issue 1.
- `persist`, `runtime` and `slot` are public and can be reassigned (`:17`). Test 5 depends on swapping `d.persist`. Private fields would remove a way to bypass the save-before-act rule.
- `validateDelivery` runs before the `!activation` check in `initialDelivery`, so the "requires an activation hold" error can't be reached for null input. Unknown extra keys also get copied forward by the spread.
- The name `retry()` is misleading: with nothing waiting, it re-applies the current state. That's fine, but "reconcile" would describe it better.

## Crash and kill tests

- Inject the kill at a deterministic point: a persist or runtime wrapper calls `process.kill(process.pid, 'SIGKILL')` on its Nth call. Don't rely on timing.
- The fake runtime should write each effect to its own file and fsync it before returning. Otherwise the "after effect" kill point proves nothing.
- Expected results, assuming issue 1 is fixed:
  - **Before the effect:** the journal shows the operation waiting and the runtime is unchanged. Reloading has no effect; `retry` completes it.
  - **After the effect:** the journal shows it waiting and the runtime has changed. `retry` sends the command again, which depends on issue 3.
  - **After confirmation:** clean, nothing waiting.
- Add one more kill point inside `observe` between its two saves; it should come back as `unknown`.
- Add a case for a refused `completeActivation`; the hold should still be there after reload.
- SIGKILL tests prove the atomic rename in `saveJson` holds up. They don't prove the fsyncs survive power loss. Leftover `*.tmp` files are expected and harmless as long as reload ignores them.

## Still needed outside this module

- **Controller ownership.** One `Delivery` instance per journal, and publication serialized across calls. `#busy` only covers a single object.
- **Where the journal lives.** If it goes into the controller's `state.json`, two writers saving the whole file will overwrite each other. Use its own file, or one combined save path. Adding a `revision` counter now, while `schema: 1` is unreleased, would cost little.
- **Bootstrap:** creating the first journal and the initial hold.
- **Authorization:** which roles may call `completeActivation`, `pause` and `resume`.
- **Readiness:** the migration and publication checks done before `completeActivation`, and the check from issue 4.
- **Recovery after restart:** who calls `observe` or `retry`, and when.
- **Retirement:** pausing, then taking down the journal.
- **Admission:** limiting the fleet to one consumed queue, which `assertQueueGeneration` assumes.
- **Hold-transfer policy** (not built yet). It should go through the same `{verb, releasing}` record from issue 1, not through `completeActivation`.

I made no edits.
