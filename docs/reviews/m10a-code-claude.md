**Verdict: approve M10a as implemented. No correctness, privacy, or contract blockers. Two test gaps worth closing before merge, neither blocking.**

All 23 platform tests pass, including the two new capacity files.

**Correctness, checked against the reviewed contract**

- `capacity()` in `packages/platform/src/capacity.mjs` reads only in-memory state: `controller.slots`, `occupied`, `bucketOwners`, `state`, and `quota.describe()`. It never calls the backend, never writes, and never touches `save()`. The HTTP test confirms `state.json` is byte-identical after the API, page, and CLI calls.
- Occupancy mirrors the admission check exactly. The expression `occupied.has(id) || owners.length > 0` is the same disjunction `available()` uses at `controller.mjs:70`, so the report cannot show a slot as available that submit or approve would refuse.
- `bucketOwners` is populated in exactly the two places the response document asked for: init at `controller.mjs:46` and after a successful claim at `controller.mjs:153`. It is set only after `backend.claim` resolves, so a failed claim does not cache a false owner. It lives outside `this.state`, so it is never persisted.
- The duplicate-ownership case is covered by the existing quarantine test, now asserting both slots cache `hello` and the second slot has no controller assignment while remaining occupied.
- `pendingDeployments()` is shared between the report and `submit()`, so the global and per-credential counts cannot drift from what admission enforces. Rejected and superseded statuses fall out of the pending set but stay in quota bytes, matching the contract.
- The legacy team token reports `limit: null` and is exempt from the per-credential check, consistent with the existing `submit()` branch.

**Privacy**

- The report emits only `slot.id`, app names, route, quarantine flag, credential ids, and counts. Slot `prefix` and `nodes` are dropped. Credential ids are UUIDs already exposed by `credentials.describe()`, not token hashes.
- Both tests assert the serialized report, CLI stdout, and page contain no `private-prefix`, `private-address`, or admin password.
- The page escapes slot ids, bucket owner, and assignment labels through the existing `html()` helper. The script-tag slot id test proves it. Numeric fields are interpolated raw, which is safe since they come from `length` and the quota integers.
- Deploy-only and anonymous callers get 401 on `/v1/admin`. The internal-role listener already 404s everything outside `/internal/`, so the capacity section cannot leak there.

**Minor observations, not blockers**

- `adminState` spreads `...controller.state` before adding `capacity`. No app or deployment key collides today, but a future top-level `capacity` field in state would silently be overridden. Fine as is.
- The CLI test invokes `packages/cli/bin/fogd.js` by a cwd-relative path. It works with the root `npm test` script, but running the file from inside `packages/platform` would fail with ENOENT. Using `new URL('../../cli/bin/fogd.js', import.meta.url)` would remove that fragility.

**Test gaps**

1. **Report versus refusal at the pending boundaries.** The contract row says to compare the report with submit refusal at each boundary. Artifact bytes are covered at `platform.test.mjs:389-393`. Pending limits are not: the capacity unit test uses a hand-built fixture, and the existing per-credential limit test never reads the report. One assertion after the `maxPendingPerCredential = 1` refusal, checking `byCredential` shows `pending: 1, limit: 1` and global `pending: 1`, would close it.
2. **Orphan slot through the real controller.** The orphan case (bucket owner with no controller record) is only exercised through the fake-controller fixture. Init at `controller.mjs:48-50` synthesizes a quarantined app record for that owner, so a real controller will show one assignment rather than zero. The fixture's `assignments: []` expectation describes a state the real code never produces. Not wrong, but the fixture should either match init behaviour or the test name should say it covers the map-only path.

**Ponytail note.** The slice is appropriately small: one 24-line pure function, one 7-line HTML renderer, a shared `pendingDeployments` helper that removed duplicated filter logic from `submit()`. Nothing to delete.