# Stopped app archival commands

Qualified runtime selection gates the archive command interface. The catalog
lists `celld-archive-v9-linux-arm64` as a closed candidate; ordinary archive
admission remains unavailable. These commands refuse ordinary families that lack
the protocol and provide no candidate override. The private native checks exercise
command composition with an independently supplied candidate.

## Command reference

`fogd archive plan` reviews a verified stopped snapshot without contacting Docker
or allocating a target:

```sh
fogd archive plan SNAPSHOT \
  --app APP --digest ARTIFACT_SHA \
  --project NEW_PROJECT \
  --runtime FAMILY --expected-identity SOURCE_ID_SHA \
  [--network-plan NETWORKS_JSON]
```

`fogd archive` recomputes that review and requires its exact `plan` SHA before
runtime verification, fencing or allocation:

```sh
fogd archive SNAPSHOT \
  --app APP --digest ARTIFACT_SHA \
  --project NEW_PROJECT --output NEW_DIRECTORY \
  --runtime FAMILY --expected-identity SOURCE_ID_SHA \
  --expected-plan REVIEW_SHA \
  [--network-plan NETWORKS_JSON]
```

All placeholders above require values from the selected installation, artifact and
review. `SOURCE_ID_SHA` comes from an independently recorded installation identity,
not from trusting the snapshot to select itself. `FAMILY` must be qualified and
implement the archive protocol. Network placement uses the same regular JSON file
format as stopped durable recovery.

The source installation and its recovery relatives must remain stopped. The target
uses fresh storage and stays stopped after completion. Archival reserves the app's
name, retains data and artifacts, and releases one logical fleet assignment only
after verified target enrollment. It deletes no source volume or snapshot and
reclaims no disk bytes.

The JSON result reports the archive ID and identity, application lifecycle state,
held execution and output directory. Keep the output directory's `app-archive.json`:
its `target.identity` records the new installation identity independently of a later
snapshot. An unconfirmed operation is not a completed result. Retain its records,
partial output and all resources; inspect the original outcome before another
operation. Do not clear markers or replay it automatically.

## Restoration reference

Restoration needs a current snapshot containing the archive record and the archive's
original retained snapshot. Keep that original snapshot even after later whole
installation backups. The current snapshot governs credentials and current vault
records; restoration does not fall back to the retained source vault.

```sh
fogd archive restore plan CURRENT_SNAPSHOT RETAINED_SNAPSHOT \
  --archive ARCHIVE_ID --archive-identity ARCHIVE_ID_SHA \
  --slot slot-2 --project NEW_PROJECT \
  --runtime FAMILY --expected-identity CURRENT_ID_SHA \
  --retained-identity RETAINED_ID_SHA \
  [--network-plan NETWORKS_JSON]
```

Execution uses the same arguments, omits `plan`, and requires a fresh output path
and the restoration review's SHA:

```sh
fogd archive restore CURRENT_SNAPSHOT RETAINED_SNAPSHOT \
  --archive ARCHIVE_ID --archive-identity ARCHIVE_ID_SHA \
  --slot slot-2 --project NEW_PROJECT --output NEW_DIRECTORY \
  --runtime FAMILY --expected-identity CURRENT_ID_SHA \
  --retained-identity RETAINED_ID_SHA --expected-plan REVIEW_SHA \
  [--network-plan NETWORKS_JSON]
```

The selected fleet must be unassigned. The two-fleet protocol accepts `slot-1` or
`slot-2`. Restoration consumes one assignment and returns `archive-recovery-pending`.
Explicit installation startup, exact owner recovery approval and separate HTTP or
background recovery controls are still required. These commands approve no code,
acknowledge no background loss and resume no execution.

## Owner recovery commands

`fogd admin archive` reads and approves pending recovery on the selected running
controller. It requires owner credentials and normal TLS trust. Save a review to
a new private file before approval:

```sh
fogd admin archive APP review --output original-review.json
fogd admin archive APP approve --review original-review.json
```

The review file binds the controller endpoint, app, archive and exact release
selection. Approval submits that saved review without refreshing it automatically.
Review files use mode `0600`; an existing output file refuses replacement. Changed
selections or controller review context require another explicit review. Changing
the selected endpoint refuses before HTTP.

If the original secret pin is unavailable or needs replacement, stage values from
standard input using the original review, then obtain and approve a rotation review:

```sh
fogd admin archive APP secrets --review original-review.json < values.json
fogd admin archive APP review --rotation --output rotation-review.json
fogd admin archive APP approve --rotation --review rotation-review.json
```

The input is a JSON object mapping secret names to nonempty strings. Staging prints
only the revision ID and names. Rotation uses the current controller vault; it
does not recover missing values from the retained source vault. Review and approval
output omit secret values and private runtime versions.

Approval leaves execution held. For a background app, its exact recovery
acknowledgment restores HTTP while leaving queue delivery or cron dispatch paused.
Background execution requires a separate resume. For an HTTP-only app, use the
routing resume command. An interrupted, malformed or lost mutation reply reports
uncertainty and is not retried automatically. Inspect current recovery state and
saved owner decisions before another action. Retain partial-operation records and
markers.

## Review fields

Each versioned review binds the operation, independently selected runtime, source
snapshot hashes and identities, app/deployment/digest, target project and network
selection. Restoration also binds the archive ID/identity and target fleet.
Generated archive IDs, timestamps and new recovery gate IDs are not reservations.
Changing the reviewed intent or snapshot bytes refuses execution.

`capacity.plannedFleetSlotDelta` is `1` for archival and `-1` for restoration.
Availability is conditional on verified target completion; live availability remains
unknown. Each source's `archiveMemberBytes` counts verified snapshot members,
including image and controller archives. It is not logical app data or physical
disk reclamation. `appDataBytes` remains unknown and `diskBytesReclaimed` is zero.
Snapshot reviews do not include writes made after those snapshots. Queue expiry is
not extended; scheduled hold revision and prior recovery history remain preserved.

Reviews omit vault values and revision IDs, credentials, native node identities,
bucket namespaces and raw configuration. Live source status, cached images and
target availability are explicitly unobserved during planning. Execution verifies
those boundaries through the stopped coordinator; a review is not a lock.

The [lifecycle contract](https://github.com/fogd-dev/fogd/blob/main/docs/application-lifecycle.md) records acceptance boundaries.
Default cron admission stays closed, and public archive release remains gated on
fresh release acceptance for the archive runtime and matching host CLI. The
lifecycle contract links the bounded native command interruption/concurrency checks.
