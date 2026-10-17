Review complete. Both review questions have a clear answer from the code as it stands.

## Decisions

**Question 1: transform the snapshot into a fresh installation.** Do not build an in-place journal. The fresh-target path has strictly fewer intermediate states because every effect lands in a project that `requireFresh` already refuses to reuse (`packages/cli/src/recovery/restore.mjs:210`), the source is never touched, and failure recovery is the one already documented for restore: discard the partial target, pick a new project name. An in-place journal would need resume logic, a second writer to the live controller volume, and a story for an operator who runs `docker compose start` against a half-migrated project. None of that exists today and none of it is testable without a fake Docker. The cost is honest: the unaffected app and the bucket get copied, so retirement costs one restore worth of disk and downtime. The report measured restore at roughly 10 seconds locally, so that is cheap for the current fleet size.

**Question 2: entirely offline.** Preparation as a controller mutation adds a `retiring` lifecycle state, a cancel path, and a second writer to `state.json` for no stopping benefit, since the proposal itself concedes route pausing stops nothing. The stopped backup is the real stop. With the single-admin assumption, "immediate admission denial" before the window is the admin not clicking approve. Pending proposals submitted before the window are just records and get refused at approval once the tombstone exists. Offline also satisfies "pins the active deployment": the operator passes the active digest and the transform refuses on mismatch before any Docker effect.

## Smallest implementation path

The command is `fogd retire BUNDLE --app NAME --digest SHA --project NEW --output DIR`. It is restore plus three deltas.

1. **Config rewrite, pure function next to `restoredConfig`.** Parse the resolved `FOGD_SLOTS` literal in the controller and workerd environments, find the slot whose owner is the app, and rewrite that slot's prefix to a new generation. Rewrite `CELLD_BUCKET` and `CELLD_NODE` for that slot's two services. Service hostnames, published ports, the other slot, and all credentials stay byte-identical. Volumes need no renaming because every volume in the target project is already physically new.

2. **Skip two archives.** Restore every volume tar except the retired slot's two replica tars. Verify their checksums anyway so the bundle integrity contract is unchanged. The bucket volume is copied whole, so the old prefix objects are retained inside the new bucket and no running process references them.

3. **Controller state transform, pure function in `packages/platform`.** Input is the parsed `state.json`, app name, digest. It refuses absent apps, quarantined apps, digest mismatch against `deployments[app.active].digest`, and apps already retired. It replaces the app record with a tombstone that keeps history but sets `slot: null` and `route: 'retired'`, records the retired slot's id, prefix, and node ids, and flips the app's `pending` and `failed` deployments to a new `retired` status so `mutate` and capacity accounting ignore them. Run it after the `tar --compare` step, never before, so the compare still validates the untouched copy. Write the result through a `--network none` helper container that does an fsynced rename, same shape as the existing archive helpers. The CLI can import the function directly by adding a workspace dependency on `@fogd/platform`, which keeps one implementation and lets the unit tests run in the platform suite.

Controller guards, each one or two lines in `controller.mjs`:

- `available()` throws "app name is retired" when the record has a tombstone. That alone refuses `submit` and `mutate` for scoped tokens, the team token, and stale proposals, because both paths call it first.
- `replaceSecrets` and `issueCredential` refuse a retired name.
- `route()` returns `unknown` for a tombstone so the gateway answers 404 instead of a misleading 503.
- `init()` skips tombstones in the quarantine loop and throws if any configured slot prefix equals a retired prefix. That is the "operator files and controller state must agree" rule, and it is the only new startup rule needed. The two other mismatch cases are already safe refusals: old config with new state hits the existing "multiple bucket slots claim this app" quarantine, and new config with an old controller volume hits the existing "owner missing" quarantine.

Prefix and node naming: nest the generation under the current prefix, for example `slots/slot-1/g2`, and suffix node ids the same way. Nesting is safe regardless of whether celld lists with or without a trailing slash, because the running generation only ever sees its own subtree. Record the generation count in the tombstone so a second retirement of the same slot computes `g3`.

## Blockers and limits to record

- **Drop three proposal claims** before implementation: the online pause and refusal step, the private journal with resume, and in-place fresh volume allocation. The acceptance row for interrupted retirement is met by safe refusal only, not resume.
- **Refuse when the source project still has running containers.** Restore does not check this today. Retire should, using `projectContainers`, because a running old generation is exactly the "usable second deployment" the proposal forbids.
- **Make partial targets unstartable.** Restore writes `compose.json` early because `compose create` needs it. Write it as `compose.pending.json` and rename at the end, so the documented start command cannot act on a partial target. Apply this to restore too, it is one rename.
- **Resurrection warning.** Restore of any bundle brings back whatever apps, credentials, and secret revisions existed at its boundary. Print that on every restore rather than trying to detect it.
- **Tokens are not auto-revoked.** A token scoped to several apps stays valid for the others. Document that the admin revokes single-purpose tokens manually. Secret revisions and artifacts for the retired app stay in the controller volume as retained private material.
- **Never-activated apps.** An app whose slot was claimed but never reached `active` has no digest to pin. Either refuse with a clear message or accept a literal `--digest none`. Decide once and document; refusal is the smaller change.
- **Kubernetes stays unsupported** via the existing `requireDocker` check.
- **Unverified assumptions** the drill must confirm: celld accepts a changed `CELLD_NODE` with an empty volume and empty prefix without further bootstrap, and nothing in the gateway caches the retired host.

## Necessary tests

Platform suite, using the existing fake backend:

- Transform: tombstone shape, pending and failed become `retired`, refusals for absent, quarantined, wrong digest, and already retired.
- After init with a tombstone: submit via team token and via scoped token refused, approve and reject of an older pending record refused, secrets PUT refused, route is `unknown`, `available('other')` returns the freed slot, capacity reports it available.
- Init with a configured prefix equal to a retired prefix throws. Init with old config against tombstoned state quarantines rather than reactivates.

CLI suite, pure functions only:

- Config rewrite touches exactly the retired slot's `CELLD_BUCKET`, `CELLD_NODE`, and both `FOGD_SLOTS` literals, leaves the other slot and every credential unchanged, and round-trips through `composeLiteral`.
- Archive plan excludes the two retired replica tars while `verifyBundle` still checks their checksums.

Drill script modeled on `scripts/installation-recovery.mjs`:

- Accounts in one slot with a session, notebook in the other with D1, R2, and Durable Object data. Backup, retire notebook, start the target.
- Accounts login and records survive. Notebook host returns 404. Old proposal, scoped token submission, and secrets PUT are refused.
- Deploy a differently named app into the freed slot and assert empty entries, empty R2, fresh DO state. List the bucket and assert the old prefix objects still exist and the new prefix holds only the new deploy.
- Negatives: stale digest refused before any Docker call, existing target project refused, source project running refused, kill during archive extraction then retry with the same project refused and with a new project succeeds, and no `compose.json` exists in the interrupted output directory.