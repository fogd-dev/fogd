# M7b: grow a guestbook and move its data

**Implementation specification.** Add R2 attachments to an already deployed native
Void guestbook, preserving its D1 records and resource identities. Export its bounded
logical data profile and restore it into a second empty app. This is not a general
backup tool or a claim of Cloudflare-hosted data migration.

## Resource contract

Allow existing apps to append canonical R2 bindings. Existing R2 bindings cannot be
removed, renamed, or remapped. D1 and Durable Object declarations remain unchanged.
Initial deployments retain the currently supported declaration set. Validate at
submission and again at approval. Show the derived R2 additions to administrators.

Persist the full approved resource declaration before any activation side effect.
It becomes the minimum declaration for future submissions, even if activation
fails or the failed release is rejected. Recovery requires a corrected release
retaining those declarations. No automatic resource rollback, retirement, or slot
reuse belongs in this milestone. Keep the exact-artifact approval boundary.

Validation: reject a pending addition without changing the reservation; approve an
addition without changing prior identities; interrupt publishing/readiness and
restart the controller; reject removal and stale submissions after that failure;
retry explicitly. Existing migration-ledger reconciliation remains authoritative.

## Application and transfer profile

The guestbook begins with messages in D1. A prepared update adds an attachments
table and the Void storage binding. Upload/download use the browser and typed
routes. Store immutable attachment objects before inserting their SQL references;
a failed SQL insert may leave an orphan object, which the logical profile excludes.
Do not describe D1 and R2 writes as one transaction.

Transfer only messages and their referenced attachments, with explicit row/byte
limits, IDs, metadata, object bytes, and SHA-256 checksums. Validate an entire import
before writes. Restore only into an empty destination; use a completion record or
idempotent state checks so an interrupted restore cannot silently produce duplicates
or make a partial dataset look complete. Reject unsupported format versions,
corrupt bytes, duplicate IDs, and missing references. Test exported data against the
restored data, then demonstrate a new post-restore write.

Use app-specific handlers under `/__fogd/`, blocked at the public gateway. The local
operator invokes them from the controller container over the private fleet network.
No public import endpoint or new app-auth system is introduced. This fixture has
no cron, queues, Durable Objects, or external writers. During transfer, stop public
ingress and stop/restart the participating replicas before using the private
handlers, eliminating preexisting requests for this profile. Keep ingress stopped
through validation and restore. This is an explicit local maintenance operation,
not an online snapshot guarantee or the installation backup contract planned in M8.

Validation: upgrade an existing app with retained messages, upload and download an
attachment, export while quiescent, restore to an empty second app, compare rows
and attachment bytes, reject invalid/nonempty restores, and verify both apps after
restart. Public access to transfer handlers must fail. Keep the normal Void build
and existing smoke tests passing. Record any narrower qualification or remaining gap.

## Implementation qualification

The original specification above is retained as the review baseline. The
[review response](reviews/m7b-response.md) records refinements and source findings.
The [transfer guide](../examples/guestbook/TRANSFER.md) provides reproduction.

On 2026-10-16, the local Docker smoke passed an existing-app R2 addition with
retained D1 records, browser upload/download, two apps, private logical transfer,
corrupt-input refusal, SQL failure after object writes, identical retry, data
comparison, a post-restore write, and controller/workerd restart. Normal Void and
fogd builds of both fixture versions passed with networking disabled. This is a
bounded fixture qualification, not generic backup or hosted Cloudflare execution.
