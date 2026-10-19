# Inspect installation capacity

Run `fogd admin capacity` with the same admin credentials and server URL used for
approvals. The admin page shows the slot inventory and admission totals. The command
returns JSON with per-credential pending counts as well.

```sh
FOGD_ENV_FILE=/path/to/installation.env pnpm exec fogd admin capacity
```

The report separates three limits:

| Limit | What consumes it | What does not free it |
| --- | --- | --- |
| App slots | A controller assignment or observed bucket owner | Pausing routes, quarantining an app, or rejecting an update |
| Pending submissions | Pending and failed requests | Waiting; a failed activation requires explicit retry or rejection when permitted |
| Retained artifact bytes | Decoded artifact files, including rejected and superseded releases | Rejecting a proposal or activating a newer version |

A scoped credential also has a pending limit. The legacy local team token only has
the global pending limit. Zero pending submissions can coexist with a full artifact
quota. The [stopped retirement workflow](retirement.md) releases a fleet in a fresh
installation while retaining old data and history. It does not prune artifacts.
Do not manually remove ownership records to manufacture capacity.

Slot rows show cached bucket ownership separately from controller assignments.
Disagreement keeps capacity occupied and can indicate recovery inconsistency.
Bucket ownership is observed during controller startup and claims; reporting does
not query the bucket. Pending submissions do not reserve slots, and approval
rechecks limits. The report cannot promise that a later deployment will succeed.

Artifact accounting excludes application data, secret execution directories,
filesystem allocation, and free disk space. It is not a CPU, memory, or hosting-cost
measurement. More app slots require matching runtime, storage, and network setup;
editing a count alone does not expand the installation.

## Reproduce the checks

`pnpm test` covers occupied and orphaned slots, duplicate bucket ownership, pending
limits, retained bytes after restart, API authentication, escaped page output, and
CLI/API agreement. These are controller and HTTP tests with temporary storage. They
do not measure runtime density or establish remote operational capacity.

## Observe runtime resources

Use the [Docker measurement guide](capacity-measurement.md) for warm memory/CPU
observations and bounded stateful reads. These reports are separate from admission
accounting and do not expand the installation.

For a third app, use [fresh rendering or stopped expansion](expansion.md).
The qualified Docker layouts have two or three fleets; Kubernetes remains at two.
