# Claude review: queue resume primitive

I found no blockers for this as an internal primitive. Every failure path I traced throws before `resume`, and nothing calls it outside tests and the probe. The 5 unit tests pass and `.fogd/m11a-generation.log` ends in PASS.

## Fail-closed behavior (checked)

- **Name validation:** the regex requires the first character to be a letter, digit or `_`. A queue name can't be read as a CLI flag, and anything `celld`'s own name check rejects fails the command.
- **Missing approval:** an empty version throws before any call is made (tested).
- **Replica observations:** an unreachable node, a non-OK `/state`, or a missing `deployment` field (`/state` omits it when the node has no runtime) all fail through `Promise.all` and the `!state` check. An empty `slot.nodes` is rejected by `!replicas`.
- **Generation id:** `GenerationId` is a per-node `u64` counter starting at 1, so `Number.isSafeInteger` is safe. Comparing each node against its own `state.generation` is correct because the counters are local. The test fixture's 2/3 split models that.
- **Mid-swap cells:** the gate ignores `swapping`. A cell still mid-swap shows its old generation in the census, so it fails closed.
- **Lost responses:** a failed status, mutation or confirmation throws without retrying (tested). `pause` correctly has no version check, since pausing is always safe.
- **Output parsing:** `command()` parses the whole of stdout. A stray log line fails closed, which is fine.

## Should fix (not blocking at the one-queue scope)

1. **The gate never checks the named queue's cell, only "exactly one `__Queue:` cell"** (`queue-runtime.mjs:43,51`). The address is deterministic. `engine_api.rs:433,467,577` builds it from a hash of `cells:v1:queue:__Queue` and a keyed hash of the queue name, and `cell_name` returns the name unchanged (`logic/queue.rs:46`). I derived it with `node:crypto` and got `__Queue:d463c890…274b`, which exactly matches `.fogd/m11a-generation/cold-resumed.json`.
   - **Failure case:** the `imports` cell is evicted between `info` and `inspect` while another queue's cell is resident. The gate passes and resumes a queue it never checked.
   - Only the one-queue admission rule prevents this today. About 4 lines in `assertQueueGeneration` would close it independent of admission. Upstream treats these strings as permanent addresses, so tying the check to the scheme is low risk. Pass the expected address in and require that it's resident on exactly one node, with no other `__Queue:` cell.
2. **The probe overclaims.** The live run shows that an unapproved requested version is rejected and that resume works for resident and cold cells, all on generation 1 (both nodes were restarted, so the counter reset). It never puts a queue cell on a superseded generation, so "only on the current generation" is tested by unit tests only. Either reword the PASS line (`queue-generation.mjs:31`) and the evidence write-up, or add a deploy step that leaves a stale resident cell.
3. **Uncertain mutations aren't labeled.** A lost `resume` response leaves the state unknown, but the error that comes back is a generic `celld queue failed (...)` or a parse error. Before the future delivery-intent caller is written, add a distinct error (e.g. `cause: 'uncertain'`) so the caller can't treat a failed resume as "still paused".

## Nits

- `backend.mjs:9`: `this.queues` is wired up but nothing uses it, and `deployment()` has no test. That's acceptable for a primitive. Move the new import below `node:child_process` to match the existing import order.
- The confirmation is not independent: `confirm()` asks the same cell through the same operator route. It checks that the cell itself reports the new state, not that delivery actually happened. Say so in docs rather than calling it independent.
- A duplicate node name in `slot.nodes` (e.g. `['a','a']`) would pass with one replica observed twice. The validated fleet layout prevents this today.
- `queue-generation.mjs:4` imports `expect` from `guestbook-browser.mjs` just to poll. A small loop would avoid pulling in the browser helper.
- The "stale" test case `f.states[1].cells['__Queue:one'] = 3` is rejected by the count rule, not the generation rule. The `= 1` case is the real stale-generation test, so this one is mislabeled.

## Future work (out of scope here)

- **Check-then-act race:** a publish between `inspect` and `resume` invalidates the observation. The header comment admits this; the controller must hold its publication lock across the whole `resume` call.
- **Draining generations:** these are deliberately ignored (tested). The lifecycle design should still say where in-flight consumer leases from before the pause, on an old generation, are accounted for.
- **Admission:** I couldn't find an explicit queue rejection in `packages/runtime/src`. It is presumably an allowlist of binding types. Confirm a test pins that before the one-queue admission rule replaces it.
- **No re-check after resume:** the generation isn't checked again after `resume`. That's acceptable only while publication is serialized.
