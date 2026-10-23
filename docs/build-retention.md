# Retain and remove local build copies

Use `fogd builds` to inspect local build copies, keep selected outputs, and remove
reviewed copies of rejected or superseded submissions. This manages host disk use.
Controller artifacts, application data, backup bundles, and controller artifact
quota are separate and remain intact. Nothing is pruned automatically.

The commands cover builds produced by this CLI under its selected `FOGD_HOME`.
Older outputs under `.fogd/releases` are counted and preserved. Unrecognized files,
unfinished builds, and uncertain uploads are preserved for inspection. The [local exercise](evidence/operator-retention-local.json) covers interrupted
operator-command pruning, offline resume, concurrent approval and stopped backup,
subsequent deployment, and fresh-volume restore on the same engine. Full controller
artifact retention and quota-fill acceptance remain open in
[operator readiness](operator-readiness.md#4-retain-releases-deliberately).

## Review and execute a plan

Select the same home, controller endpoint, TLS trust, and administrator credentials
used to operate the installation. Keep the plan outside application build output.

```sh
fogd builds list guestbook
fogd builds plan guestbook --output /private/operator/guestbook-plan.json
```

`list` reads local state and needs no controller connection. `plan` requires the
administrator's current controller view. It writes a new private file and prints
its SHA-256, decisions, reasons, and logical byte counts. Open the plan and review
its selected build IDs and file inventory before executing it:

```sh
fogd builds prune /private/operator/guestbook-plan.json --expected-plan REVIEWED_SHA256
```

Use the SHA printed for the exact file you reviewed. Execution binds that file to
its original home and controller, checks current controller references, and verifies
the selected directory and every file before moving it to private trash. Only the
approved files are unlinked. A changed or unsupported row is refused; other reviewed
rows can still complete. Refused rows produce a nonzero process exit with their
individual results. Re-running an unchanged plan is safe for already absent rows.

Byte counts are file lengths. They do not estimate allocated filesystem blocks or
promise an equal increase in free disk space. Partial deletion can reclaim bytes
before an operation reports completion.

## Keep a build deliberately

Deployment output includes `localBuildId`, which identifies the host copy separately
from the controller's submission ID. Use it to retain a copy:

```sh
fogd builds keep guestbook LOCAL_BUILD_ID
fogd builds unkeep guestbook LOCAL_BUILD_ID
```

A keep marker overrides an earlier plan and is checked under the same per-build
lock as pruning. Unkeep only removes that marker; it does not delete the build.
Once a build has moved into trash, keep refuses: inspect its unfinished operation
before proceeding. Builds for a different controller, uploads without a confirmed
receipt, and active, pending, failed, or recovery-related submissions remain
protected independently of the marker.

## Resume an interrupted operation

An approved deletion saves its inventory privately before moving the build into
trash. The saved operation is local owner-controlled metadata with a checksum;
it is not a remote authorization or a cryptographic signature. Keep the home and
its metadata together.

```sh
fogd builds list guestbook
fogd builds resume guestbook LOCAL_BUILD_ID
```

Resume can finish a build already in trash without the original plan file or a
running controller. It verifies the remaining files against the saved approved
inventory. Unknown or changed trash is preserved. A saved operation whose build
has not yet moved requires a fresh plan and current controller state to start.
A fresh verified plan can replace a prepared inventory while the complete build
remains in cache and trash is absent. Damaged regular journal files move into a
private history directory before replacement; their bytes remain available for
inspection. Unsupported linked metadata still refuses. Pruning leaves the current journal
and lock database in place.

Locks use Node's built-in SQLite and release when the process exits or is killed.
Do not remove lock databases while operations may be running. Retention mutations
support Linux and macOS with a local filesystem and cooperative use of this CLI.
Network filesystems, multiple hosts sharing a home, hostile direct filesystem
mutation by the same user, and power-loss durability are outside this contract.

## Local layout and unfinished uploads

Each managed build has a private container directory holding `artifact/` and
`record.json`; retention markers live beside the artifact. Only artifact contents
are uploaded. Records contain build identity, lifecycle state, content digest, and
an acknowledged submission association. Deploy credentials and application secrets
are not copied into these records or plan metadata. Application artifact files may
contain private code or embedded configuration: keep plans and saved inventories
private too.

If upload confirmation is lost, the copy remains uncertain. Inspect the controller
before retrying deployment. A controller acknowledgment whose local receipt could
not be completed still prints its submission ID; retain the copy and use that ID
to inspect the submission. Do not submit it again merely because local recording
failed. There is no automatic reconciliation or adoption of legacy and uncertain
copies in this increment.

## Repeat the local exercise

From a checkout with the qualified images and existing JavaScript build dependencies
cached, run the probe with a new private output directory:

```sh
node scripts/cron-probe/selected/build-retention.mjs .fogd/build-retention-NEW
```

The probe creates scoped source and restore installations. It archives the disposable
cache copy before removing it, retains backups and volumes, and records source
hashes, process exit evidence, protected-file inventories, live native lease checks,
and observed application data. It neither prunes existing installations nor fills
the controller artifact quota. The [receipt](evidence/operator-retention-local.json)
records the exercised scope and failed attempts as well as the final passing run.

## Controller artifact pruning

Online planning and new prune decisions keep local build copies when the current
controller view reports a pending artifact-prune operation. Complete that operation
before reviewing another host-copy deletion. Completed pruning is a supported
recorded state; otherwise eligible terminal host copies can still be reviewed under
their own retention policy. Malformed controller pruning metadata keeps copies as
unsupported state.

An already-started offline host prune follows its saved approval and does not
observe later controller changes. These source CLI rules preserve the separate
[controller artifact lifecycle](controller-artifacts.md); removing a host copy does
not modify controller artifacts or application data.
