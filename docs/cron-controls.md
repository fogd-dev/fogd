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
