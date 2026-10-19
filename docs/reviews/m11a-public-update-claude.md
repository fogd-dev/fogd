**Verdict: sound and good to land.** I found no false positive that matters and no functional bug. Every required property ends in a hard assertion, nothing waits out a race or retries until it passes, and a timing slip fails the run. The evidence in `.fogd/m11a-queue-public-update` is a pass: v1 held its job for 17s, approval took 374ms, the held row reads `processor: v1`, the pending row reads `processor: v2`, each job shows one attempt, and the queue ends empty.

**Why the core claims hold**
- **Order of operations.** `fogd admin approve` waits for activation to finish, and fails if activation fails (`packages/cli/src/platform.mjs:64`). Activation pauses the queue, applies the migration, publishes v2 and only then releases the hold (`activation.mjs:46-54`). So when line 48 sees the held job still `accepted`, the migration is already in. That means v1's insert without the new column really ran against the migrated schema.
- **v1 survived the switch.** If publishing v2 had killed the v1 handler, the message would come back to v2. That would show as `attempts` 2 and `processor` v2, which line 55 or 56 rejects.
- **Pending work wasn't taken early.** Pause runs before the pending job is posted, and line 55 requires that job's row to come from v2.
- **v2 is really active.** The resume at line 50 only succeeds if `active` is the update's ID and digest (`admin-delivery.mjs:7,42`).
- **Delay fits the handler budget.** The delay is the handler budget minus 3 seconds. The budget is limited to 15–30 seconds, which gives 12–27 seconds, inside the app's 30-second cap (`input.mjs:20`).
- **Fails honestly.** The time between v1 starting and v2 finishing the pending job is the only real race, and lines 48 and 52 fail on it rather than hiding it.

**Gaps (none of these break the current pass)**
1. **The script never checks that the migration is new.** `processor = 'v1'` on the held row comes from the column default, so it can't show *when* 0002 was applied. The script trusts that the active deployment is v1 and that 0002 hasn't run yet. If the stack were left in a strange state, for example 0002 already applied by an earlier failed approval while v1 is still active, the run would still pass without exercising "migration during approval". The admin state shows this directly. Assert 0002 is absent from `before.apps[app].migrations` and present after approval, or assert the update record lists 0002.
2. **The cleanup in `finally` (line 60) can hide the real error.** If the final pause throws, that error replaces the original assertion failure. Wrap it: `try { await cli([... 'pause']) } catch (e) { console.error(e) }`.
3. **The starting queue check is weaker than the ending one.** Line 25 checks `backlogCount`, but line 57 checks `stored`. Check `stored === 0` at the start too, so leftover in-flight messages can't sneak in.
4. **Line 49 doesn't check the pending job's attempts.** Adding `migrated.pending.attempts === 0` would prove v1 never touched it. Line 55 already covers this indirectly.

Compared with `queue-native-update.mjs`, this script runs the same checks through the normal CLI flow (upload, approve, resume) instead of staging a native build and applying the migration by hand. It also uses random job IDs and derives the delay from the budget, where the native script uses fixed IDs and a fixed 12s delay. Both are improvements.
