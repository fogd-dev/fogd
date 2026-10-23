# Back up and restore a local fogd installation

Queue apps use the [queued recovery protocol](queue-recovery.md):
backup pauses delivery and restore requires explicit recovery acknowledgment.
The [bounded Docker queue profile](queue-admission.md) requires explicit opt-in.

Scheduled-work recovery requires the qualified selected runtime and its
[independent installation policy](runtime-selection.md). The [M11c acceptance](m11c-acceptance.md)
covers held same-version local Linux arm64 two-fleet Docker recovery, including due
timers, pending retries and an older snapshot. Default installations keep cron
admission closed. Earlier [experimental recovery receipts](cron-recovery.md) retain
their original source and runtime scope.

Use `fogd backup` to stop the supported Docker stack and capture its complete state.
Use `fogd restore` to recover that snapshot onto fresh volumes with the same images.
This procedure needs exclusive operator access and enough disk space for the bucket,
all replica disks, controller state, and exported images. It qualifies replacement
on the local Docker environment, not cross-version upgrades or live backups.

For selected installations, `fogd backup DIRECTORY --installation PROJECT` reads
the enrolled configuration directly. Use the recovered project name for later
backups and `fogd tls import CERT KEY --installation PROJECT` while stopped;
the original operator profile can still name the stale source. These explicit
commands refuse missing enrollment or storage. Keep `FOGD_SERVER` and client TLS
trust pointed at the intended installation for background controls. The
[operator guide](operator-guide.md) connects enrollment, maintenance and recovery.

## Create a snapshot

From the operator directory, retain the installation's `FOGD_HOME`, private operator
profile and TLS trust. The examples use an enrolled project named `my-cloud`:

```sh
node packages/cli/bin/fogd.js backup /private/backups/snapshot-01 --installation my-cloud
```

The destination must not exist. The command verifies the saved configuration,
stops ingress and approvals, stops the replicas together, then stops MinIO. It
copies every named volume and the exact images. Success writes `manifest.json` last
and leaves the source stopped. The manifest records checksums, timing and container
exit codes. Replica kill/OOM exits indicate crash recovery rather than a clean
shutdown. Gateway exit status does not describe durable-state recovery. A failed
backup can leave the installation stopped or background work paused; inspect the
failure and use a new destination for another attempt.

Resume the same enrolled installation with:

```sh
node packages/cli/bin/fogd.js up --installation my-cloud
```

Background delivery and dispatch can remain paused after backup; use their
respective status and explicit resume commands. Starting containers does not
remove an operator pause or acknowledge recovery findings.

A changed configuration can make the inventory differ from the containers. Retain
the original settings; do not change replica IDs, bucket prefixes or credentials to
bypass the check. Docker command diagnostics are withheld because they can contain
credentials. Inspect configuration locally without pasting it into logs or issues.
Container stdout logs are not included; the preserved logs are celld durable
recovery logs.

## Restore to fresh storage

Keep the source and all related copies stopped, including copies on other hosts.
Keep the same `FOGD_HOME` so the CLI retains its local recovery relationships.
Use the recorded source installation identity and the same qualified family:

```sh
node packages/cli/bin/fogd.js restore /private/backups/snapshot-01 \
  --project my-cloud-recovered --output /private/fogd/recovery-01 \
  --runtime celld-cron-v2-linux-arm64 --expected-identity RECORDED_SHA256 \
  --network-plan /private/fogd/recovery-networks.json
node packages/cli/bin/fogd.js up --installation my-cloud-recovered
```

Choose unused recovery subnets using the [network-plan format](operator-guide.md#choose-private-subnets-when-needed).
The option can be omitted when Docker can allocate suitable networks; source subnet
settings are not reused in that case. The new
project and output directory must not exist. The source identity is the digest
recorded at enrollment, not the software-transfer manifest hash. Selected recovery
requires cached, verified catalog images; import the matching software package
separately if they are unavailable. It does not assemble or pull replacements.

Wait for restore to report success before starting. The CLI fences incomplete
restoration against startup; retain partial outputs and stopped resources for
inspection. Do not start partial containers manually. Restore refuses existing
resources, verifies the snapshot before creation, restores fresh stopped volumes,
then compares their contents against the archives. A failed restore leaves its
new resources stopped. Choose a fresh project/output directory for another attempt.

The canonical recovered configuration lives under
`FOGD_HOME/.fogd/installations/my-cloud-recovered/`; `--output` contains a recovery
copy. It preserves logical identities and private settings while assigning new
physical volumes and networks. Images remain pinned. The restored bucket is
independent of the original. Running both copies at the same application origin
is outside this procedure.

Point `FOGD_SERVER` and client trust at the recovered endpoint, using the operator
credentials and certificate trust from that recovery point. The original
operator profile can still name the source, so select the recovered project
explicitly for later maintenance:

```sh
node packages/cli/bin/fogd.js backup /private/backups/snapshot-02 --installation my-cloud-recovered
node packages/cli/bin/fogd.js tls import /private/server-chain.pem /private/server-key.pem \
  --installation my-cloud-recovered
```

An interrupted approval requires an explicit retry with its original digest and
pinned secret revision. Queue and scheduled recovery also require inspection,
acknowledgment of the current findings and a separate resume. Restoring an older
snapshot restores its application access, deployment credentials and secret
revisions: later revocations and rotations are not merged. Keep endpoint access
restricted while reviewing and revoking restored credentials. Changes made after
the snapshot boundary are absent.

## Unenrolled checkout installations

The older checkout path uses its operator profile and Compose template rather than
an enrolled selection. It remains separate from the selected-family commands above.
Existing enrollment, orphaned project networks or a local image tag resolving to a
catalog image can refuse legacy fallback. Keep the resources stopped on refusal;
do not remove policy/enrollment records or retag qualified images to force startup.
From that checkout, with the same settings used to create the stack:

```sh
node packages/cli/bin/fogd.js backup .fogd/snapshot-01
```

For an unenrolled snapshot, restore onto a fresh project and start its generated
configuration only after restoration reports success:

```sh
node packages/cli/bin/fogd.js restore .fogd/snapshot-01 --project fogd-restored --output .fogd/restored-01
docker compose --env-file /dev/null -f .fogd/restored-01/compose.json -p fogd-restored up -d --pull never
```

This path loads the snapshot's recorded images. For later backup, select its exact
configuration and project through the profile overrides:

```sh
FOGD_COMPOSE_FILE="$PWD/.fogd/restored-01/compose.json" COMPOSE_PROJECT_NAME=fogd-restored \
  node packages/cli/bin/fogd.js backup .fogd/snapshot-02
```

Do not use these raw Compose commands for an enrolled family or an unfinished
selected restoration. Selected installations use `up --installation PROJECT` and
retain their independent policy and restoration fence.

## What the bundle contains

| State | Why recovery needs it |
| --- | --- |
| MinIO volume | Deployment objects, ownership records, database/object state, and fleet metadata |
| Every replica volume | Node identities and durable logs, including acknowledged writes not yet represented by a bucket-only copy |
| Controller volume | App ownership/routing, immutable artifacts, migration evidence, approvals, and private secret revisions |
| Resolved Compose configuration | Credentials, hostnames, bucket prefixes, replica IDs, peer addresses, and operating settings |
| Exact runtime and bucket images | Recovery uses the same implementation, independent of mutable local tags |

The bundle contains plaintext credentials and application data. Its files and
directory use private owner permissions. Protect copies and transport appropriately;
checksums detect corruption but do not authenticate an attacker-replaced bundle.
Only restore trusted operator-created bundles. External buckets, bind mounts,
external volumes/networks, and concurrent writers are refused or outside this
contract. No encryption vault, automatic scheduling, or retention policy is supplied.

## Run the recovery drill

Stop any fogd installation using the configured ports. From the checkout root:

```sh
COMPOSE_PROJECT_NAME=fogd-m8-drill node scripts/installation-recovery.mjs
```

Use a new project name for each run. The drill creates accounts and notebook, writes
D1/R2/Durable Object data, creates an app session, interrupts approval, force-stops
the notebook replicas, snapshots the installation, and restores a fresh project.
It checks data and session recovery, explicit approval retry, subsequent writes,
and refusal to restore over occupied resources. It prints measured snapshot and
restore durations. The restored drill stack remains running for inspection; the
source remains stopped. See [the report](report.md) for observed results and limits.

## Validated local layout

Recovery derives its inventory from matching controller and gateway fleet
declarations. It currently accepts two or three ordered local fleets with distinct node
identities, disjoint bucket prefixes, expected volume mappings, and matching
network membership. Custom service addresses, extra writers/networks, crossed
replica volumes, and other fleet counts are refused. Configuration checksums are
verified before a bundle configuration determines its required archives.

In particular, `FOGD_SLOT_N_A_HOST`/`FOGD_SLOT_N_B_HOST` overrides that change the
local service addresses are not accepted by recovery. Prefix segments accept
letters, digits, underscores, and hyphens separated by `/`; prefixes cannot
contain each other. Distinct nonempty `_ID` overrides remain supported. These
checks tighten the older backup preflight; do not treat arbitrary Compose
customization as a qualified recoverable installation.

## Recover from a controller metadata write failure

A failed deployment-state, credential, or secret-metadata write may already have
committed its rename. The controller
therefore stops further mutations until a fresh process reloads durable state.
Authenticated admin and deploy APIs return 503 with a restart instruction; internal
routing reports existing apps paused. Authentication still applies. Artifacts remain
on disk because a possibly committed submission may reference them.

Restore backing-storage availability, then restart the controller using the same
installation configuration and volume. Do not delete `state.json`, artifacts, or
ownership records to bypass the failure. Re-open the admin view and inspect the
reloaded deployment status. An interrupted activation requires explicit approval
retry; an activation whose final write committed may already be active. A submission
whose write did not commit can leave an unreferenced artifact, which still counts
toward disk use. After reload, `fogd admin capacity` reports those entries in
`unreferencedArtifactIds`, and the admin page shows their count. This path does not
automatically collect files; review them during stopped maintenance. New approvals [persist ownership reservations](ownership-claims.md) before claiming
the bucket, allowing explicit retry after interruption. A verified unclaimed
reservation can instead be rejected. Legacy owners without recorded intent remain
quarantined: use [Restore to fresh storage](#restore-to-fresh-storage) with a matching
pre-failure snapshot rather than manually reassigning their namespace.

Stopping controller writes and new HTTP routes does not stop existing handlers,
Durable Object alarms, or other background work. It is not a drain. If the storage
fault affects the wider installation, use the complete stopped recovery procedure
with matching bucket, replica, and controller state.

Tests inject failures before a migration-intent write and after a submission write
has completed, using the real metadata writer. They verify artifact preservation,
blocked queued mutations, no further error-path migration effects, API unavailability,
and successful explicit retry for recorded apps after a fresh controller loads the
saved state. Credential-revocation and secret-index ambiguity use the same guard.
The underlying persistence error remains attached as the exception cause for
in-process diagnosis. The controller also logs one errno/syscall diagnostic when
the guard activates, without the arbitrary error message or filesystem path. HTTP
responses omit private diagnostics. Cleanup failures cannot mask the reload error.
These tests
do not establish behavior under a real disk-full incident or power loss.

After a failed credential issuance, review the reloaded credential list and revoke
its record before issuing a replacement token. The original token may never have
reached the caller. Unreferenced secret revisions and temporary files can also
remain in protected controller storage; this procedure does not collect them.
