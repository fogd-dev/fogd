# Diagnose a submitted release

Use `fogd status ID` to see a release's recorded approval progress and a safe
explanation when activation fails. Use the deploy credential that submitted it:

```sh
export FOGD_ENV_FILE=/private/operator.env
node packages/cli/bin/fogd.js status SUBMISSION_ID
```

The server restricts status access to the submitting credential. Another credential
scoped to the same app does not inherit that submission. Administrator credentials
do not substitute for a deploy token in this command. Select the installation's
endpoint and private-CA trust as needed.

## Read the result

The output contains the requested submission's ID, app, artifact digest, recorded
status, submission time, activation step, and fixed failure explanation. An active
record means approval completed; it does not establish live runtime health or the
application's current behavior. Check the app's own endpoint and saved results.

For a failed migration, the explanation asks an administrator to inspect and
reconcile the migration before retrying. The CLI does not print raw SQL, command
output, secret revisions, credentials, or arbitrary server fields. Owners can use
[`fogd admin inspect APP`](application-inspection.md) to connect release history,
routing and held operations, then inspect raw diagnostics privately in the
administrator interface. Retrying or replacing an activation still needs explicit
approval of the exact artifact.

Unrecognized status or progress values are `unknown`; an unsupported timestamp is
`null`. The source status policy recognizes queue bootstrap, replica adoption,
delivery pause/release, application publication and replacement hold transfer,
with fixed explanations for failed releases. It does not expose either release's
private diagnostics during replacement.

The frozen runtime still discards some queue lifecycle labels before returning
status. The CLI cannot recover those labels and does not guess them. The source
correction needs a newly qualified runtime before it changes that behavior.
Scoped logs and live application outcomes remain open in
[operator readiness](operator-readiness.md#3-diagnose-an-application).

## Connection and compatibility failures

A request refuses redirects and uses a bounded timeout and response size. TLS,
network, authentication, unavailable-submission, malformed-response, and identity
failures produce fixed explanations without copying private response contents.
An oversized response is a compatibility/read-limit failure, not evidence that
the application is unhealthy. Responses for a different submission are refused.

The command performs one authenticated GET, creates no local state, and changes
no approval, hold, migration or recovery setting. A successful read exits normally
even when the release is recorded as failed; read the JSON status when automating.

## Repeat the local check

The [local receipt](evidence/operator-submitter-status-local.json) covers pending,
failed SQL, a corrected active release, and both cross-app and same-app access
refusals for other submitting credentials. The runner checks the real wire response
and verifies that status reads leave the controller snapshot unchanged. It preserves
all volumes and private diagnostics after removing its scoped containers/networks.

With qualified images and ordinary JavaScript build dependencies already cached,
choose a new private output directory:

```sh
node scripts/cron-probe/selected/submitter-status.mjs .fogd/submission-status-NEW
```

This check creates a separate local installation. It does not install dependencies,
build runtime images, contact Cloudflare, or qualify a remote host.
