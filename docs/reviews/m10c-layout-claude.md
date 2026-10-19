Verdict: **no blockers. Approve for the live backup/restore drill and commit at two fleets.**

**What I verified**

- Both qualified snapshots pass `verifyBundle` under the new code and derive the expected layout. Two fleets, nine archives, eight services, seven volumes including tls, networks control/fleet-1/fleet-2. HEAD also accepts them, so the compatibility claim holds. Nothing private was printed.
- All 30 CLI tests pass, including the retirement plan tests that now route through `fleetLayout`.
- Compose checksum ordering is correct. `packages/cli/src/recovery/bundle.mjs:56-58` checks the manifest format, fingerprints compose.json against the manifest, and only then parses it. The dedicated test asserts the exact error message.
- I probed sixteen malformed configurations plus a post-retirement configuration against `validateTopology`. Every rejection is a plain Error with a value-free message. The retired configuration, with a `retirement-generations/<uuid>` prefix and suffixed node identities, still validates, so a retired installation remains backup-able.
- The live compose.yaml matches the validator: minio, controller and workerd on all three networks, bucket-init on control only, each replica on its own fleet network, controller and workerd both mount tls.
- Backup shutdown ordering is preserved and the replica stop list now comes from the layout rather than volume name prefixes. `validateMounts` makes the replica-to-volume correspondence explicit, satisfying accepted change 3.
- No remaining importer of the removed fixed `services`/`volumes` exports anywhere in packages.

**Findings, none blocking**

1. **Test gap, medium.** The negative-case loop in `packages/cli/test/recovery.test.mjs:119` and `:123` uses bare `assert.throws(fn)`. A validator bug that turns a clean refusal into a TypeError would still pass. All twelve cases currently throw the intended messages, so add message matchers now while that is true.
2. **Test gap, low.** No test asserts that `planRetirement(...).config` passes `validateTopology`. That property is what keeps a retired installation recoverable, and I only confirmed it by hand. One assertion using the full fixture in recovery.test.mjs covers it.
3. **Deliberate tightening, document it.** `packages/cli/src/recovery/layout.mjs:15-16` now requires slot node addresses to equal the replica service names and prefixes to match a conservative character set. The compose file exposes `FOGD_SLOT_N_A_HOST` and `FOGD_SLOT_N_PREFIX` overrides that HEAD's backup accepted and this slice refuses. Correct for Docker DNS, but worth a line in the recovery guide. The `_ID` overrides remain allowed since node identities only need to be nonempty and distinct.
4. **Nit.** `validateTopology` calls `volumeNames(config)` inside the mount loop at `bundle.mjs:34`, re-parsing FOGD_SLOTS per mount, and backup.mjs derives the layout three times. Hoist to one `const layout = recoveryLayout(config)`.
5. **Nit.** `inventory.mjs` imports `serviceNames` through the docker.mjs re-export. Importing from layout.mjs directly removes the indirection.

**Deferred to the three-fleet slice, correctly out of scope here**

- The `slots.length !== 2` guard and its message in `layout.mjs:12`, the "two-slot" wording in `bundle.mjs:30`, and the `fleet-${id.slice(5)}` network naming. The derivation itself already generalizes; enabling three fleets is the count check, compose generation, Kubernetes rejection, and the full drill from m10c.md.