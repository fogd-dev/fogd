# Experimental queue admission

The normal build/upload path now accepts a bounded Void queue profile. Controller
admission remains **off by default** pending the final acceptance audit and default
policy review. Integrated update, recovery, retirement, and browser drills now pass. Docker qualification can opt in with
`FOGD_QUEUE_APPS=1` in its private operator environment before starting the stack.
Kubernetes rendering does not forward that setting, and its controller refuses
new queued submissions and approvals.

This setting controls new uploads and approvals. Turning it off does not pause
already approved consumers. Exact retries of previously approved failed activations
remain allowed; new uploads, updates, and replacement approvals still need opt-in. Use the [delivery controls](delivery-controls.md) to
pause existing work.

## Supported declaration

Use one producer and one consumer for the same queue, as in
[examples/imports](../examples/imports/README.md). All four consumer settings must
be present and equal to integer 1: max_batch_size, max_batch_timeout, max_retries,
and retry_delay. Missing settings would invoke different runtime defaults, so fogd
refuses them. Multiple queues, dead-letter queues, producer delay, concurrency
settings, and cross-script declarations remain unsupported.

Queue names use lowercase letters, digits, and internal hyphens. The physical name
is app-logical unless the logical name already starts with app-. The result must
fit 63 characters. This rule is stable when the controller validates an uploaded
artifact again. Void dispatch resolves the exact logical name or its known suffix.
Producer bindings share the namespace with variables, secrets, and other resources.

Empty generated queue declarations normalize to absence. Canonical uploaded artifacts
must omit the field when no queue exists. Existing non-queue resource identities
remain unchanged. Once an app activates, queue removal, renaming, policy changes,
and adding a queue to an existing non-queue app are refused.

## Submit and approve

With a current runtime and an opted-in Docker controller, run `fogd deploy` from the
Void app as usual. The command builds locally and submits the immutable artifact.
A scoped credential limits which app the teammate can submit. An administrator
reviews the queue identity, migrations, and exact digest before approval. Uploading
alone neither reserves a fleet nor publishes a consumer.

The [initial public-path evidence](evidence/m11a-queue-public.json) covers an ordinary
scoped CLI upload, no app ownership or deployment before approval, wrong-digest
refusal, pending-only backup/restore, and activation after exact approval. It also
covers derived-name dispatch, retryable and terminal failures, explicit application
retry, and duplicate submission without duplicate result rows. This is a checkpoint,
not the complete application acceptance claim. The [failed-claim drill](evidence/m11a-queue-public-claim.json)
also rejects a real predeployment claim failure through the normal API and takes a
snapshot containing the active canonical queue. Its restore remains pending; two
unused-fleet replicas exited 143, recorded as requiring crash recovery.

## Backup before approval

Never-approved queue uploads do not disable backup. Their records must still be
pending, rejected, or superseded at the submitted step, have no pinned secret
revision, and have no app referencing their approval ID. A later unrelated app
assignment does not give an old submission authority. The queue capability remains recorded, but there is no live queue
to pause or prepare. Ordinary restore preserves the pending approval without
executing it. Expansion and Kubernetes recovery use the same artifact-only rule.

A rejected first approval can also qualify when its ownership claim failed before
any deployment. The controller verifies that its reserved fleet is unowned and
unpublished, then atomically saves a release receipt with rejection and reservation
removal. Backup requires that receipt; rejected status alone does not establish
that no runtime effects occurred. That historical release remains valid after an
unrelated approval reuses the app name, provided no app references the rejected
request. Older rejected records without such evidence
remain refused. Failed activation, holds, uncertain migration, and orphaned queue
lifecycle metadata still require reconciliation.

## Reproduce the current checkpoint

`scripts/queue-public.mjs OUTPUT` expects the disposable zero-live retirement fixture
from the [retirement completion drill](retirement.md), selected through FOGD_ENV_FILE.
It updates that fixture's runtime image pins and enables queue admission, issues a
scoped credential, invokes the normal CLI from examples/imports, and restores the
pending upload into a fresh project before approval. It retains source volumes and
snapshots, and leaves the approved app operator-paused. No artifact bypass is used.
If upload succeeded but the harness stopped before backup, `--submitted` reuses the
single pending request and verifies its credential scope instead of uploading again.

Canonical artifacts now pass additive updates with in-flight compatibility and
retirement. The final acceptance audit and default policy review remain. The wider queue policy range and Kubernetes activation remain separate
qualification work.


After the initial public-path probe, select its restored installation and run
`scripts/queue-public-claim.mjs OUTPUT`. It submits a second app through a scoped
credential, temporarily stops the fixture bucket to fail the initial claim, restores
the bucket, rejects the verified unclaimed reservation, and takes a snapshot. The
source remains stopped. This failure injection belongs only on a disposable fixture.


`scripts/queue-public-history.mjs OUTPUT` continues the failed-claim fixture with a
current runtime image. It verifies supersession and name reuse, deliberately stops
one replica and kills the controller during an approved update, then restarts with
admission disabled and retries that pinned approval. It takes another full snapshot
and leaves the source stopped. [History evidence](evidence/m11a-queue-public-history.json)
records the current image and successful backup. Use this only on the disposable
qualification fixture.


Continue that stopped history fixture with
`scripts/queue-public-recovery.mjs OUTPUT NEW_PROJECT`, using a fresh project name
starting with `fogd-m11`. The probe submits two messages for one job through workerd,
snapshots the paused queue, removes only the source project's containers/network
while retaining volumes, restores, and verifies acknowledgment plus explicit resume.
It asserts both messages drain and only two result rows remain. The source must stay
stopped after recovery; select `OUTPUT/restored/compose.json` and NEW_PROJECT for
subsequent commands, retaining the same operator environment and ports.

Then run `scripts/queue-public-browser.mjs slot-1 NEW_OUTPUT` against that restored
fixture. Chromium connects directly to `imports-public.localhost` on the configured
HTTP port. It checks submission, saved URL, reload, retry, and results through workerd.
Both probes leave delivery paused. These scripts require the disposable canonical
fixture with its existing `imports-public` approval, not an arbitrary installation.


After the browser drill, run `scripts/queue-public-update.mjs NEW_OUTPUT` against the
restored fixture. It enables admission in that disposable controller, builds the v2
fixture overlay through ordinary `fogd deploy`, and approves its additive migration
while a v1 handler is running. This requires v1 with 0002_processor.sql unapplied.
The probe fails if v1 finishes too early to establish overlap. It leaves delivery
paused; it does not roll back the additive migration.

Populate the neighboring hello app with at least one post, then run
`scripts/queue-public-retirement.mjs NEW_OUTPUT NEW_PROJECT`. The first recorded
run had an empty neighbor response, so it qualifies availability only; the stricter
populated-neighbor rerun remains open. It enqueues
pending work, snapshots, fingerprints the stopped app's bucket prefix, and runs
`fogd retire` with the exact digest and explicit stop-work flag. It retains source
volumes, verifies the old prefix's bytes, checks the neighboring hello app, and
approves a new hello app into the released fleet. Select the resulting
`NEW_OUTPUT/retired/compose.json` for further work. The retired app name stays reserved.
