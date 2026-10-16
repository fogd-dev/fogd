# M7b review response

The [original specification](../m7b.md), [Claude review](m7b-claude.md), and
[Gemini review](m7b-gemini.md) are preserved. Both reviewers inspected source while
implementation was in progress. Claude completed successfully. Gemini emitted a
substantive review but ended with result status `ERROR`; its findings are treated
as review input, not a successful completion signal. The reported error was
"The stream was interrupted. Please continue the task you were working on."

## Accepted changes

- Validate against reserved resources; display R2 additions against the active
  release. Check compatibility before claiming a slot, then revalidate after
  migration-ledger reconciliation.
- Reject generated storage names longer than 64 characters and unsupported nested
  storage settings before reservation. Test these failures.
- Test migration failure, rejection of a failed release, and corrected submission
  retaining its approved binding. A stale approval is refused without changing the
  pending request to rejected.
- Use native middleware for transfer endpoints. Void ignores underscore-prefixed
  route directories; the first live test reproduced their 404 response.
- Require an ingress-stripped maintenance header as a second barrier.
- Bound objects and encoded snapshots; validate bytes against SQL checksums.
  Claim the digest before object writes, permit identical retries, and commit
  rows/completion in one SQL batch. Inject a SQL failure after R2 writes to verify
  rollback and recovery.
- Stop all public ingress and gracefully restart participating replicas. Verify
  both versions and health. Check active, nonquarantined, reconciled controller
  state before private transfer.

## Scope decisions

Resource additions seen by Claude were new uncommitted M7b work, not previously
shipped behavior. The original spec therefore remains an implementation spec.

R2 ordering is not an identity requirement. Reordering declarations remains
allowed; a new deployment digest is expected for any changed artifact.

UUID object keys remain stable across transfers and existing objects are checked
by digest. Content-addressed deduplication is unnecessary for this fixture.
The cap is deliberately smaller than the reviewers' suggested 4–8 MiB range.

The versioned logical profile defines schema compatibility. It does not transfer
migration filenames: separately generated compatible schemas can have different
migration names. Broader schema evolution requires a new profile or explicit
conversion. Middleware keeps schema logic in the app; a generic operator-only
SQL/R2 exporter would duplicate that schema knowledge outside it.

## Implementation review

[Gemini](m7b-code-gemini.md) and [Claude](m7b-code-claude.md) both completed the
implementation review successfully and reported no blockers within the fixture's
exclusive-operator/no-background-writer constraints. Claude suggested three small
improvements:

- Return a bounded-profile error from export instead of an uncaught validation
  exception. Accepted: export returns 409 with limits and required object validity;
  row overflow fails before reading objects.
- Document how to abandon a claimed destination. Accepted: use a fresh app on an
  unused slot or another disposable installation. In-place cleanup remains unsupported.
- Harden against manual deletion of the pending receipt during restore. Deferred:
  that requires an out-of-contract concurrent operator mutation. The receipt is
  persisted before R2 writes and normal interruption preserves it. Documentation
  explicitly prohibits deleting it; there is no supported reset endpoint.

The final checks also exercise the transfer command twice using the same snapshot
file and verify downloaded attachment bytes after controller/workerd restart.
