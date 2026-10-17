# M9b design review response

Claude's [review](m9b-design-claude.md) found three restore hazards: local-path helper
placement can make fleet anti-affinity unsatisfiable, applying desired replicas can
start writers before restoration, and mutable local image tags can select different
code. Accept all three corrections.

Restore creates explicit PVCs and helpers before any stateful writer. Helpers use
node affinity selected from the recorded source placement, with each fleet's two
ordinals assigned to different available worker nodes. Verify that placement before
archive extraction. Apply StatefulSets only with replicas zero and leave startup
explicit. No force deletion, namespace deletion, or PVC deletion belongs in recovery.

Verify local and node image config IDs against the snapshot before target namespace
creation. Missing images may be loaded from the complete archive only after verifying
it; conflicting existing tags are refused instead of overwritten. Recheck every node
before allowing writers. Remote registry images remain outside this adapter.

A helper's archive checksum must match the locally received bytes; a successful exec
exit alone is insufficient evidence of a complete stream. Helpers have explicit
lifetimes, restart Never, and read-only source mounts. Reject every unexpected pod
or writer, including Terminating pods. A directory without manifest.json remains an
incomplete snapshot; completion is written last after archive checks and fsync.

Use the generated desired manifests for a pre-stop kubectl diff and capture live
private configuration separately. The Kubernetes format owns its own inventory and
validation; reuse only general stream/checksum/file helpers from Docker recovery.
Keep implementation split by inventory, archive handling, backup, and restore so the
adapter remains reviewable rather than becoming one large command function.

The snapshot represents the installation after every writer stopped. It excludes
writes made after the source later restarts; abrupt stops retain the same upstream
crash-recovery limits as the runtime. Describe that boundary directly rather than
implying a live snapshot or asserting an untested recovery-point guarantee.

## Implementation review amendments

The [code review](m9b-code-claude.md) found three missing defenses. Restore now
requires an empty claim before extraction and restricts PVC specifications to access
mode, storage class, and requested storage; it cannot select an existing PV through
snapshot metadata. Tar comparison uses numeric ownership.

Backup validates the image archive's own tag/configuration mapping and configuration
hashes before completion. Restore repeats that validation before Docker load. Both
legacy Docker metadata and the OCI index must contain exactly the recorded tags;
OCI descriptor/configuration hashes must agree. Conflicting local/node tags are
refused. Running pod image identity is checked through containerd's immutable import
index and its selected image configuration, because kind's displayed imageID can
refer to a multi-image import rather than a config digest.

A pod watch is established before stopping writers. It records terminated exit
codes/reasons for the expected pod UIDs; missing terminal observations remain unknown.
Nonzero or unknown stateful exits flag crash-recovery requirements. The stateless
gateway's known wrapper exit 1 stays in evidence but does not imply durable-state
loss. started.json records the attempt; stop.json records quiescence and observed
outcomes. manifest.json remains the sole completion marker and covers those files.

The first full recovery drill passed. Additional live checks refused corrupted
archives before namespace creation, refused an extra writable PVC consumer before
stopping, and timed out when a node disappeared during shutdown without force
removal or a completion manifest. After node recovery, source and restored namespaces
served distinct data. The reviewed rerun adds empty-disk, archive-identity, and stop
observation evidence. Occupied-target refusal also compares resource identities and
versions before/after.

Backup currently requires the complete live source inventory. An already-stopped
or partially stopped installation must recover its nodes and restart in documented
order before a fresh backup attempt; automatic snapshot resumption is not supported.
This preserves evidence of the code actually running before shutdown. Failure never
automatically restarts writers. Helpers and archive commands have a 15-minute ceiling;
large-volume qualification remains open and a timeout leaves an incomplete snapshot.

## Final review

Claude's [final review](m9b-final-claude.md) found no remaining blockers. Accept the
small hardening notes: a whitespace-only find result still means a claim is nonempty,
and archive image references must not begin with an option marker. Regression
checks cover both. Stop-watch cleanup also escalates to SIGKILL after five seconds
if kubectl ignores ordinary termination.

Uncertain stateful exits intentionally permit a completed physical snapshot with a
warning. Completion proves the stopped archive inventory and byte checks; it does
not certify graceful shutdown or upstream crash recovery. Read-only helper access
can fail on restrictive foreign-UID files, leaving an incomplete snapshot. The
current pinned fixture passed; arbitrary filesystem layouts are not qualified.

The final reviewed negative drill passed on October 17 with the local CA configured:
corrupt archive refusal before namespace creation, occupied-target identity/version
preservation, foreign writer refusal before stopping, interrupted node termination
without a completion marker, and distinct data in source/restored namespaces after
restart. All seven source pods returned Ready. The suite passed 61 tests before the
subsequent capacity slice added its tests; example builds and quality gates passed.
