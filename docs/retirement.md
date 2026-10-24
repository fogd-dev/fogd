# Retire an app and reuse its fleet

Retirement creates a fresh Docker installation from a stopped snapshot. The retired
name becomes permanent history; a differently named app can use its freed fleet.
The other app keeps its data and native sessions. Plan whole-installation downtime
and enough disk for a full restore. Kubernetes retirement is not supported.
Scheduled history requires the qualified selected runtime and its independent
[installation policy](runtime-selection.md); default installations refuse it.
The [M11c acceptance](m11c-acceptance.md) records current scheduled retirement and
restore evidence. Earlier experimental profiles below retain their pinned scope.

The commands below cover legacy `fogd-stopped-v1` snapshots. The source implements
a separate coordinator for `fogd-stopped-durable-v1`. The
[packaged v3 candidate](evidence/operator-durable-retirement-package.json) includes
its stopped retirement helper, but native retirement acceptance remains open and
ordinary enrollment stays closed. The v2 candidate lacks the helper. The earlier
[native refusal check](evidence/operator-native-activation-crashes.json) records
the missing path before this coordinator existed.

The [durable retirement tests](../packages/cli/test/durable-retirement.test.mjs)
exercise verified archive copying, empty replacement disks, retained artifacts,
survivor holds and fresh enrollment. The helper validates the original source pair
and the change to one fleet's identity before spending its enrollment grant.
Interrupted copying or publication retains the target for inspection and keeps
host enrollment incomplete. These component checks do not qualify Docker mounts,
native data recovery or background retirement in a packaged runtime. Keep durable
installations on their enrolled recovery workflow; the raw Docker startup command
below does not apply to them.

The v3 package preserves the pinned native binaries and adds the matching controller
sources. It does not qualify upgrading an existing v2 installation or restoring its
snapshots under v3. Native acceptance needs a fresh v3 installation and snapshots
from that same family.

## Prepare and retire

Upgrade to a runtime with retirement support before taking the snapshot. The command
refuses older images. Record the retiring app's active deployment digest from
`fogd admin list`. An app may be active or paused, but needs a known active deployment
and reconciled migrations. Quarantined, uncertain, never-activated, and already-retired
apps are refused.

Use operator configuration for backup, without overriding its deploy token with a
teammate token. Keep the source stopped and perform no concurrent operator mutations.

```sh
FOGD_ENV_FILE=/path/to/installation.env pnpm exec fogd backup .fogd/before-retirement
pnpm exec fogd retire .fogd/before-retirement \
  --app notebook --digest ACTIVE_ARTIFACT_SHA256 \
  --project fogd-after-retirement --output .fogd/after-retirement
```

Both compose.json and restored.json must exist before starting. retirement.json
records the old and replacement fleet identities. These files are private.

```sh
docker compose -f .fogd/after-retirement/compose.json \
  -p fogd-after-retirement up -d --pull never
```

The generated Compose file is self-contained and pinned to snapshot images. Keep
using it for the recovered installation. Configure the CLI's server URL and admin
credentials for that installation; ordinary deploy/approval works as before. Issue
a credential scoped to the replacement app's different name and deploy it normally.

## What remains and what changes

The new fleet receives empty replica volumes, new node identities, and a disjoint
bucket prefix. Old prefix objects stay retained in the copied bucket. Original
source volumes, snapshots, secret revisions, artifacts, and approval history remain
private recovery material. Retirement does not erase data or reclaim artifact bytes.

A permanent tombstone blocks routing, submissions, approvals, rejection mutations,
secret changes, and new credentials for the retired name. Existing multi-app tokens
still work for their other scopes. Revoke obsolete tokens separately. The replacement
must use a different name and appropriately scoped authority.

Restoring an older backup can resurrect the app, credentials, and secrets that
existed at its snapshot boundary. Keep old installations stopped. This workflow
assumes trusted application code and an exclusive operator; it does not establish
hostile-tenant isolation through shared bucket credentials.

## Failure handling

A source with running containers or a live consumer of its volumes is refused.
Wrong digests, corrupt bundles, old runtime images, and occupied targets are refused.
Old-image refusal can leave a private output directory and loaded images, but creates
no target containers or start file.
The entire bundle is verified even though two replica archives are not extracted.

Failed attempts retain any compose.pending.json and stopped resources they created
for inspection. Do not start them with raw Docker commands. Automatic resumption is not
supported: choose a new project and output directory for another attempt. Neither
retirement nor restore deletes source data or partial targets.

## Reproduce qualification

Use a fresh disposable shared/TLS Docker installation whose project starts with
fogd-m10, and select its operator .env through FOGD_ENV_FILE. Supply the certificate
and the issuing CA used for that installation:

```sh
FOGD_ENV_FILE=/path/to/test.env NODE_EXTRA_CA_CERTS=/path/to/ca.pem \
  node scripts/retirement.mjs /path/to/server.pem
FOGD_ENV_FILE=/path/to/test.env NODE_EXTRA_CA_CERTS=/path/to/ca.pem \
  node scripts/retirement-negatives.mjs
```

The first script creates accounts and notebook, enrolls an account, writes D1/R2/DO
state, retires notebook, and deploys replacement into the empty fleet. The second
interrupts a private child process after the controller archive copy, verifies safe refusal and
fresh-target retry, and checks ordinary restore before returning to the retired
installation. It can also take an older complete Docker bundle as an argument to
check runtime-capability refusal. It retains all fixture volumes and snapshots.


## Queued app retirement

Installations using the [bounded Docker queue profile](queue-admission.md)
can use the same stopped snapshot workflow with `--stop-queued-work` when retiring
a queued app. This flag explicitly accepts that its pending work will not execute
in the replacement fleet. It is refused for a non-queued target.

Every live queued app must have completed activation, reconciled migrations, an
acknowledged prior recovery, and a matching unexpired snapshot receipt. Backup
prepares and confirms operator pause. An expired target snapshot is refused even
when the operator intends to stop its work. Upgrade the source runtime before
backup: the CLI checks the snapshot image's queue-retirement capability before
creating target containers.

```sh
pnpm exec fogd retire .fogd/before-retirement \
  --app imports --digest ACTIVE_ARTIFACT_SHA256 --stop-queued-work \
  --project fogd-after-retirement --output .fogd/after-retirement
```

The target's old queue state becomes private audit history. It has no operational
delivery journal or recovery gate. Its retained bucket prefix is never assigned to
the replacement fleet. Surviving queued apps receive pending recovery receipts and
paused HTTP routes; follow the [recovery guide](queue-recovery.md) to inspect,
acknowledge, and separately resume each one. A non-queued target requires no flag,
but queued survivors still receive these gates.

Later backups exclude valid retired queues from live preparation. Their history
and capability remain in controller metadata, so older controllers refuse it.
Kubernetes and expansion still refuse all queue history, including retired apps.
Retirement preserves recovery material; it is neither data deletion nor a guarantee
that an old installation cannot restart pending work.

The private probes are `scripts/queue-retirement.mjs`,
`scripts/queue-probe/retirement-isolation.mjs`, and
`scripts/queue-probe/retirement-survivor.mjs`. They require a disposable M11 Docker
fixture with an activated canonical `imports` app and one unused fleet. The first
stages a second app privately, snapshots, and retires `imports`. Select the resulting
Compose file and project in a private operator environment for the next two probes.
They inspect a fresh queue/database, run replacement work, compare retained object
identities, exercise survivor recovery, and take another snapshot. They deliberately
bypass public artifact admission and do not establish hostile-tenant isolation.


The completion probe, `scripts/queue-probe/retirement-complete.mjs OUTPUT`, starts
from the stopped isolation fixture. It retires the remaining two apps, comparing
SHA-256 hashes of every retained object before retirement and after restored startup.
Source observations run only the bucket service, with all app writers stopped.
It then backs up the installation with no live queued apps and performs an ordinary
restore. The controller starts, retired routes remain unavailable, and retained
object hashes still match. [Completion evidence](evidence/m11a-queue-retirement-complete.json)
records the image, counts, and observations.

Select the stopped fixture's private operator environment and run:

```sh
FOGD_ENV_FILE=/path/to/retirement-fixture.env \
  node scripts/queue-probe/retirement-complete.mjs .fogd/retirement-complete
```

The probe retains source volumes and snapshots but removes stopped fixture containers
and networks between restores. If interrupted after a successful retirement, select
the generated installation and supply the prior progress.json as the second argument
to continue into a new output directory. It rechecks retained object hashes before
continuing. It waits for approved replica generations before recovery acknowledgment.


The completion probe updates the disposable fixture's runtime image pins in place.
Its source comparisons cover the two apps retired during that run. The optional
`scripts/queue-probe/retirement-final-inspection.mjs SOURCE_COMPOSE TARGET_COMPOSE PREFIX OUTPUT`
compares an earlier retained stopped source with the final target. It starts only the
source bucket for reads, then stops it, and checks every target service's running,
exit, and restart state. Neither probe waits through the four-day retention interval.


## Experimental scheduled app retirement

The single-cron receipt pins commit
`7d08edbc55848aaf3efd8a54aebccbb92edf37f4`; the two-cron receipt pins
`bdd828e2b520c35a343955e0e8107bfd2ac3d604`. Their source maps have been
checked against those Git revisions. Current shared qualification helpers have
different fingerprints.

The following receipts and commands describe historical pinned profiles. At these
checkpoints, normal CLI retirement and restore refused all cron history, including
retired or pending schedules. `--stop-scheduled-work` did not bypass the
[independent preboot policy](cron-runtime-preboot.md). Reproduce these drivers with
their recorded sources. The later [M11c acceptance](m11c-acceptance.md) qualifies
ordinary selectors for the frozen family; these older receipts alone do not.

The [bounded native evidence](evidence/m11c-cron-retirement.json) qualifies scheduled
retirement on same-version local Linux arm64 Docker with two application fleets.
Ordinary cron admission stays closed. The profile uses a private qualification
controller for live cron apps; the ordinary controller starts only after every live
cron is retired. The runtime includes the experimental native dispatch-control
candidate. A [two-cron profile](evidence/m11c-cron-retirement-dual.json) also qualifies
retiring one schedule while another survives and restoring the full source with
both schedules held. Release-bound runtime selection remains unqualified.

An internally staged scheduled app requires `--stop-scheduled-work` in the same
stopped snapshot workflow. This acknowledges that its old timer and retry identity
will not execute in the replacement fleet. The flag is refused for other apps;
`--stop-queued-work` remains specific to queues. Every live background app needs
matching snapshot preparation, completed activation and acknowledged prior recovery.
The snapshot runtime must include the cron-retirement capability; upgrade before
backup if it does not.

Retirement retains the old dispatch journal, snapshot and prior recovery as a
private audit, with no operational cron journal or recovery gate on the tombstone.
The replacement receives a different name, disjoint bucket prefix, new replica
identities and empty replica volumes. Surviving cron and queue apps receive pending
recovery receipts and paused routes. Acknowledgment and dispatch resume remain
separate actions; follow the [cron recovery protocol](cron-recovery.md).

Later backups validate retained cron audits without preparing their old schedules.
Restore retains the capability requirement even when no live scheduled apps remain.
Docker backup, restore and retirement refuse scheduled history outside two app
fleets, including pending and retired history. Expansion and Kubernetes recovery
still refuse all scheduled history. Retained old sources can run old schedules if
restarted; keep them stopped.

The [qualification driver](../scripts/cron-retirement.mjs) creates a fresh private
installation from an explicit resolved two-fleet M11c Compose template. It rotates
credentials, fingerprints the runtime and executable sources, and uses the same
loopback ports and private networks as the [recovery driver](cron-recovery.md).
Use unused ports/networks and a new ignored output directory. The template and
archives contain private material.

```sh
docker build -f docker/runtime.Dockerfile \
  --build-arg CELLD_IMAGE=fogd-celld:cron-controls-candidate5 \
  -t fogd-runtime:cron-retirement-candidate6 .
node scripts/cron-retirement.mjs PRIVATE_TWO_FLEET_TEMPLATE_COMPOSE_JSON \
  .fogd/NEW_RETIREMENT_EVIDENCE fogd-runtime:cron-retirement-candidate6
```

The profile retires a queued app beside a live cron, a cron with a pending retry
beside queued work, a due replacement cron, and the last queued app. Each target
has native-only and controller-running holds of at least 62 VM seconds. Surviving
apps need explicit recovery acknowledgment and a separate resume. Queued survivor
inputs must be accepted with no result and a real backlog in their snapshot;
completion after restore uses GET only, without resubmitting input. Cron resume
checks future native occurrences and unchanged old occurrence rows and counters.

Replacement approvals check empty application rows, a fresh namespace and replica
identities, retired-name and old-token refusal, and independent required secrets.
Reuse means a different app name in the freed capacity; the private cron replacement
uses the same refresh fixture code and database declaration in its new namespace.
An ordinary restore of the stopped retry source separately checks that its handler
ledger equals the pre-pause sample through both held intervals. It does not resume
that audit copy or establish a universal callback drain.

A final backup/restore with only retired history uses the ordinary controller and
requires no live recovery receipts. Old bucket prefixes, artifact files, secret
revisions and every original source volume remain unchanged. Accept a run only
after observing its actual terminal exit, checking the private `retirement.json`
and failure markers, and inspecting shutdown/log checks. Cleanup retains every
volume. The public receipt records source hashes and the profile's limits.

### Retirement beside another scheduled app

The [two-cron evidence](evidence/m11c-cron-retirement-dual.json) covers two independently
approved instances of the refresh fixture. After retiring the initial queued app,
the second cron uses its own secret revision and fresh namespace in the freed
fleet. Both schedules run before backup. Their pause receipts must confirm the
same minute-aligned alarm and both holds before its deadline.

```sh
node scripts/cron-probe/retirement/dual.mjs PRIVATE_TWO_FLEET_TEMPLATE_COMPOSE_JSON \
  .fogd/NEW_DUAL_RETIREMENT_EVIDENCE fogd-runtime:cron-retirement-candidate6
```

Retiring the original cron leaves the second held through native-only startup,
controller initialization and explicit recovery acknowledgment. A separate resume
must produce future native work without changing older attempts, results or
occurrence counters. A full restore of the pre-retirement source then checks both
complete ledgers through cold and controller-running holds. The imported queue's
retired namespace remains unchanged across every phase.

The accepted run has six held intervals of at least 62 VM seconds and four projects
with 28 retained named volumes. Independent postflight reads validate current
approval, secret and runtime-version pins, persisted acknowledgments, retired
audits and the unchanged scoped credential store. Actual private secret values
and materialized runtime versions stay out of the public receipt.

A separate validation-failure check deliberately changes the plan digest after a
fresh stopped target is created. The retirement helper must remove that target's
containers, retain its seven volumes and preserve the original source. The receipt
pins the checked helper and fault probe. Its private evidence is retained at
`.fogd/m11c-retirement-cleanup1`; the exact fault code is in `acceptance/fault.mjs`.
Both this path and the full qualification preserve every volume.

The two-cron receipt adds the qualifier and cleanup guard to the earlier helper
versions. Its production runtime sources and native binary match the earlier
recovery and retirement profiles; each receipt retains its own complete source
fingerprints. These historical receipts did not open ordinary scoped cron admission;
the later [M11c acceptance](m11c-acceptance.md) records that separate decision.
