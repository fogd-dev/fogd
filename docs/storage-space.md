# Inspect Docker storage space

A local Docker owner can inspect the backing filesystems of an enrolled
installation without starting its services or supplying HTTP administrator
credentials. From the operator directory, retain its `FOGD_HOME` and run:

```sh
node packages/cli/bin/fogd.js storage space --installation my-cloud
```

The command reads the saved enrollment and uses a verified cached catalog image as
a small metadata reader. It works with stopped services and an unfinished
restoration; it leaves startup fences in place. It does not bootstrap an operator
profile, start application code, access app endpoints, or create replacement
storage. It requires the catalog-pinned controller/storage images in the saved
configuration and existing local volumes with matching project and role ownership.
The currently qualified reader family requires Linux arm64.
A missing volume is reported as missing; foreign or unsupported storage refuses.

## Interpret the report

Each configured volume names an observed filesystem or has `state: "missing"`.
Volumes on the same observed device share one filesystem record. Capacity is not
multiplied by the number of volumes. A partial installation returns
`status: "incomplete"`; if every volume is missing, it reports no filesystem space
and starts no reader container.

Byte and inode counters are decimal strings so large values remain exact:

| Field | Meaning |
| --- | --- |
| `totalBytes` | Filesystem blocks multiplied by fragment size when available, otherwise reported block size |
| `freeBytes` | Free blocks, including blocks unavailable to ordinary filesystem users |
| `availableBytes` | Space reported available to ordinary filesystem users |
| `unavailableFreeBytes` | Difference between free and available space |
| `usedBytes` | Total minus free space |
| `availableBasisPoints` | Available fraction in hundredths of a percent; 100 is 1% |
| `totalInodes`, `freeInodes` | Filesystem inode counters |

These are whole-filesystem observations. Other installations, images, logs and
Docker data can consume the same space. The values are neither bytes used by one
volume nor a per-app allocation. `fogd admin capacity` reports controller artifact
quotas separately; free artifact quota does not establish free filesystem space.
On Docker Desktop, the backing filesystem belongs to the Linux engine and can be
nearly full while the host filesystem has much more free space. Distinct device
records do not guarantee independent storage pools; subvolumes can share backing
capacity. Do not add their space counters to estimate physical capacity.

This report supplies no health verdict, admission threshold, or reservation.
Running workloads can change capacity immediately. Free bytes alone do not prove
that the object store will accept writes, replicas can recover, or a backup is
usable.

## Observation boundaries

The reader accesses directory/device and filesystem metadata through read-only
bind mounts of verified Docker volume backing paths. It does not read application
files, receive storage credentials, or use a network. Bind sources must already
exist; the command never falls back to named-volume mounts that could create an
empty volume. The reader has a bounded lifetime and its own nonce identity for
cleanup. An unconfirmed cleanup fails the command.

The volume inventory and Docker engine identity must match before and after the
sample. This detects observed changes; it does not lock storage or create an atomic
snapshot. No files, images, containers belonging to the installation, volumes or
storage thresholds are changed. The command does not prune data or reclaim space.
Use the [stopped recovery procedure](recovery.md) for missing storage rather than
creating empty volumes under its old names.
