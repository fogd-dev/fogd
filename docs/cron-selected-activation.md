# Scheduled activation on a selected runtime

This local Docker profile checks scheduled activation through the installed
controller, HTTPS admin API and app-scoped CLI deployment on the frozen catalog
image. The [first-activation receipt](evidence/m11c-selected-runtime-activation.json)
and [update-interruption receipt](evidence/m11c-selected-runtime-activation-matrix.json)
cover different checkpoints. The catalog remains a candidate; public enrollment
and ordinary cron admission retain the remaining [M11c gates](m11c.md).

## Run the profile

Use a checkout with the cached dependencies and the catalog's Linux arm64 runtime
and storage images already available. The drivers verify those inputs, enroll a
known candidate internally, create a fresh private installation, import a fresh
localhost TLS certificate and start the installed configuration. They do not
install dependencies, rebuild native programs or pull images.

Run the drivers sequentially, with new output directories:

```sh
node scripts/cron-probe/selected/activation.mjs .fogd/selected-activation-NEW
node scripts/cron-probe/selected/activation-matrix.mjs .fogd/selected-matrix-NEW
```

The output directories contain private operator configuration and diagnostic
records. Each driver isolates its host installation state beneath its output
directory. It chooses unused local ports and private networks; network discovery
is an observation, not an atomic reservation. Sequential setup avoids competing
probes choosing the same subnet set.

The drivers remove only their owned containers and networks and retain every
volume. A failed command or incomplete cleanup fails the run. Inspect its private
records before another attempt; use a fresh output directory and project.

## Activation checkpoints

An external debugger pauses the real controller without replacing its functions.
The driver checks the owned container, image, launch arguments, process-start
identity and running program inventory before attachment. Each breakpoint binds
the loaded script digest, executable location and paused function to the catalog.
The debugger interface excludes evaluation and inspection of secret locals.

The debugger is a privileged qualification tool. It uses the controller's loopback
inspector and is not a public fogd control surface. Native replicas keep running
while the controller is paused. Separate observers read controller storage through
read-only mounts and query native state through the guarded backend.

| Checkpoint | Durable controller state | Independent native check |
| --- | --- | --- |
| Before the first native migration call | Exact approval and secret revision pinned; migration uncertain; dispatch held | Bootstrap manifest has no crons, application tables are absent and the application migration ledger is empty across a minute boundary |
| Application publication returned | Approval remains at `publishing`; dispatch hold retained | Stored application manifest declares the approved schedule; dispatch remains paused |
| Native resume returned | Hold remains; resume operation and unknown observation are durable | Both replicas report the approved version; native dispatch is running |
| Release journal saved, before approval completes | Hold cleared and the approved version recorded; approval still activating | Native dispatch matches the requested running or paused state |

The first migration check permits native SQLite metadata tables. It delays entry
into the application migration call; it does not pause inside the SQL engine.
Publication does not imply replica adoption, so its check reads the stored manifest
rather than assuming the replicas have reloaded it.

At each interruption the driver confirms the intended pause, saves its observations
and asks Docker to kill the owned controller. Exit 137, no OOM termination and a
stopped container are required. The recorded disk state must survive unchanged.
Restart uses ordinary `fogd up --installation PROJECT`. This profile checks explicit
startup after the kill, not automatic restart behavior.

## Retry, pause and private configuration

Restart must expose the interrupted approval and reestablish its hold before an
explicit retry. The first-activation case refuses a changed secret revision and
then retries the original pinned revision. Update cases refuse a different pending
artifact while the original approval owns the hold. Refusal checks require the
expected CLI error and unchanged controller state; a transport failure or timeout
cannot satisfy them.

Held intervals compare complete occurrence and result rows, including attempts and
completion state. Comparing only occurrence keys would miss a leaked retry of an
existing occurrence. The paused update also checks the retry approval and another
minute boundary before explicit resume.

Native resume is already authorized before its durable observation is saved. Jobs
that occur in that interval are recorded as authorized work, not unapproved
execution. These fixture checks do not establish draining or cancellation of
arbitrary in-flight callbacks or `waitUntil` work.

After explicit retry or resume, native SQL observations must show future completed
jobs before the first application HTTP request. Update artifacts put a distinct
release label in their business results and response. The unapproved alternative
must never supply those results.

The privacy check covers admin JSON and HTML, scoped CLI statuses, downloaded
artifact files after base64 decoding, ordinary command diagnostics and the complete
receipt. Application secrets, deploy credentials, admin and gateway credentials,
and both storage credential values must be present in the private test inputs and
absent from those checked outputs.

## Evidence and limits

Each receipt pins its executed host inputs. Both profiles use the same immutable
product image and native programs. The update receipt's `postRunOracleCheck`
identifies an additional packaged-driver assertion replayed against its recorded
native snapshots. Independent audits check recorded control state,
minute boundaries, job timestamps, retained approval state and cleanup. OpenSSL
verifies fresh Ed25519 challenge proofs from all four native nodes and rejects
altered signatures. The active fleet's process keys are also bound to its recorded
leases; the app-free fleet is checked under the bootstrap identity contract.

A separate image read checks the catalog's production source inventory, native
executable and supervisor digests. Runtime signatures and replica observations
retain the [documented trust and lifecycle limits](cron-runtime-policy.md); they
are not hardware attestation or an atomic fence against privileged operators.

Remaining acceptance includes failure and replacement behavior on this product
image, due/pending-retry/older-snapshot recovery, retirement beside active survivors,
ordinary offline builds and the full M11c audit. This activation profile does not
qualify those paths, CPU-exhaustion limits, shared remote operation or public
catalog promotion.
