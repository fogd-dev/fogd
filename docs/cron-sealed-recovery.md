# Experimental recovery on the sealed scheduled runtime

The [sealed recovery receipt](evidence/m11c-sealed-recovery.json) qualifies a stopped
scheduled-app installation on local Linux arm64 Docker with two application fleets.
It covers the release executable from the [signed binding profile](patches/celld-runtime-binding.md),
read-only program files and an independently supplied launch policy. Ordinary cron
upload, CLI restore and retirement remain closed. Other cron lifecycle receipts
retain their own pinned-source scope.

## Reproduce the qualification

Run the [qualification driver](../scripts/cron-sealed-recovery.mjs) with the local
images identified in the receipt and a new private output directory:

```sh
node scripts/cron-sealed-recovery.mjs .fogd/NEW_SEALED_RECOVERY
```

The driver uses loopback ports 8950 and 8951 and private networks
`10.252.235.0/24` through `10.252.237.0/24`. Run one instance at a time with those
ports and subnets available. Its inputs, controller data, logs and full snapshots
are private; keep them under ignored `.fogd` storage. It starts only its own fresh
projects, removes their containers and networks, and retains their volumes.
It does not shut down unrelated installations or delete retained data.

The private image reuses the checked dependency/native base and adds production
source files plus immutable qualification programs. The build audits both added
layers, including their uncompressed digests and allowed paths. It performs no
networked dependency installation or Rust compilation. Source fingerprints cover
the host CLI, qualification helpers, app/build inputs, Compose template and policy
receipts; final verification refuses changed source files.

A short `--smoke` run checks bootstrap and controls only. It does not qualify the
full recovery contract.

## What the full profile checks

The source deploys the ordinary CLI-submitted imports queue app and privately
approves the native Void refresh fixture. The fixture artifact digest is built
and pinned into the qualification image for that run. This pin establishes that
its approved copy matches the run's build; it is not a shipped application release.
The controller checks the input before staging and again before approval. Programs
live in the image, while the controller data volume contains only fixture input,
commands and results. Consumed commands do not stage another approval on restore.
Interrupted staging can fail closed; a single staging execution across interruptions is not qualified.

Backup inventory checks declared root, capability, security and temporary storage
restrictions, along with named-volume destinations and read/write permissions.
Docker reports the sealed `/tmp` restriction in `HostConfig.Tmpfs`; it need not
appear in the ordinary mount list. Both original and already-sealed Node launch
forms must match the independent policy exactly.

The driver runs the [stopped recovery scenarios](cron-recovery.md#recovery-contract)
for an armed timer, a persisted retry and an older timer snapshot. Each fresh
restore remains held for at least 62 VM seconds with native replicas running and
the controller stopped. Controller startup and explicit loss acknowledgment leave
dispatch held through another 62 VM seconds. Guarded status must match direct
native status at held checkpoints. Only a separate resume releases future work;
missed cron occurrences are not a durable backlog.

The retry snapshot also contains accepted queue input with zero attempts. After
explicit queue resume, that same input completes without being resubmitted. Older
recovery demonstrates the loss of later acknowledged inputs and results. Each
restore receives fresh recovery IDs and preserves approval and secret-revision
pins. Physical recovery can replay external effects; applications still need
idempotency and reconciliation.

The full run also checks that ordinary CLI restore and a wrong native digest
refuse the actual scheduled snapshot without creating target resources. Final
postflight compares both retained source installations with their snapshots,
checks persisted target approvals and acknowledgments, and requires all owned
containers/networks absent with all 28 volumes retained.

## Acceptance boundary

Accept evidence only after observing the process's terminal exit code and
inspecting its raw record, shutdown exits, restart counts and runtime logs.
Independently hash the copied approved artifact and verify the observed native
identity signatures using each caller's recorded challenge. The public receipt
records these checks and source hashes; raw snapshots remain private.

Runtime identity does not distinguish a stopped source from its restored clone.
The harness separately enforces that the source stays down before starting each
target. This profile does not establish a global ownership fence, a qualified-runtime
registry, normal scoped admission, other topologies, live backup or crash recovery
of the qualification harness. The complete M11c lifecycle on a selected shipped
runtime remains an admission gate. Handler watchdog results do not establish a
per-worker CPU quota.
