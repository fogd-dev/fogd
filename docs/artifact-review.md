# Review an application release before approval

Use `fogd admin review` to inspect readable artifact copies and compare a submission
with the application's currently active release. The command needs administrator
credentials and only sends GET requests. Downloading and comparing a release does
not run its code or migrations, pause traffic, or approve it.

```sh
node packages/cli/bin/fogd.js admin review SUBMISSION_ID \
  --output /private/reviews/new-release
```

Use a fresh directory under an existing private parent. The CLI refuses existing
outputs rather than overwriting an earlier review. Select the intended controller,
administrator profile and TLS trust as described in the [operator guide](operator-guide.md).
Deploy credentials cannot substitute for administrator access.

## Inspect the copies and comparison

A completed directory contains `review.json`, the submission's readable files under
`proposed/`, and the active artifact under `active/` when one exists. The JSON report
includes the submission ID and digest, current baseline, credential reference and
label, changed file hashes and sizes, declared resources, required secret names,
and migration-file changes. Credential labels identify deploy credentials;
they do not establish a person's identity or provide an actor audit trail.
The changed-declaration index names resource categories that differ and lists
added or removed required secret names; it does not compare secret values.

Read the changed worker/configuration files and SQL in your editor. The report
lists changed, added and removed files; unchanged files remain in the copies but
are counted separately. Its declarations show what each artifact asks for. A first
submission has no baseline, so every proposed file appears as added. Reviewing
the currently active submission compares that artifact with itself.

The CLI checks downloaded bytes against the selected app and digest, validates the
canonical artifact format, and re-reads relevant controller state before publishing
`review.json`. It refuses a changed active release, submission or held-operation
context instead of presenting a completed comparison. Failed downloads or validation
leave their partial private directory for inspection; without `review.json`, the
review did not complete. Choose a new directory to retry.

Keep these copies private. They contain built application code, configuration, assets
and SQL. Operator-supplied secret values are outside submitted artifacts, but an app
author can put sensitive data in their own code or static configuration. The
command does not redact application bytes or make exported copies public-safe.
It does not export administrator credentials, raw controller diagnostics or
materialized private runtime versions.

## Make the approval decision separately

Review the exact proposed digest and any required secret revision through the
authenticated admin interface. Approval remains explicit:

```sh
node packages/cli/bin/fogd.js admin approve SUBMISSION_ID SHA256
```

Required secrets need an explicit [secret revision](m7c.md#secret-contract) as well.
The comparison is a point-in-time aid, not an approval token or a prediction of
admission. Controller state can change after it completes. Approval rechecks its
own admission and migration rules, and pauses new HTTP routing during activation.

Changed migration files describe differences between artifacts, not the live
database schema or a list of SQL statements that will run. Failed activations can
have applied migrations beyond the active artifact. If the report names an
uncertain migration, ownership claim or background hold, inspect that original
operation and the [recorded application state](application-inspection.md) before
deciding. The command does not judge migration safety, code compatibility, external
effects, or runtime health.

The local scenario is
`node scripts/cron-probe/selected/artifact-review.mjs .fogd/review-native-NEW`.
It uses cached images and app dependencies, compares two real Void artifacts,
checks that a proposed SQL insert has no effect before approval, and retains all
qualification volumes. Its scope is the frozen local two-fleet runtime.


The source controller's [administrator decision history](decision-history.md)
records authenticated HTTP approval/rejection decisions. Its runtime release
qualification is separate from the current frozen v5 artifact. The [verified browser comparison](browser-release-review.md) is also implemented
in source; new runtime qualification remains tracked in issue 7.
