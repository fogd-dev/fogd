Review complete. Verdict first, then the grounded concerns.

**PASS with concerns.** The slice is correctly bounded, its contract matches what the controller actually enforces, and nothing in it requires deletion or ownership release. No blockers. Five concerns the slice text or its implementation plan should absorb before it starts.

**What the code confirms**

- Slot occupancy is exactly two predicates at `packages/platform/src/controller.mjs:66-69`: slot id in the in-memory occupied set, or any app record pointing at the slot. Orphan and duplicate owners both land there via init at lines 41-61. The row 1 and row 2 fixtures already exist as tests (`platform.test.mjs:96` and `:196`).
- Pending limits count `pending` and `failed` only, globally at line 85 and per submitter at line 82. The team token is exempt from the per-credential check but counts globally. `rejected`, `superseded` and `activating` do not count. The slice's row 3 is accurate.
- Retained bytes come from `ArtifactQuota` (`quota.mjs:238-250`), summed from the artifacts directory at init and from decoded upload bytes at admit. Those match because receiveArtifact writes exactly the decoded files and nothing else (`manifest.mjs:27-32`). Secrets and execution dirs live outside the artifacts dir, so they are correctly excluded.
- Auth boundary is inherited for free: capacity under `/v1/admin` is already denied to deploy-only bearers (`platform.test.mjs:116`, `:354`), and the internal listener returns 404 for it (`:430`).
- The HTML escaper exists at `http.mjs:263` and is applied to app, route, slot and reason today.

**Concerns**

1. **Duplicate-owner slots lose the owner name.** The occupied set at `controller.mjs:23` holds slot ids only. For a duplicate bucket claim, the app record keeps its original slot and the second slot is remembered as occupied with no app attached. Row 1 promises "each slot's owning apps", which cannot be met for that case without making the set a slot-to-app map during init. Small change, but the slice should name it rather than discover it mid-implementation.

2. **Occupancy is a startup snapshot, not a live bucket read.** Bucket owner files are read only in init and in claim. A bucket edited behind a running controller will not change the report until restart. Say so in the contract. Do not add per-request S3 reads to the admin page to fix it. That would make the read-only report depend on bucket availability.

3. **Rejected and superseded artifacts still hold bytes.** Reject at `controller.mjs:130` flips status and never removes the directory or decrements usage, by design. So an admin can see zero pending and a full byte quota at once. That is precisely the "explain the limit" scenario, so row 4 should state that retained bytes include rejected and superseded artifacts and that only M10b frees them. The existing test at `platform.test.mjs:380-387` already demonstrates this behaviour.

4. **Privacy field list is incomplete.** Slot config carries `prefix` and `nodes` (`main.mjs:630-634`). `nodes` are the internal replica addresses the slice already excludes. Add `prefix` to the exclusion list, since it is bucket layout. The response-field test should assert absence of `nodes`, `prefix`, credential `hash`, raw tokens, and `version` on private deployments, the last of which `adminDeployment` already strips. The capacity object must be computed in the view, never stored on `controller.state`, or `adminState`'s spread at `admin-view.mjs:222` will persist it to disk via save.

5. **No CLI admin test harness exists.** The CLI tests cover recovery and Kubernetes only. `fogd admin capacity` is a one-branch addition to `platform.mjs:40` that prints a field from the same `/v1/admin` fetch, plus a help line in `bin/fogd.js`. Given that, an HTTP-level field test is adequate evidence for row 5. The slice should say that explicitly instead of promising a CLI comparison that would need new scaffolding.

**Minor**

- Row 3 could add the per-credential section labels the team token as globally counted only, so an admin is not misled into thinking it is unlimited.
- Submit checks run in a fixed order (per-credential, bytes, global pending, slot). The report should present the three limits independently and not imply precedence.
- Pending new-app proposals competing for the same free slot remain invisible. The slice's "observations, not reservations" sentence covers this honestly. A count of pending submissions for apps without a slot record would be cheap and useful but is optional.

Scope check: nothing above expands into retirement. All five concerns are wording or small implementation notes inside the stated read-only boundary.