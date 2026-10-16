# Claude platform implementation review

Review complete. Findings below, ordered by severity. I verified the backend's celld assumptions against the vendored source in `.upstream/celld` (ledger table `d1_migrations`, filename-with-extension names, one JSON object per row from `d1 execute --json`, multi-statement `--command` allowed). Those all check out.

## Findings

**1. `reconcile()` can silently forget applied migrations** (`packages/platform/src/controller.mjs:77`)
`app.migrations` is replaced wholesale by whatever the ledger returns. If the ledger read regresses (database replaced after a replica or bucket restore, table recreated empty by the `CREATE TABLE IF NOT EXISTS`, wrong `database_name` resolution), the controller drops its record of applied SQL and `compatible()` will then accept a release that rewrites already-applied migrations. The whole point of the ledger reconcile is immutability of applied hashes, so a shrinking ledger must stop activation, not be adopted.
Minimal fix, before line 82:
```js
for (const old of app.migrations || []) {
  if (!applied.some(r => r.database === old.database && r.name === old.name)) throw new Error(`Ledger lost applied migration: ${old.name}`);
}
```
Note that `app.migrations` is reassigned at line 77, so capture the previous list first. Add one test: backend `applied` returns `[]` after a successful activation, next approve must reject and keep `uncertain` set.

**2. Stale pending/failed deployments stay approvable after a newer one activates** (`controller.mjs:88`)
App active with A. B fails, C submitted and activated. B still shows "Retry approval" and the mutate guard only checks status. Approving B rolls the app back to older code while C's schema stays applied. `compatible()` only catches it if C added a migration. Admin intent is unclear from a button labeled "Retry". Minimal fix in the success path after line 122:
```js
for (const d of Object.values(this.state.deployments)) if (d.app === request.app && d.id !== id && ['pending', 'failed'].includes(d.status)) d.status = 'superseded';
```
Superseded artifacts can then be resubmitted via the artifact GET if the admin really wants them.

**3. `init()` overwrites a live app record when two slots carry the same owner marker** (`controller.mjs:33`)
If `state.apps.hello` points at slot-1 and slot-2 also has an owner marker for `hello` (stale marker, manual bucket edit), the slot-2 loop iteration replaces the real record (migrations, active, resources) with the synthetic quarantine stub and saves it. Slot-1 then looks free in `available()`. The bucket `claim()` fence still blocks reuse, but the local metadata you'd restore from is destroyed. Minimal fix: never overwrite, only quarantine.
```js
if (!app) this.state.apps[owner.app] = { slot: slot.id, route: 'paused', quarantined: true };
else if (app.slot !== slot.id) { app.quarantined = true; app.route = 'paused'; }
```

**4. An app can never gain a binding** (`controller.mjs:52`)
`resourceIdentity` includes every d1, r2, and DO binding, and `compatible()` requires deep equality. Adding an R2 bucket or a Durable Object to an existing app is rejected as "Resource identities changed" forever. If this is deliberate for v0, document it. Otherwise check that each existing identity is still present rather than that the sets are equal:
```js
for (const key of ['d1', 'r2']) for (const old of app.resources[key]) if (!release.resources[key].some(r => isDeepStrictEqual(r, old))) throw new Error('Resource identities changed');
```
DO bindings need the same treatment. `script` can stay strict equality.

**5. Quarantine message points at the wrong backup** (`controller.mjs:39`, `:51`)
When the bucket loses the owner marker but state.json is intact, the app is quarantined with "restore controller metadata from backup". The metadata is fine. The bucket is what was lost. Fail-closed is right, the message is wrong. Record which side mismatched in a `reason` field on the app and show it on the page.

**6. Artifacts of rejected deployments are never deleted** (`controller.mjs:91`)
Up to 32 MB each, kept forever under `artifacts/`. Failed ones must be kept for reconcile, rejected ones can go. One line after the reject status change: `await rm(this.artifact(id), { recursive: true, force: true })` once `uncertain` is confirmed not to reference it, which line 90 already guarantees.

## Auth boundaries

No defects found. The three credentials cannot cross: deploy token hits only `POST /v1/deployments`, gateway token only `/internal/route`, everything else requires Basic. The `/artifact` GET is behind Basic. CSRF token is only readable via an authenticated same-origin GET. Comparisons are constant-time over hashes. The HTML page only interpolates server-generated UUIDs and validated hex into attributes, with everything else escaped. The gateway strips `x-fogd-*` and `cf-*` before forwarding and 404s the `/__fogd` and `/.well-known/celld` paths.

## Checked and fine

- Crash and restart checkpoints: `uncertain` and `route: paused` are persisted before the migrate call, `activating` becomes `failed` on boot, reconcile runs before any new release is checked. The test on line 82 covers it.
- Exact artifact: digest verified at submit, twice at approve, and before every reconcile. Base64 canonicality and path validation in `receiveArtifact` are tight.
- Slot ownership: `claim()` runs before app state is created, so state never records an app without a bucket marker. `IfNoneMatch: '*'` is a belt-and-braces fence on a single controller.
- The `exclusive()` lock serializes submit and approve for the full activation. A long `ready()` poll can hold it for over 30 minutes worst case. Expected with a single controller, just note that submits queue behind it.

Nothing here blocks the Docker smoke. Items 1 and 3 are the ones I would land before calling milestone 6 done, since both are about not losing the record that protects applied SQL.
