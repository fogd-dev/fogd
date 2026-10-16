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
