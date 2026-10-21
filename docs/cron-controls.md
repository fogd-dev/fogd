# Experimental scheduled dispatch controls

Scheduled dispatch controls expose recorded state and explicit operator actions
for an internally staged cron application. Cron admission remains closed. The
default backend has no cron transport; these controls require the qualified
[native patch](patches/celld-cron-controls.md) on every replica and an experimentally
injected transport. They do not qualify installation recovery or mixed runtimes.

## Inspect and operate

The admin page separates desired dispatch, effective intent under an activation
hold, recorded runtime observation, unfinished operations and approval progress.
Application results belong to the application: the
[refresh example](../examples/refresh/README.md) displays saved results and failures.
HTTP route state is independent of scheduled dispatch.

Use the usual admin credentials and explicit installation configuration:

```sh
fogd admin dispatch refresh status
fogd admin dispatch refresh observe
fogd admin dispatch refresh pause
fogd admin dispatch refresh resume DEPLOYMENT_ID ARTIFACT_SHA256
```

Status reads recorded metadata without contacting the runtime. Observe contacts
the runtime and persists a new observation; it can materialize a scheduler cell.
Pause persists operator intent before contacting the runtime. Resume requires the
current active artifact ID and digest, completed activation, no hold or uncertain
migration, and adoption of the approved runtime generation by every replica.
Operator pause survives approval of a compatible update.

The HTTP resource is `/v1/apps/APP/dispatch`. GET returns recorded status; POST to
its `observe`, `pause` or `resume` child performs the corresponding action. Mutations
require admin authentication and the session's CSRF token, with same-origin checks
when Origin is supplied. Resume accepts `deployment` and `digest`. These routes
are unavailable on the internal gateway listener. Recorded views and ordinary
errors omit private runtime versions and secret values.

A runtime failure returns 502 and leaves the observation unknown. Refresh recorded
status, then explicitly observe or retry. Observation never releases an activation
hold or clears an unfinished pause/resume. If a resume reply is lost, native
callbacks may already be running. An explicit confirmed pause reconciles the
operator's intent. A failed metadata write returns 503 and stops further controller
effects until durable state is reloaded.

Pause prevents new callbacks only after runtime confirmation. Running callbacks
and `waitUntil` work can finish; neither a null alarm nor a paused observation
proves a drain. A held artifact can only retry its original activation. The page
retains rejection for unrelated submissions while preventing replacement or
rejection of the hold owner.

## Experimental recovery protocol

The controller has snapshot preparation and recovery acknowledgment controls.
Full-installation cron backup/restore remains unqualified and the ordinary CLI
continues to refuse scheduled history. These controls alone do not make an
archive safe to restore.

POST to `/v1/apps/APP/dispatch/snapshot` with the active `deployment` and `digest`
checks the stored artifact and selected secrets, records native status, pauses
dispatch and confirms the held approved generation. Its private receipt pins the
schedule, secret revision, runtime version and control revision. Any subsequent
dispatch journal operation invalidates that preparation. The returned JSON
contains only the receipt ID. Failed preparation can leave dispatch operator-paused;
inspect status before explicitly resuming. Replica and control observations are not an atomic
fence against independent runtime operators.

For controller metadata carrying a pending recovery receipt, startup keeps HTTP
routing and dispatch paused. It checks that native dispatch was already held at
the prepared revision before reconciling the pause. An active timer or mismatched hold revision observed at startup permanently
disqualifies that restore, even if a later operation reaches the expected revision.
Unavailable replicas leave recovery unconfirmed. Pending
recovery blocks both resume and new approvals.

The recorded dispatch view exposes the recovery ID, review fingerprint, findings
and loss notice. After reconciling application records, acknowledge the current
findings through the admin page or CLI:

```sh
fogd admin dispatch refresh recover DEPLOYMENT_ID ARTIFACT_SHA256 RECOVERY_ID REVIEW_SHA256 --accept-possible-loss
```

Acknowledgment checks the exact active approval and repeats runtime verification.
Changed findings require a fresh review fingerprint. It restores HTTP routing;
scheduled dispatch stays paused until a separate exact-artifact resume. The HTTP
action is `acknowledge-recovery`, with `deployment`, `digest`, `recovery`, `review`
and `acceptPossibleLoss: true`; authentication and CSRF requirements match other
mutations.

Pausing clears pending timer and retry identity. Resume schedules a future
occurrence. An older snapshot can lose acknowledged results or replay external
effects; application idempotency and reconciliation remain necessary. The
[controller tests](../packages/platform/test/cron-recovery.test.mjs) cover these
metadata and runtime-transport boundaries. Fresh-storage native startup, due timer,
pending retry, older-snapshot and idempotent native pause qualification remain open under
[M11c gate 7](m11c.md).

## Native qualification

The [bounded evidence](evidence/m11c-cron-operators.json) records the qualified
operator profile. The operator probe reopens the retained private controller from a completed
[Void refresh qualification](../examples/refresh/README.md). Stop that fixture
first. Preserve its bucket, controller directory and both replica identities.
Replace the controller sources with this checkout and retain the qualified cron
runtime on both replicas. Expose private controller port 8085 on a loopback-only
host port; workerd must use its internal port 8084 for route lookup. Start the
fixture's bucket and wait for readiness before starting its controller, workerd
and selected replica pair. The stock controller must use a different state
directory; only the private runner may write the retained qualification directory.

```sh
FOGD_ENV_FILE="$PWD/.fogd/cron-fixture/probe.env" \
  node scripts/cron-operators.mjs slot-2 .fogd/cron-operator-evidence \
  .fogd/cron-void-evidence/void.json http://127.0.0.1:8910
```

The probe checks API/page/CLI recorded reads without runtime commands, stale resume
refusal, private-value omission, a lost successful native resume reply, explicit
pause reconciliation, browser resume/pause, a future native result and a held
minute boundary. It restarts both replicas and reloads the private controller
while paused. Inspect the receipt, process exit, cleanup and selected-service logs,
then stop the disposable installation while retaining its volumes. A printed pass
before cleanup is insufficient. These checks do not qualify restored historical
snapshots, arbitrary callback drain, native activation process kills or ordinary
scoped cron submission.
