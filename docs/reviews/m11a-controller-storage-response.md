# Controller persistence review response

Both the [initial review](m11a-controller-storage-claude.md) and
[follow-up](m11a-controller-storage-final-claude.md) found no blockers in their
reviewed scope. Their important gaps are addressed in the final change.

Deployment state, credential records, immutable secret revisions, and the secret
index now share the controller's guarded writer. A failure blocks queued and later
mutations, including requests authenticated through stale credential memory. Reload
establishes whether revocation or secret replacement committed. Tests cover both
with real metadata files and injected failures after writing.

The original exception remains attached to the coded error. Production also emits
one diagnostic with an OS errno code and recognized syscall, omitting arbitrary
messages, paths, and metadata values. A test verifies the diagnostic occurs once
and that a failing diagnostic callback cannot mask the storage failure. HTTP still
exposes only the generic reload instruction. Cleanup failure cannot replace that
instruction either.

A pre-write submission failure can retain an unreferenced artifact. Startup compares
artifact entries with reloaded deployments, counts their bytes, and exposes IDs in
admin capacity. The page reports them only when present. No automatic deletion is
introduced. First-claim tests distinguish a committed app record, which permits
explicit retry, from an uncommitted record, whose owner remains quarantined.

The recovery guide describes credential records from failed issuance, retained
secret revisions/temporary files, and the limitation when no pre-failure snapshot
exists for an unrecorded first claim. This change does not reconstruct that record,
drain handlers, or qualify real disk-full or power-loss behavior. Queue bootstrap,
approval, and delivery integration remain next.
