# Review a release in the browser

The source controller provides verified release comparisons and separate approval
controls at `/admin/review/SUBMISSION_ID`. This implementation is part of
[issue 7](https://github.com/fogd-dev/fogd/issues/7). It is absent from the frozen v5
runtime and prepared `0.1.0` artifact. The closed
`celld-approval-v6-linux-arm64` candidate has
[native browser evidence](evidence/operator-native-browser-review-v6.json), including
SQL, serving and restart checks. Broader runtime acceptance remains pending before
ordinary release availability.

## Inspect the exact proposal

Open the authenticated approval dashboard and follow **Review verified comparison
and decide** for the intended submission. Check its app, submission ID, digest,
active baseline and selected secret revision. The dashboard links to reviews
instead of offering direct approval buttons.

The controller verifies canonical artifact bytes and their digests for the
proposal and any active baseline. Reading the review runs neither app code nor
SQL. Missing, pruned, linked, oversized, changed or inconsistent artifacts cannot
produce a verified comparison or its decision controls.

The comparison lists added, changed and removed files with whole-file SHA-256
hashes and byte sizes. Select a path for before/after text; use **All verified
files** to inspect unchanged code too. Large text is paged and can overlap at
character boundaries. Binary contents are not rendered. The authenticated
artifact manifest remains available for byte verification against the displayed
digest. File previews require the same review context; a stale preview asks you
to reload the selected submission.

Resource declarations, required secret names and migration-file identities are
compared separately. A file difference is not a live SQL schema comparison or a
prediction of statements that will run. Failed activations can retain resources
and applied migrations beyond the active artifact. Submission and exact approval
keep their authoritative checks.

## Make a separate decision

Review the recorded application state before choosing approve, retry or reject.
The page distinguishes deployment status, HTTP routing, quarantine and uncertain
migration metadata. Runtime readiness and business outcomes remain unassessed;
`active` is a recorded deployment status, not a generic health verdict.

Approval controls carry the displayed submission, digest, selected secret
revision and an opaque review-context guard. Both approval and rejection require
that context and revision to remain current. Guarded decisions reverify artifact
bytes before effects. Changes to the selected app, baseline, relevant secret
revision or controller instance require reloading that exact submission. Another
app's decision does not invalidate an otherwise unchanged review. Queue/HTTP
replacement approvals retain their explicit predecessor identity and existing
hold restrictions.

Required secret values must be configured before approval; the button stays
disabled when its selected revision is unavailable. Failed activation retries
retain their pinned revision. The page shows revision identifiers and required
names, never operator secret values or materialized runtime versions.

A stale, refused or interrupted response does not silently select another
submission or retry. Inspect the current app and [decision history](decision-history.md)
before acting again. A refusal can happen after viewing because capacity,
startup, ownership and runtime checks remain authoritative. Existing explicit
CLI/API decisions retain their exact-digest workflow; the browser uses the
additional contextual guard.

## Keep review data private

Artifact text is escaped and displayed as text, including HTML, scripts and SQL.
Artifacts can contain sensitive literals supplied by their author; this viewer
does not redact authored code or assets. Administrator authentication, existing
CSRF/origin checks, no-store headers and content security policy remain in force.
Ordinary browser projections withhold raw activation/quarantine diagnostics, and
failed browser requests show safe guidance instead of raw server errors.

The read-only verifier uses bounded single-link regular files and disposable
private staging, then removes its copies. It never reads materialized private
execution directories or starts the application. Reads share the controller's
existing operation lock and can wait for an ongoing activation. These safeguards
do not establish a global writer fence or reserve application capacity.

The [source validation receipt](evidence/operator-browser-release-review-source.json)
records browser checks, the complete test run and private candidate packaging.
It does not establish native runtime qualification.
