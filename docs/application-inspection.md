# Understand an application's recorded state

Run `fogd admin inspect APP` when an approved app is paused, a release failed, or
several submissions make it difficult to identify the active release. The report
connects that app's routing record, release history, ownership and migration
references, and background-work controls.

```sh
export FOGD_ENV_FILE=/private/operator.env
node packages/cli/bin/fogd.js admin inspect guestbook
```

Use the installation's administrator credentials, endpoint, and private-CA trust as
needed. A scoped deployment token cannot substitute for administrator access. The
command reads one authenticated controller snapshot. It does not observe a native
cell, retry an activation, change a hold, acknowledge recovery, or resume work.

## Read the report

`active` identifies the controller's active release by submission ID and artifact
digest. `releases` includes only the requested app, including rejected and superseded
submissions, ordered by recorded submission time, newest first. `routing` is the recorded route
state. A pending-only app has an unassigned route and no active release.

An active approval is separate from a running application. `runtimeHealth` and
`applicationOutcomes` remain `not-observed`, even when a background journal has a
recorded successful observation. Check the app's own endpoint and saved results for
its current behavior.

`uncertainMigration` and `ownershipClaim` identify the original release when those
operations remain unresolved. A failed migration can have a known ledger outcome;
inspect the failure and uncertainty fields separately. Quarantine and retirement
are also separate conditions. Known recorded quarantine explanations are preserved;
unrecognized text is withheld.

For queue delivery or scheduled dispatch, `controls` separates desired state,
recorded observation and its time, an operation still in progress, an activation
hold, and recovery acknowledgment requirements. Known recovery findings are shown.
A hold identifies the release that must be inspected. Pausing dispatch does not
drain callbacks already running, and this report does not establish a live fence.
Use the existing delivery/dispatch status commands for their detailed control view.
Explicit observation is a separate operation that can materialize runtime state.

`nextChecks` explains recorded conditions. Review the exact artifact and its private
admin diagnostics before deciding whether to retry, replace, restore, or resume.
The report does not select or execute those actions.

## Inspect a failed release privately

`hasPrivateDiagnostic` means an error is recorded but omitted from this report.
Open the configured administrator endpoint, authenticate, and find that submission
by its ID and digest to inspect the raw failure. Raw errors can contain SQL data or
other private information. Runtime versions, credentials, secret revision values,
other applications, and arbitrary server fields are excluded from the CLI report.

`secretRevisionSelected` records whether that release pinned a revision. It does
not establish whether required keys are configured or whether the app needs secrets.
Review the artifact's declarations and select the exact revision during approval.

An inconsistent active, held, ownership, or migration reference fails inspection
with the affected field named. The command does not guess a replacement reference.
Unknown activation steps/statuses are labeled `unknown`; inspect compatibility and
the private admin interface before acting on an unfamiliar controller version.

The controller snapshot must fit the 4 MiB read limit. Exceeding that limit produces
a specific error; it does not mean the application is unhealthy. Controller/network,
TLS and authentication failures also produce fixed explanations without response
bodies. Received redirects are refused.

This is an owner diagnostic view. Submitters use [`fogd status ID`](submission-status.md) with bounded reads and
public-field filtering. Its existing queue progress labels can still be `unknown`
on the frozen runtime. Fixing
those labels, exposing app logs, and observing application outcomes remain separate
[operator-readiness work](operator-readiness.md).

## Reproduce the local runtime check

The [local acceptance receipt](evidence/operator-inspection-local.json) covers a
broken guestbook migration, corrected approval, and a secret-bearing scheduled app
with confirmed recorded pause. Each inspection leaves the controller snapshot
unchanged. The check compares the actual wire timestamps and release references,
scans private surfaces, and retains all volumes after removing its own containers
and networks.

Use the cached qualified family and prepared guestbook/refresh dependencies; this
check does not install dependencies or build a runtime image. Choose a new private
output directory:

```sh
node scripts/cron-probe/selected/inspection.mjs .fogd/application-inspection-check
```

This local two-fleet check does not qualify submitter logs, live health, an
unreachable-runtime observation, or a second-machine installation.
