# Queue replacement approvals

An administrator can approve a corrected artifact while retaining the failed
activation's queue hold and migration evidence. Public queue upload admission
remains closed; this recovery path is qualified with privately staged artifacts.

For an existing qualification app, inspect both requests with `fogd admin list`,
review their artifacts, then approve the exact replacement:

```sh
fogd admin repair NEW_ID NEW_SHA HELD_ID HELD_SHA [SECRET_REVISION]
```

The approval page offers **Approve replacement** on a candidate while another
failed request owns its app's hold. The button binds both request IDs and digests,
plus the candidate's selected secret revision, when the page renders. A changed
hold or secret selection requires inspection again.

The existing authenticated approval endpoint accepts the same selection:

```json
{
  "digest": "NEW_SHA",
  "secretRevision": null,
  "replaces": { "deployment": "HELD_ID", "digest": "HELD_SHA" }
}
```

POST this body to `/v1/deployments/NEW_ID/approve` using admin authentication and
the current CSRF token. Ordinary approval cannot take another request's hold.
Deploy credentials cannot repair or approve applications.

## Recovery order

Preflight operates under the original approval and keeps the candidate's code out
of the runtime. It validates both artifacts, resource identities, and candidate
secret selection; establishes pause; reconciles the original uncertain migration
attempt; then compares the candidate against the refreshed applied migration hashes.
A candidate that changes applied SQL is refused even if the controller learned that
SQL had applied only during this reconciliation.

A pending bootstrap may be retried during preflight. It contains platform code,
producer bindings, and D1 definitions. Bootstrap excludes secret vars; the raw
original artifact and its materialized copy provide the same bootstrap inputs.
Once consumer publication has begun, the app's persisted phase forbids bootstrap
replay, including while replacing its first failed activation.

After successful preflight, one atomic controller-state write records the candidate's
approval, selected secret revision, predecessor tuple, and new hold owner. It precedes
the transfer's pause command. The delivery journal retains operator intent and the
last completed runtime version. The candidate then follows ordinary activation:
confirm pause, migrate, publish, verify readiness, and release the hold according to
operator intent. Operator pause survives a successful replacement.

## Interruptions and retries

| Failure boundary | Durable owner | Next action |
| --- | --- | --- |
| During preflight | Original failed request | Correct the problem and repeat replacement approval |
| Before transfer intent commits | Original failed request | Inspect state, then repeat replacement approval |
| After transfer intent commits | Candidate request | Retry that candidate's approval with its pinned secret revision |
| After full activation succeeds but its response is lost | No activation hold; candidate is active | Inspect `fogd admin list`; do not create another deployment merely to retry the response |

Repeating the repair tuple is accepted while its candidate owns the hold and remains
retryable, provided the tuple exactly matches the recorded predecessor. This does
not make a completed approval request idempotent: an already active request refuses
another approval attempt.

Failed preflight preserves the original failure step/error and introduces no new
candidate secret pin. An already pinned candidate retains its revision. Failure
before transfer intent also restores candidate metadata and the app's prior privacy
flag. After transfer, runtime uncertainty retains the candidate's hold. Metadata
write uncertainty stops the controller until restart loads the actual saved state.

Startup refuses conflicting activating records or an uncertain migration owned by a
different request. The error identifies the conflicting IDs. This is inconsistent
controller metadata, not an ordinary queue-availability failure; restore matching
state rather than guessing a hold owner. The migration coordinator also refuses to
overwrite another request's uncertain pointer.

After reconciled transfer, the original request may be rejected. Rejection retains
its artifact bytes, and the applied hashes already belong to the app's migration
history. If the replacement later needs another correction, submit a new request.
A request with a different recorded predecessor cannot be reused to take a later
hold; the page hides that invalid approval option and directs the operator to resubmit.

## Migration evidence and limits

The pinned celld implementation applies each SQL file and its migration ledger row
in one transaction. See `crates/celld/d1_cli.rs:296` and
`crates/celld/storage.rs:3108` at upstream commit
`90b43017241f81189453d326d05948f388b34652`. Failure inside a file rolls back that file,
while earlier successful files remain applied. The live probe verifies an INSERT
followed by invalid SQL leaves no inserted row, then a corrected file inserts one row.

This does not authorize destructive migrations or incompatible queue payloads.
Existing handlers can overlap activation, and pause is not a drain. Resource
identity and queue-policy changes remain outside this recovery operation.

Controller tests cover secret pinning, authorization, stale identities, partial
migration discovery, ambiguous persistence, and real process SIGKILL during preflight
and transfer. Their runtime effects use a persistent stand-in. The Docker probe
`scripts/queue-repair.mjs SLOT EVIDENCE_DIRECTORY` uses real celld/D1 and the actual
HTTP approval handler after staging private artifacts. It requires a never-deployed
fleet and leaves the repaired app's delivery paused. It does not qualify public
queue upload, stopped backup/restore, retention, or retirement.


[Selected evidence](evidence/m11a-queue-replacement.json) records the live image,
resource/migration hashes, rollback assertion, corrected audit row, and source hashes.
The browser proof separately checks that the replacement button posts both exact
identities to the real HTTP handler with a runtime stand-in.
