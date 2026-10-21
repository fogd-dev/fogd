# Experimental native cron dispatch controls

The [control patch](../../patches/celld-0.6.2-cron-controls.patch) adds a durable
operator hold to the native cron cell. Cron admission in fogd remains closed.
The [two-node native evidence](../evidence/m11c-cron-controls.json) passes its bounded
bootstrap, adoption, mid-callback pause and restart profile. The primitive does not implement the controller activation, approved Void app,
retirement or snapshot recovery gates in the [M11c contract](../m11c.md).

Apply it after the source-pinned [retry patch](celld-cron-retry.md) and
[attachment patch](celld-preaccept-attachment.md), on celld commit
`90b43017241f81189453d326d05948f388b34652`. It registers the cron class for the
primary script even in a triggerless, app-free bootstrap. Ordinary `/do/` access
and application declarations of that reserved class are refused. Operator commands
use celld's existing signed `/runtime/` transport:

```sh
celld cron info SCRIPT --json
celld cron pause SCRIPT --json
celld cron resume SCRIPT --json
```

A missing control record means held, including an older cron cell on its first
start with this candidate. It needs explicit resume. A malformed record fails closed. The cron
cell must match its primary script; a mistyped script name cannot create a second
schedule. Status reports the persisted hold, revision, declared expressions and
native alarm view. The alarm view is null during an active callback, so a null
value alone does not prove deletion or that no callback is running.

A transition to pause atomically persists the hold, clears retry identity and
deletes the alarm.
An already-running callback may finish; pause is not cancellation or a drain.
The revision changes on pause/resume. An older callback cannot dispatch remaining
expressions or rearm after that change. Resume atomically releases the hold and
arms the next future occurrence, discarding held history and pending retries.
Repeating a successful resume leaves its existing alarm intact. Failed alarm
writes roll the control transition back with the alarm.

The hold is per script, independent of release identity. Before every publication,
the controller still needs to establish a confirmed hold, pin approval and secret
revision, finish compatible migrations and confirm runtime adoption before resume.
Resuming an empty bootstrap and then publishing user code is unsafe as an activation
protocol. A runtime observation is not a release fence. These requirements keep
platform admission closed until the full lifecycle is implemented and qualified.

The experimental [controller transport](../../packages/platform/src/cron-runtime.mjs)
checks every configured replica and the resident cron cell's generation before
resume, and refuses to resume an empty bootstrap schedule. It confirms mutations
with a separate status read and reports lost replies
as uncertain, without automatic retry. Status exposes control observations only;
it cannot infer callback completion from the alarm view. The controller must still
persist approval and dispatch intent before using this transport. The transport
does not implement that activation journal or authorize cron declarations. The
[experimental coordinator](../cron-activation.md) supplies a separate, internally
staged journal; ordinary approved cron applications remain unqualified.
Use it only with the qualified patched runtime on every replica. Deployment
versions identify application code, not the runtime binary; the transport cannot
detect an older runtime before its first command. On an older harness, even an
info request can arm a timer. Runtime provenance and stopped replacement remain
operator prerequisites. The separate [early identity candidate](celld-runtime-identity.md)
provides metadata before first deployment. The
[caller policy](../cron-runtime-policy.md) now requires verification before every
command and bootstrap, including info. Missing verification refuses the command;
previous cron receipts do not qualify that new binary or guarded path.

The [native transport profile](../evidence/m11c-cron-transport.json) exercises
these checks on a fresh two-node fleet, including empty-bootstrap and unapproved
version refusal, mid-callback pause and held restart. Its accepted result requires
a successful runner exit, independently checked events and stopped disposable
containers. Lost-response and malformed-status cases are covered by the
[transport tests](../../packages/platform/test/cron-runtime.test.mjs).

Stop every replica before replacing the runtime. Mixed versions, rolling upgrades
and rollback are unqualified: older runtimes ignore the hold. The separate
[stopped recovery profile](../cron-recovery.md) has a full bounded rerun with the
same executable source fingerprints as the cron/queue retirement profile.
[Retirement](../retirement.md#experimental-scheduled-app-retirement) has separate
bounded native cron/queue and two-cron profiles, including held survivors and a full
source restore with both schedules held. Do not boot uncontrolled historical snapshots
and then try to pause them.

The [source regression runner](../../scripts/celld-cron-regression.mjs) executes the
actual patched class with modeled host primitives:

```sh
node scripts/celld-cron-regression.mjs PATH/TO/crates/celld/js/harness.js --controls
```

The [native control probe](../../scripts/cron-controls.mjs) requires a never-deployed
fleet in a disposable installation using the patched image. Follow the
[disposable setup](../queue-qualification.md#prepare-a-disposable-installation),
then run:

```sh
FOGD_ENV_FILE="$PWD/.fogd/cron-control-fixture/probe.env" \
  node scripts/cron-controls.mjs slot-1 .fogd/cron-controls
```

The probe checks bootstrap and adoption holds across a minute boundary, unsigned
access refusal, pause during a held callback, full replica restart while held and
explicit resume. Its finalizer attempts pause and no-cron publication; if cleanup
fails, stop the disposable fleet and retain its volumes. Private probe output needs
inspection before sharing. None of these checks establish controller approval,
application idempotency or stopped snapshot recovery.


Packaging this candidate requires explicit `CELLD_TESTED_IMAGE`, `CELLD_PATCHES`
and `CELLD_PATCH_DIGESTS` build arguments in the
[experimental package Dockerfile](../../docker/celld-cron-patched.Dockerfile). Its
defaults describe the retry-only candidate. Compare the compiled source with a
freshly applied patch stack, check the control markers in the binary and compare
that binary's hash across build, package and runtime images. Labels alone are
insufficient provenance. Keep source-pinned hashes with qualification evidence;
[Native clippy passes](../evidence/m11c-cron-rust-checks.json), while real Rust
test execution remains unqualified: default `cargo test` executes zero tests.
The public revision gates its celld suites on `celld_internal_tests` and external
harness source paths, and disables library tests for logic and ltx. A successful
public build must not be presented as execution of those suites.


The accepted run uses `cron-controls-candidate5`. Its evidence includes the
source-pinned patch hashes, compiled-source comparison, identical build/package/
runtime binary hashes, protected-route responses and full application event set.
The recorded hold revision survives both replicas restarting; absence alone would
default to held and would not establish that persistence. Acceptance also requires
exit code zero, no failure or cleanup-failure artifact and stopped disposable
replicas. A printed pass before cleanup is insufficient. Claude's follow-up source
review found no logic or protocol blockers after the operator envelope correction.
