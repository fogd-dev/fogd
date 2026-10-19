# Recover an interrupted first ownership claim

Approval reserves the app's fleet in controller state before claiming its bucket
namespace. The reservation pins the deployment ID, immutable artifact digest, and
configured bucket prefix. It occupies capacity and returns a paused route, even
before a bucket owner exists. An uploaded submission alone does not reserve a slot.

The controller then claims the namespace and persists confirmation before any
migration or publication. Restart never claims or publishes automatically. It
requires the original approval, unchanged artifact, pristine reservation, matching
fleet configuration, and an absent or matching bucket owner. A valid interrupted
request becomes failed and can be explicitly approved again with the same digest
and pinned secret revision.

A pending claim must have no deployment objects. Startup quarantines a reservation
with unexpected publication, and the backend checks again before claiming. Ordinary
updates to an already claimed app retain their existing ownership behavior. Losing
legacy controller metadata without a reservation still causes quarantine.

## Retry or reject

Inspect the failed deployment in the admin view. Retry approval of its original
artifact to finish the claim. Another deployment cannot replace the approved claim
while it is unresolved.

To abandon a reservation, reject that original deployment. The controller first
verifies the pinned fleet configuration, checks that no other configured fleet
owns this app, and confirms that the reserved namespace has neither an owner nor
deployment objects. It then removes the local reservation and records
rejection in one guarded metadata write. The artifact remains for audit. No bucket
objects are deleted. If ownership already exists, finish the original claim before
attempting rejection or the normal retirement workflow. A configuration mismatch
requires restoring the claim's recorded configuration before retry or rejection.

A failure writing either intent, confirmation, or rejection disables further
mutations until restart. Reload determines whether that write committed; do not
infer success or rollback from the failed response. See [metadata failure recovery](recovery.md#recover-from-a-controller-metadata-write-failure).

A timed-out bucket PUT can theoretically land after a later absence check. The
release guard is not a fence against that delayed operation. A late owner can leave
a slot unavailable or quarantined on restart; restore matching ownership evidence
rather than deleting the owner to force reuse. This case is not qualified by the
live probe.

## State compatibility

New reservations add the permanent `fogd-claim-intent-v1` state requirement. It
remains after completion or rejection. Controllers from M10b onward that predate
this capability refuse the state rather than silently downgrading its semantics.
Earlier controllers do not implement this capability check and are unsupported for
this state. Recover with matching snapshot images; do not remove the requirement
to force a downgrade. Running an unsupported older binary and then returning to
a current one can quarantine an app whose old binary ignored its pending claim.
Legacy state without pending claims still loads normally.

The capability check remains in the existing retirement-state validator to preserve
its callers; it recognizes both supported state requirements. Ownership inspection
uses the same controller mutation serialization as approval. Concurrent independent
publishers or manual edits to bucket ownership are outside this contract.

## Qualification

```sh
node --test packages/platform/test/platform.test.mjs packages/platform/test/claims.test.mjs
```

Real-file fault tests cover errors before and after intent and confirmation writes,
lost claim responses, rejection write ambiguity, and mismatched evidence. Subprocess
tests send SIGKILL after intent, after the ownership effect, and after confirmation.
They use a fsynced file-backed backend, not S3, and require explicit retry without
replacing owner identity. They do not establish power-loss durability.

For real MinIO requests, use the disposable installation from the
[queue qualification setup](queue-qualification.md#prepare-a-disposable-installation):

```sh
node scripts/claim-bucket.mjs slot-1 .fogd/claim-bucket
```

The script stages current backend source in an isolated controller directory and
records its hashes. It uses a fresh `qualification/claims/` prefix, retaining its
small test objects and evidence. It verifies repeated claims, foreign-owner
rejection, existing-publication rejection, conditional-create rejection with HTTP
412, and the read-only release guard. The probe refuses overlap with configured
fleet prefixes; its retained objects and temporary source directory belong only
in the disposable qualification installation. It does
not publish an app or run a full Docker controller approval drill. Selected
[evidence](evidence/m11a-ownership-claims.json) records that bounded live check.
