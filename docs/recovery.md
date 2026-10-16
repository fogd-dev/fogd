# Back up and restore a local fogd installation

Use `fogd backup` to stop the supported Docker stack and capture its complete state.
Use `fogd restore` to recover that snapshot onto fresh volumes with the same images.
This procedure needs exclusive operator access and enough disk space for the bucket,
all replica disks, controller state, and exported images. It qualifies replacement
on the local Docker environment, not cross-version upgrades or live backups.

## Create a snapshot

Run from the fogd checkout with the same configuration used to start the installation:

```sh
pnpm exec fogd backup .fogd/snapshot-01
```

The destination must not exist. The command verifies the running configuration,
stops ingress and approvals, stops the replicas together, then stops MinIO. It
copies every named volume and the exact images. Success writes `manifest.json` last
and leaves the source stopped. The manifest records checksums, timing, and container
exit codes. Replica kill/OOM exits indicate crash recovery rather than a clean shutdown.
Gateway exit status does not describe durable-state recovery. A failed backup also leaves the installation stopped; inspect the
failure and use a new destination for another attempt.

To resume the original installation explicitly:

```sh
docker compose start
```

A changed Compose file or environment can make the inventory differ from the
running containers. Restore the original settings before retrying backup; do not
change replica IDs, bucket prefixes, or credentials to bypass the check. Docker
command diagnostics are withheld because they can contain credentials. An operator
can inspect `docker compose config` privately to diagnose configuration errors; do
not paste its output into logs or issue reports. Container stdout logs are not
included; the preserved logs are celld durable recovery logs.

## Restore to fresh storage

Keep the source stopped while using the same published ports and app hostnames:

```sh
pnpm exec fogd restore .fogd/snapshot-01 --project fogd-restored --output .fogd/restored-01
docker compose -f .fogd/restored-01/compose.json -p fogd-restored up -d --pull never
```

Only run the start command after restore reports success and writes `restored.json`.
The output directory and Docker project must be new. Restore refuses existing
containers, volumes, or networks rather than overwriting them. It verifies all
archives before creation, loads the recorded images, restores stopped volumes,
then compares their contents against the original archives. A failed restore leaves
its new resources stopped. Inspect them and choose a fresh project/output directory
for another attempt. Do not start a partial restoration.

The generated Compose file is private and self-contained. It preserves node names,
peer addresses, app routing, bucket prefixes, secret revisions, and platform
credentials while assigning new physical volumes and networks. It pins image IDs,
omits build instructions, and disables pulls. The restored bucket is independent
of the original. This procedure does not support running both copies at the same
application origin simultaneously.

Continue using the same deploy/admin endpoint and credentials. For subsequent fogd
operations against the generated Compose file, select both its file and project:

```sh
FOGD_COMPOSE_FILE="$PWD/.fogd/restored-01/compose.json" COMPOSE_PROJECT_NAME=fogd-restored pnpm exec fogd backup .fogd/snapshot-02
```

An interrupted approval returns as failed and requires explicit retry with its
original digest and pinned secret revision. A snapshot restores the state at its
stopped boundary; changes made after the source resumes are not included.

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
