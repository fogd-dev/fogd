Review complete. Tests in the platform and CLI packages pass locally (53 in those two suites, no Docker touched).

**Verdict: no correctness, privacy, or isolation blocker found.** The implementation matches the amended design. One medium gap in the refusal set, a few minor items, and some drill-only assumptions.

**Confirmed against the amendments**

- Mutation guard precedes the reject branch and the status check in `packages/platform/src/controller.mjs:137`. Reject, approve, retry, secrets replace, credential issue, and submit all hit `assertLiveName` first.
- Routing returns unknown for tombstones. Startup validates tombstone shape, refuses overlapping configured prefixes, refuses unknown `requirements`, and skips tombstones in the ownership loop while still throwing if a configured prefix's owner marker names a retired app.
- Prefix is `retirement-generations/<uuid>`, disjoint from configured and previously retired prefixes via `overlap`, checked both in the plan and in `retireState`. Every backend key is under `${slot.prefix}/`, `CELLD_BUCKET` and `CELLD_NODE` are rewritten for exactly the two retired replica services, and those two tars are checksum-verified but never extracted. Other slot, credentials, and commands are byte-identical (tested, including the `$$` round trip).
- Capability probe runs after image load and before `compose create`. The runtime image has `WORKDIR /app`, no entrypoint, and ships `packages/platform` with prod deps, so the relative import resolves.
- Pending file convention applied to both restore and retire. The receipt is written after the rename and directory fsync. Retry on the same project is refused by `requireFresh`; same output dir is refused by non-recursive `mkdir`.
- Source and its named volumes are checked stopped before and after the transform. Target is re-checked stopped before publishing. Backup and source volumes are never written. `tar --compare` runs before `state.json` is replaced, so it validates the untouched copy. Evidence and config are written `wx` 0600. No error path echoes configuration or state values.

**Findings**

1. **Medium, refusal set too strict.** `retirementApp` requires `route === 'active'` (`packages/platform/src/retirement.mjs:21`). The only path that sets route back to active is a successful activation. An app whose most recent redeploy failed stays `paused` indefinitely with `uncertain` null, and this is exactly the broken app an operator wants to retire. Recommend allowing `paused` when not quarantined, `uncertain` is null, and no deployment is `activating`, still pinning `app.active`'s digest. The current test at `packages/platform/test/retirement.test.mjs:28` locks in the strict behavior with `{ route: 'paused' }`, so it would need flipping.

2. **Minor, spec deviation.** `retireState` flips the `active` deployment to `retired` too, not only pending and failed (`retirement.mjs:33`). Harmless since the tombstone records the deployment id and all mutations are guarded, but the response doc says pending/failed only. Either narrow it or amend the doc.

3. **Minor, stale copy.** `admin-capacity.mjs:6` still prints "retirement is not supported yet."

4. **Minor, test gaps worth adding** (pure functions, no Docker):
   - `planRetirement` refuses when the generated prefix overlaps a previously retired tombstone prefix, and when `validateRetirementState` fails on the snapshot.
   - A tombstone with `slot` not null or `route` not `retired` is refused at init.
   - An HTTP-level secrets PUT and approve POST against a retired name, since the user-stated count includes HTTP tests but the diff only covers the controller layer.

**Drill-only assumptions to confirm** (not verifiable from code)

- Host `tar -xOf controller.tar ./state.json` matches the `./`-prefixed member on macOS bsdtar and GNU tar. A miss surfaces as the generic "Cannot read controller state" error.
- celld accepts a 45-character `CELLD_NODE` with an empty volume and empty prefix and bootstraps without further setup.
- The freed slot's replicas start cleanly with nothing routed to them, and the gateway holds no cached route for the retired host.