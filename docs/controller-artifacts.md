# Controller artifact retention plans

Controller artifact planning reports protected releases and terminal artifacts
with no recorded references. It reads stored files without executing application
code. The planner is implemented in source and requires a server that provides
`/v1/admin/artifacts`. The frozen catalog family does not provide this endpoint;
a new runtime still needs qualification before ordinary installation.

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
  entries and content mismatches stay retained.
- `missing`: deployment records without a physical artifact entry. Missing bytes
  do not contribute to either byte total. A missing terminal release can have an
  empty reason list; its metadata alone cannot reclaim storage.
- `plan`: a digest of the decisions and physical inventory, including file hashes
  and empty directories. It identifies this observation and does not reserve the
  filesystem or exclude another operator.

The byte totals describe artifact files, not allocated filesystem blocks, app data,
MinIO objects, host build copies or backup size. Preview leaves controller state,
quota accounting and artifacts intact. Links and special files cause a fixed
inventory refusal instead of a partial estimate.
Reference matching uses exact deployment IDs as string values or object keys.

The planner shares the controller's mutation queue with approval and upload. It
waits for earlier queued operations to finish. External filesystem writers are
outside that queue. File reads may update access times; no metadata or artifact
content is written.

Operator pins, explicit pruning, interruption recovery, and quota-fill/restore
acceptance remain in the [operator-readiness contract](operator-readiness.md#4-retain-releases-deliberately).
[Host build-copy retention](build-retention.md) has separate commands and evidence.
