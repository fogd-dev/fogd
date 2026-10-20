# Experimental scheduled activation

Cron admission remains closed. The controller has an internally staged activation
path for the [M11c contract](m11c.md); ordinary artifact submission still rejects
cron declarations. The default backend has no cron transport and there is no
installation flag that opens this path. Runtime provenance enforcement,
replacement and stopped recovery still need qualification. Selected native process
interruptions have a separate bounded profile below.
The [Void refresh fixture](../examples/refresh/README.md) and
[operator controls](cron-controls.md) have separate bounded profiles.

## Approval and dispatch ordering

The controller persists the exact artifact approval and selected secret revision
before claiming a fleet. First activation publishes an app-free D1 bootstrap,
waits for adoption and confirms a native dispatch hold. It reconciles migrations
and applies schema changes while held, then publishes the materialized application,
checks replica adoption and validates required configuration before release.

The [cron coordinator](../packages/platform/src/cron-activation.mjs) records
application publication intent before publishing user code. An uncertain reply
cannot send retry back through the bootstrap phase and overwrite application code.
Release uses the approved runtime version through the
[guarded transport](patches/celld-cron-controls.md).

The [dispatch journal](../packages/platform/src/cron-dispatch.mjs) separates the
operator's desired state from an activation hold, the runtime observation and an
unfinished operation. An operator pause survives a compatible update. HTTP routing
and scheduled dispatch are independent; a running callback can finish after pause.
Neither the journal nor a null alarm proves cancellation or drain. Queue delivery
uses the same durable operation logic while retaining its existing state format.

## Failure and restart

Every dispatch operation saves intent before contacting the runtime. A lost reply
leaves its outcome unknown and retains the activation hold.
After an uncertain successful release, approved callbacks may execute until a new
runtime pause is confirmed. A failed metadata write
stops further effects until the controller reloads durable state. Private activation
errors withhold runtime diagnostics, and API inspection excludes versions derived
from private configuration.

Restart marks interrupted activation as failed and attempts only to re-establish
its hold. It does not migrate, publish or resume automatically. An unavailable fleet
leaves an unknown observation and a retryable error. Explicit approval retries the
original artifact with its pinned secret revision; another artifact cannot take
over that hold. Cross-artifact correction is unqualified.

Cron state carries a capability marker so older controllers refuse it. Current
backup, restore and expansion paths refuse this history; restarting a controller
is not installation recovery. Scheduled app retirement also refuses until its
dispatch, data and authority isolation gates have evidence. Do not start historical
snapshots and then rely on a controller pause to stop overdue timers.

Even pending or rejected private cron records require the experimental transport
when reopening their controller directory. A default backend refuses that directory.
If a held artifact or pinned secret revision is unavailable, its matching retained
metadata must be recovered before retry; rejection, replacement and retirement
cannot discard the hold. General scheduled installation recovery is unqualified.

## Qualification

The [integration tests](../packages/platform/test/cron-activation.test.mjs) use a
file-backed runtime model to exercise lost replies, ambiguous metadata writes,
pinned secrets and actual controller process kills. Those tests do not establish
native timer behavior.

The [bounded native evidence](evidence/m11c-cron-activation.json) records the
internally staged profile; it does not open admission. The
[native controller probe](../scripts/cron-controller.mjs) needs a never-deployed
fleet in a disposable installation. Its controller must contain current platform
sources, and every replica must use the qualified
[native control patch](patches/celld-cron-controls.md). Use the private fixture
environment from the [disposable setup](queue-qualification.md#prepare-a-disposable-installation):

```sh
FOGD_ENV_FILE="$PWD/.fogd/cron-controller-fixture/probe.env" \
  node scripts/cron-controller.mjs slot-1 .fogd/cron-controller-evidence
```

This probe privately stages a raw Worker with D1 and a required secret. It observes
a minute boundary before approval, delays migration across another boundary,
recovers a lost successful resume reply by reloading controller state, waits for a
native stored result, and checks that an approved update preserves operator pause.
Inspect the private evidence and cleanup result, then stop the disposable fleet
while retaining its volumes. A printed pass before cleanup is insufficient.
The probe bypasses ordinary upload admission and does not qualify native activation
process kills, ordinary Void jobs, workerd ingress or stopped snapshot recovery.
The separate [Void refresh profile](../examples/refresh/README.md) exercises native
jobs and workerd through private staging; normal cron admission and recovery gates
remain open.

[Scheduled operator controls](cron-controls.md) expose recorded status and explicit
observe, pause and artifact-pinned resume through the admin API, page and CLI.
They retain activation holds and leave application outcomes to the app.

### Native process interruptions

The [bounded evidence](evidence/m11c-cron-interruptions.json) records selected
native cuts. The [SIGKILL probe](../scripts/cron-interruptions.mjs) runs ordinary Void refresh
code through private staging on a never-deployed fleet. It preserves the native
job code and adds an inert configuration variable to distinguish update artifacts.
Use a fresh disposable installation with current controller sources and the
qualified cron patch on every replica. Keep the stock controller on a separate
state directory; workerd uses the private controller's internal listener on 8084.
Select a never-deployed slot. The VM-clock replay uses slot-2.

```sh
FOGD_ENV_FILE="$PWD/.fogd/cron-interruption-fixture/probe.env" \
  node scripts/cron-interruptions.mjs slot-1 .fogd/cron-interruption-evidence
```

The driver verifies the checkpoint process's PID, command arguments and process
start time before sending SIGKILL. It requires the actual container exec to exit
137. Native operations complete before their after-effect checkpoints; the durable
release checkpoint follows the controller metadata write and directory fsync.
The killed process cannot run a shutdown pause.

The selected cuts cover first application publication before its reply is saved,
first native resume before journal confirmation, an update's durable release before
the active pointer, and a paused update's publication. The profile also observes
minute boundaries before approval and during delayed migration. Restart must retain
the same artifact and secret revision, re-establish its hold and require explicit
approval. No bootstrap, migration, application publication or resume is allowed
during restart. The probe checks native control state and a held minute boundary,
then retries the original artifact. It verifies actual future results, adoption of
the approved version by every replica, retained business data and a paused update
that stays paused after retry while HTTP serves the app.

A release that reached the runtime can execute approved callbacks before restart
confirms its new hold. The probe deliberately waits for native saved results in
that window. Routing pause does not prevent those callbacks. Recorded held
intervals are rechecked against later native results, so delayed ledger writes
cannot hide a new occurrence in those intervals. The paused update's first minute
after retry is checked a full minute later. The ledger does not establish callback
entry times or distinguish retries of older occurrences. Neither the ledger nor a
null alarm proves callback or `waitUntil` drain.

Inspect the receipts, terminal status, cleanup and selected-service logs, then stop
the disposable installation while retaining its volumes. A printed pass alone is
insufficient. These selected cuts complement the broader file-backed kill matrix;
they do not qualify scoped cron upload, every native failure boundary, corrected
artifacts, handler overlap or historical snapshot recovery.
