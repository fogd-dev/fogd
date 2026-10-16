# Claude M7b specification review

**Verdict: the resource-contract half is already implemented and tested; the spec should say so and spend its words on the transfer half, where four things need tightening before code lands.**

## Resource reservation and failure semantics

1. **Already done, say so.** `resources.mjs` plus `controller.mjs:117-128` implement the monotonic floor, and the test at `packages/platform/test/platform.test.mjs:208` already covers every item in the spec's validation list: reject without changing reservation, floor persisted before `ready`, restart, stale rejection, explicit retry. The exact-artifact boundary also holds: `receiveArtifact` rebuilds `resources` from the digest-covered `wrangler.json` at `manifest.mjs:38`, not from the excluded release file. M7b's new work here is only the end-to-end run against a real guestbook release. Rewrite the section as "qualify existing behavior" so nobody rebuilds it.

2. **"Derived R2 additions" are computed against the wrong baseline.** `controller.mjs:117` recomputes `resourceChanges` relative to `app.resources`, which is the floor. After a failed activation raises the floor, the retry of that same release shows `r2Added: []` in the admin page, and so does every later submission, even though the active release still lacks the binding. Spec should state: validate against the floor, display relative to the active release's declaration. One-line change.

3. **Add the realistic failure to validation.** This fixture adds a table and a binding in one release, so the likely failure is at `migrating`, not `publishing`. The existing test only fakes `ready`. Add one case where the attachments migration fails after the floor is raised, then a corrected release that keeps the binding succeeds.

4. **State what a reservation physically is.** In celld an R2 binding is only the key prefix `r2/{bucket_name}/` under the slot prefix, created lazily on first put with no deploy-time provisioning. See `.upstream/celld/crates/celld/r2_store.rs:48`. "No automatic rollback" is therefore vacuous. Write that down so no one adds a provisioning or retirement step, and note the slot-scoped key space as the M8 retirement gap.

5. **Stale submissions are not "rejected", they stay pending.** `mutate` throws before changing status, the request keeps counting toward `maxPending`, and the reason only reaches the admin as an `alert()`. Acceptable, but the spec should say "approval refused, admin rejects manually".

## Bounded logical transfer

6. **Interrupted restore is a dead end as written.** Nonempty destination plus partial restore plus no destructive changes means every retry is refused with no recovery path. Fix by construction: define "empty" as zero rows and no completion record, with R2 orphans ignored. Put all objects first under content-addressed keys so re-puts are idempotent. Then insert every row and the completion record in one `db.batch()`. Confirm celld runs batch mode inside one `BEGIN IMMEDIATE..COMMIT` at `harness.js:7642`. If it does, there are only two reachable states. If it does not, document "rows without completion record" as the known gap.

7. **Derive the byte limit from real ceilings.** Compose sets `CELLD_MAX_REQUEST_BODY_BYTES` to 16 MiB and the V8 heap to 128 MiB. A validate-everything-first restore buffers the whole base64 JSON body. Any `onlyIf` put over 8 MiB fails, per `r2_store.rs:38`. Set the profile cap around 8 MiB of object bytes and have export refuse to emit a profile the restore cannot accept. One request, no chunking.

8. **Key attachments by SHA-256.** Immutability, dedupe, checksum, and restore verification all fall out of using the content hash as the R2 key, and it avoids `onlyIf` entirely. Row stores id, message_id, key, size, content_type.

9. **Gateway block is the only barrier; add the free second one.** The gateway already strips every `x-fogd-*` header at `gateway.js:27`. Require `x-fogd-maintenance` on the handlers. No new auth system, and a path-normalization bypass still fails. Add `//__fogd/export` and `/__FOGD/export` to the negative tests next to the existing encoded cases in `gateway.test.mjs:8`. Void reserves only `/__void/`, so `/__fogd/` routes are legal, per `dispatch/src/index.ts:713`.

10. **Consider dropping the handlers.** The controller container already runs `celld` per slot, `celld r2 get/put/list` reads the bucket with no live node, and `celld d1 execute --json` already feeds `applied()`. An operator script could do the whole transfer with zero app code and replicas fully stopped. Caveat: `celld d1` needs one live node. If the spec keeps in-app handlers for schema locality, state that reason.

11. **Check schema parity, not just format version.** The real mismatch risk is the second app deployed from a different release. Include the source's `d1_migrations` names in the export and have restore compare them.

12. **"Stop public ingress" has no lever today.** `app.route` is only writable inside `mutate`. The lazy answer is `docker compose stop workerd`, which stops every app. Say that; do not add a pause endpoint in this milestone.
