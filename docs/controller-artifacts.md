# Controller artifact retention

Controller artifact retention lets owners keep exact releases, review unreferenced
terminal artifacts, and explicitly reclaim their bytes. These commands are
implemented in source and require matching CLI/server support for
`/v1/admin/artifacts`. The qualified v5 family provides baseline artifact retention.
The source correction for retention alongside decision history is packaged in the
qualified [v8 family](operator-v8-acceptance.md). Its
[native check](evidence/operator-approval-v8-candidate.json) records the correction
and retained restart/snapshot results.

The [native candidate drill](evidence/operator-native-artifact-retention.json)
covers quota refusal, exact operator pins, stale-plan refusal, interrupted pruning,
explicit resume and recovery of a retained pre-prune snapshot. It uses a separate
two-fleet Linux arm64 Docker installation with a 2 MiB artifact quota. Ordinary
candidate admission remains closed.

Use the selected installation's administrator endpoint and credentials:

```sh
fogd admin artifacts plan
```

The command makes one authenticated owner request and prints JSON. Deploy tokens
cannot read it. The response excludes artifact contents, private runtime versions,
secret revisions, credentials and raw backend diagnostics. Its fields are:

- `retainedArtifactBytes`: current logical file bytes beneath the controller's
  artifacts directory, including unknown directories and stray root files.
- `reclaimableArtifactBytes` and `candidates`: rejected or superseded releases
  whose IDs and stored content match their deployment records and have no
  protected reference.
- `protectedArtifactBytes` and `protected`: retained artifacts with fixed reason
  codes. Active, pending, failed, activating, retired and unknown releases stay
  protected. Controller metadata references, references from protected releases,
  and their transitive chains protect otherwise terminal artifacts too. Unknown
  entries and content mismatches stay retained. `operator-pin` identifies an
  explicit owner choice to keep that release.
- `missing`: deployment records without a physical artifact entry. Missing bytes
  do not contribute to either byte total. A missing terminal release can have an
  empty reason list; its metadata alone cannot reclaim storage. Completed pruning
  leaves a `pruned` reason on missing history or any artifact bytes that reappear.
- `plan`: a digest of the decisions and physical inventory, including file hashes
  and empty directories. It identifies this observation and does not reserve the
  filesystem or exclude another operator.

The byte totals describe artifact files, not allocated filesystem blocks, app data,
MinIO objects, host build copies or backup size. Preview leaves controller state,
quota accounting and artifacts intact. Links and special files cause a fixed
inventory refusal instead of a partial estimate.
Reference matching uses exact deployment IDs as string values or object keys.
Validated completed administrator decisions retain their metadata without pinning
artifact bytes. `started` and `unconfirmed` decisions still protect their exact
artifact. Malformed or missing required history refuses planning. Explicit pins,
live operations and recovery references retain their existing protections.

The planner shares the controller's mutation queue with approval and upload. It
waits for earlier queued operations to finish. External filesystem writers are
outside that queue. File reads may update access times; no metadata or artifact
content is written.

## Keep an exact release

Use a deployment ID and its artifact digest from the plan or owner inspection:

```sh
fogd admin artifacts keep ID SHA
fogd admin artifacts unkeep ID SHA
```

Keep verifies the stored artifact before saving the pin. The pin protects that
release and its recorded reference chain. It survives controller restart and
travels with controller metadata in stopped backups. Restoring an older backup
restores that backup's pin choices. Source snapshot/restore tests cover this
preservation; independent runtime acceptance remains open.

Unkeep removes the explicit owner pin. Active, unfinished, recovery and other
references continue protecting the release. It can clear retention intent when
artifact bytes are missing or corrupt; it does not repair those bytes or delete
anything. Repeating an unchanged request leaves metadata unchanged.

Pin changes require owner credentials and a fresh CSRF token. A lost or invalid
mutation reply leaves the outcome uncertain. Recover controller access and
inspect a fresh plan before retrying. A metadata write failure requires a restart
to reload durable state before further changes. The CLI never retries a pin
mutation automatically.

## Prune a reviewed plan

Inspect the plan, keep releases you want to retain, then generate a fresh plan.
Supply its exact `plan` hash to prune all listed candidates:

```sh
fogd admin artifacts prune PLAN_SHA
fogd admin artifacts status
```

Pruning recomputes the plan under the controller's mutation queue. A changed plan
refuses before recording an operation or deleting bytes. A matching nonempty plan
records the approved files and hashes durably before removing anything. Removal
checks all targets first and refuses changed contents, links, or unexpected files.
The receipt lists the releases and logical artifact bytes reclaimed. Quota
accounting is recomputed from the remaining filesystem contents.

Deployment records remain available. [Owner inspection](application-inspection.md)
marks recorded pruned releases and reports a pending controller prune without
copying its private file manifest. Artifact review returns HTTP 410 for pruned
releases. Retained app data, host build copies and backup bundles have separate
lifecycles. A pruned release cannot be kept again; bytes that reappear under its ID
stay protected for review.

## Resume an interrupted prune

A pending operation blocks ordinary controller mutations and artifact review.
Existing approved routes remain unchanged. Startup loads the operation without
continuing deletion. Stopped snapshot production and restore validation refuse
pending pruning; complete the operation before taking a new backup.

```sh
fogd admin artifacts status
fogd admin artifacts resume OPERATION_ID
```

Resume uses the persisted approved manifest, checks current reference protection,
and accepts only unchanged approved files that remain. It permits already removed
files and directories. Unexpected or altered contents cause refusal. Resolve an
unexpected filesystem change deliberately; there is no force or cancel command.
A completed resume returns its saved receipt when repeated for the latest
operation. Status retains the latest completion, rather than an operation archive.

A lost, invalid or server-error reply leaves the outcome uncertain. The CLI does
not retry mutations automatically. Recover access, restart after a controller
storage-write uncertainty, then inspect status before explicitly resuming. Avoid
reissuing an old plan after another operation; generate and review a fresh plan.

Pruning adds the required controller capability `fogd-artifact-pruning-v1`.
An older runtime must refuse that state, including completed pruning. Completed
pruning metadata and pins survive source-level stopped restore tests. These tests
also cover process interruption during deletion and metadata write failures.
They do not qualify a native runtime, disk power loss or independent installation.
The controller queue does not fence privileged external filesystem writers.

The native candidate drill reclaims 1,048,479 logical bytes and then admits the
previously refused build. Active and pending artifact hashes remain unchanged.
A Docker-level controller kill leaves a pending prune; startup does not continue
deletion. Concurrent approval and backup attempts while that operation is pending
refuse before changing their protected artifacts or producing a snapshot.

Restoring the retained pre-prune snapshot recovers four exact artifact trees,
including the operator pin and an artifact already pruned at the source. D1, R2
and Durable Object data, new writes and a subsequent approval pass. An initially
uncertain route resume stays withheld; fresh read-only runtime verification precedes
a new exact decision. Its initial verification delay cause remains unestablished.

The [uninterrupted native concurrency drill](evidence/operator-native-artifact-concurrency.json)
starts approval and backup commands after observing partial deletion. All three
commands complete; protected artifact hashes match in the stopped source and its
snapshot. Restoring that snapshot preserves the completed prune receipt, serves the
concurrently approved release, retains D1/R2/Durable Object records and accepts a
new write. Controller mutations remain serialized.

Disk power loss and ordinary runtime-family release remain outside this evidence. The
[operator-readiness contract](operator-readiness.md#4-retain-releases-deliberately)
retains the remaining acceptance conditions.
[Host build-copy retention](build-retention.md) has separate commands and evidence.
