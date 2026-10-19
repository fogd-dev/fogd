# Claude follow-up: native qualification fixes

**Verdict: PASS.** None of my prior feedback is still blocking, and the new browser probe has no blockers either.

**Prior blockers, now resolved**
1. **Crash vs. handler-budget timeout** (`queue-native-crash.mjs:9-24`)
   - The delay is now 12 s, and the script asserts it is under the budget.
   - A control job with the same delay and no kill has to finish with `attempts === 1` before any kill happens. That shows the budget and runtime can complete this work.
   - In `processJob` (`lib/process.mjs:8,14`), `attempts` goes up before the delay. So `observedAt` is at or after the attempt starts, and the stop has to land within 6 s of that.
   - The proof doesn't really depend on that timing check. It comes from the end state: `results: []`, `status: accepted`, `attempts: 2`, while the control completed. A kill that missed would leave result rows behind.
2. **Failure row** (`:34`): `exhausted.error === null` rules out `failed()` running on either attempt.

**Should-fix items, all addressed**
- Duplicate delivery while paused: `stored === 2`, then `attempts === 1`.
- The paused gate checks `attempts === 0`.
- The update probe checks one attempt for each job and `stored === 0`.
- The full consumer object is compared with `deepEqual`.
- Upload targets use a UUID, so they can't merge with an old directory.
- Probe order is written down in `queue-qualification.md:90-93`.

**Browser probe (non-blocking)**
- `queue-native-browser.mjs:24,40`: the PASS line claims "retryable failure", but nothing checks that the retry actually happened.
  - If `mode` were dropped somewhere, the run would still pass with one attempt.
  - Fix: after "Import complete", read `/api/imports?id=<saved>` with `probe.http` and assert `attempts === 2`. Or remove "retryable failure" from the PASS message.
- The route handler forwards only the method and body, not headers. That's fine, because the crash and update probes already post without a Content-Type.
- The comment and the saved `transport` field say clearly that this makes no claim about gateway routing.

**About the r2 run:** the log shows the initial and update probes passed, and the crash probe is partway through. Its last line is the attempt-1 kill. This verdict covers the code only, not a finished slot-2 run.
