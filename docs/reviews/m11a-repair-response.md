# Queue replacement review response

The [design review](m11a-repair-plan-claude.md) and
[implementation review](m11a-repair-code-claude.md) found no blocking transfer issue.
Both verified that the whole-state journal callback atomically records candidate
approval and hold ownership before runtime effects.

Accepted changes preserve original failure diagnostics, restore unpersisted candidate
metadata and app privacy state, reject conflicting startup hold owners, and prevent
the migration coordinator from overwriting another uncertain attempt. Startup also
checks that an uncertain attempt belongs to the hold owner. Conflict diagnostics
identify the deployment IDs. The UI hides replacement approval when a request's
recorded predecessor differs from the current hold; a new request is required.

The tests cover preflight interruption after newly discovered applied hashes are
saved, pre-intent local failure with a selected secret revision, rejection of the
old artifact after transfer, and SIGKILL before/after transfer intent, effect, and
confirmation. Rejection keeps the old artifact; successful transfer has already
folded its applied hashes into app history. Secret rotation cannot change a pinned
candidate's retry revision.

Two suggested simplifications were not adopted. Preflight retains `prepareQueue`
for a pending bootstrap because it provides the same confirmed-pause path without a
second metadata-only handoff protocol. Bootstrap reads the original compatibility
date and unchanged resource bindings, excluding materialized secret vars. Matching
repair tuples remain retryable after transfer failure because this supports retry
after a lost response. A completed approval is not idempotent; documentation directs
operators to inspect its status if the final response was lost.

The live D1 probe supplements the stand-in tests. The pinned source wraps each file
and ledger insert in a transaction, and the probe confirms an INSERT followed by
invalid SQL rolls back. Earlier files retain their ledger records; modifying their
SQL is rejected; the corrected unapplied file activates through explicit HTTP
replacement approval. Public artifact admission remains closed, and no backup,
retention, destructive-migration, or drain claim follows from this proof.
