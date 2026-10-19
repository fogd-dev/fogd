# Probe queued-work lifecycle behavior

These scripts test the pinned celld runtime directly. They do not enable queues in
fogd or establish Void queue, migration, or approval support. See the
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

## What remains unqualified

These probes do not establish controller activation recovery, D1 migration ordering,
queue addition/removal, native Void queues, long-age retention recovery, retirement,
or safety of arbitrary handler side effects. In particular, `waitUntil` disproves
using queue emptiness alone as a drain. A fixed observation window cannot prove
that no possible later effect exists. The [probe record](m11a-probe.md) distinguishes
runtime findings from the still-rejected fogd application feature.
