# Probe queued-work lifecycle behavior

These scripts test the pinned celld runtime directly. They do not enable queues in
fogd or establish approval support. The native probes below separately exercise
Void queues and additive D1 migration overlap. See the
[M11a proposal](m11a.md) and [review amendments](reviews/m11a-response.md) for the
remaining product contract.

## Prepare a disposable installation

Use a fresh project whose name begins with `fogd-m11`. The setup builds the local
runtime images, pins their identities, generates private credentials, and writes a
two-fleet Compose configuration with a 20-second handler budget. It creates no
containers and refuses existing project resources or output. The budget is a test
setting, not a change to ordinary fogd defaults.

```sh
node scripts/queue-probe/setup.mjs .fogd/queue-fixture fogd-m11-queue
unset COMPOSE_PROJECT_NAME FOGD_COMPOSE_FILE
export FOGD_ENV_FILE="$PWD/.fogd/queue-fixture/probe.env"
pnpm exec fogd up
```

Default loopback ports are 8899 and 8900. Set `FOGD_PROBE_HTTP_PORT` and
`FOGD_PROBE_ADMIN_PORT` before setup to choose other ports. The generated environment
and resolved Compose file contain credentials; keep the directory private.
The setup clears inherited platform/storage overrides before generating its local
configuration. It does not use Cloudflare credentials or APIs.

## Publication, overlap, and exhaustion

Run the probe separately on each fresh fleet, using new evidence directories:

```sh
node scripts/queue-lifecycle.mjs slot-1 .fogd/queue-slot1
node scripts/queue-lifecycle.mjs slot-2 .fogd/queue-slot2
```

Each run refuses a fleet with existing deployment objects. It publishes a
producer-only platform bootstrap, pauses delivery, and then publishes a direct
Worker fixture. A queued message cannot produce its R2 marker until resume.

Next, a held v1 handler remains in flight while delivery pauses and v2 is published.
The probe records node deployment diagnostics and verifies v1 finishes the held
message while v2 processes pending work after resume. This is compatible overlap,
not a drain. It then records a `waitUntil` effect occurring after a paused queue
reports no stored messages, exercises two exhausted attempts without a dead-letter
queue, and exceeds the 20-second handler budget. It also tests a `waitUntil` effect
scheduled 15 seconds beyond that budget. No late completion marker may
appear during the bounded observation. Each fleet is left paused.

The fixture has no D1 migration or native Void code generation. Its R2 records
identify handler version, attempt, stage, and time. They are evidence of these
specific effects, not evidence that arbitrary external effects happen exactly once. Do not run the probe against an application you want to preserve.

## Stopped recovery with pending and interrupted work

After both fleet probes finish, run:

```sh
node scripts/queue-recovery.mjs slot-2 .fogd/queue-recovery fogd-m11-restored
```

This requires both fleets to contain the probe's `probe-jobs` queue. It pauses both,
starts a held job on the selected fleet, pauses new delivery, and queues a second
job. It force-stops the selected replicas before the held handler completes, takes
a full stopped snapshot, and restores onto fresh resources.

The restored queues must still be paused. The selected fleet's event history must
match the pre-stop history, and both messages must remain stored. Only deliberate
resume permits the pending job's first attempt and the interrupted job's second
attempt to complete. The source remains stopped and the restored installation is
left running with delivery paused. To stop it afterward, select the restored
project and the generated `restored/compose.json`, then use `docker compose stop`
with that file and project. Preserve its volumes unless you intend to discard the
fixture; never restart source and restored copies together. Evidence includes the snapshot and restoration
receipts; these contain private recovery material.

Budget space for both installations and the image archive. Retained stopped test
networks can exhaust Docker's address pool; remove only known stopped disposable
containers/networks if needed, preserving their volumes and evidence. No global
prune or host-network configuration change is required.

## Native Void imports

Use another fresh installation from the setup above. Do not reuse a fleet already
occupied by the raw Worker probe. Run these in order with distinct output paths:

```sh
node scripts/queue-native.mjs slot-1 .fogd/native-initial
node scripts/queue-native-update.mjs slot-1 .fogd/native-update
node scripts/queue-native-crash.mjs slot-1 .fogd/native-crash
node scripts/queue-native-browser.mjs slot-1 .fogd/native-browser
```

The [imports example](../examples/imports/README.md) uses native Void queue code
generation, a typed producer, R2 input, and D1 job/result records. The initial probe
publishes a producer-only bootstrap with D1 bindings, pauses delivery, and applies
the first migration before publishing application code. It checks persistent pause,
idempotent submission, transient retry, and explicit retry after exhaustion.

The update probe stages an additive D1 migration while a v1 handler is held,
publishes v2 with delivery paused, and confirms the queue belongs to the current
generation before resuming. The pending v2 job must complete while v1 is still
running. Their result rows identify which version wrote them.

The crash probe kills both selected replicas during each of the two allowed
attempts, using a delay below the handler budget and an un-killed control that
must complete. After the queue exhausts delivery, the durable job must remain unfinished
with no result. Explicit reconciliation must read retained input and complete one
result; retrying the completed job must do nothing. This deliberately interrupts
both nodes and can take several minutes while leases expire. Every probe leaves
delivery paused on success; a failed probe requires inspecting its phase before
retrying, since IDs and evidence paths are intentionally not reusable.

The browser probe submits through the page, reloads the saved job URL while paused,
and verifies retained results after processing and another reload. Playwright
forwards HTTP requests to the real private celld endpoint through the controller.
This checks the page against the actual backend, not public gateway routing.

These probes bypass fogd artifact admission and call celld directly. They do not
publish routes through the gateway, approve releases, or establish that controller
restarts preserve activation progress. Private evidence includes runtime state;
only selected synthetic observations belong in committed evidence.

## Resume generation gate

After the native probes, run the internal platform primitive against that fleet:

```sh
node scripts/queue-generation.mjs slot-1 .fogd/queue-generation
```

It rejects an unapproved runtime version while preserving pause, resumes a resident
queue, then restarts both replicas and requires an observed cold queue before
resuming again. `info` materializes the named queue before generation inspection.
Both replicas must report the approved version, and exactly the named queue cell must
exist on its replica's current generation. Missing, duplicate, stale, or additional
queue observations block resume. Successful mutation requires a separate status
read from the same runtime cell. This confirms reported pause state, not actual
delivery. Mutation or confirmation failure throws `QUEUE_OUTCOME_UNKNOWN` without
silently retrying; pre-mutation validation failures block the command.

This primitive assumes one consumed queue per app fleet and serialized publication
by the controller. It is not an atomic fence against a separate operator running
`celld deploy`, and it is not a drain: compatible old handlers may still run.
Runtime diagnostics and the queue identity hash are pinned-version interfaces.
Unit tests cover stale-generation rejection; the live probe observes approved
generations and does not force a stale-generation runtime cell. The controller must persist
intent and activation progress before calling it; that integration remains pending.
The probe leaves delivery paused and records [selected evidence](evidence/m11a-queue-generation.json).

## What remains unqualified

These probes do not establish controller activation recovery, queue addition/removal,
long-age retention recovery, retirement, or safety of arbitrary handler side effects.
In particular, `waitUntil` disproves using queue emptiness alone as a drain. A fixed
observation window cannot prove that no possible later effect exists. The
[probe record](m11a-probe.md) distinguishes runtime findings from the still-rejected
fogd application feature.

## Built-controller activation probe

The `queue-controller` probe uses the built controller against a fresh celld fleet,
with private staged artifacts. It does not exercise public artifact admission, the
HTTP approval endpoint, or gateway routing. It keeps controller state in a separate
qualification directory and leaves delivery paused. Use a disposable installation:
its main HTTP controller does not own the probe's deployment records, so restarting
that main controller can quarantine the probe fleet as an unmatched bucket owner.

Choose unused project, directory, and port values:

```sh
FOGD_PROBE_HTTP_PORT=8899 FOGD_PROBE_ADMIN_PORT=8900 \
  node scripts/queue-probe/setup.mjs .fogd/controller-fixture fogd-m11-controller
FOGD_ENV_FILE=.fogd/controller-fixture/probe.env pnpm fogd up
FOGD_ENV_FILE=.fogd/controller-fixture/probe.env \
  node scripts/queue-controller.mjs slot-1 .fogd/controller-evidence
```

The probe refuses a previously deployed or claimed fleet. It builds the native Void
imports app, records a private request, and verifies that staging has no deployment
effect. Approval runs producer-only bootstrap, D1 migration, app publication, and
readiness. The probe then loses the response to an actually successful resume,
reloads the controller, checks that startup confirms pause, and retries explicitly.
A second approved artifact changes a harmless configuration variable, adopts a
distinct runtime version, and preserves operator pause. Finally, the app processes an
import after explicit probe resume, and the probe pauses it again.

Evidence files record the controller state directory, deployment versions, migration
hashes, journal state, result rows, replica generations, and pinned runtime images.
The selected [activation evidence](evidence/m11a-activation.json) also records the
controller image. This is combined coordinator/runtime evidence. Real controller
process-kill tests use a persistent runtime stand-in; this Docker probe injects a
lost response and reconstructs a controller object rather than killing its process.
