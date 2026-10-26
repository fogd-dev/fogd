# Serve applications independently of the controller process

Status: proposed implementation contract for a new runtime family. The current runtime
still asks the controller to route every request. No routing behavior, catalog pins or
admission gates change with this proposal. The candidate scope is single-host Linux
arm64 Docker Compose with two application fleets. Kubernetes, remote volumes and
additional gateways are outside this family.

An approved application should keep serving when its controller process stops.
Operators must still be able to stop new HTTP requests before changing an app's
runtime or data. This advances G2 and G3 under the product goal, **Cloudflare you can
control and touch**.

## Architecture choice

The [gateway](../packages/runtime/src/gateway.js) currently performs an authenticated
controller lookup and a replica health check before forwarding. The [serving
measurements](serving-measurement.md) record gateway interruption during controller
loss separately from direct replica behavior. Keeping this design leaves that outage
in place. Bounded lookup retries can hold requests through a short restart without
changing authority, but still block those requests on the controller. They do not
provide independent serving or remove the per-request lookup.

A timed route grant can remove that lookup, but adds expiry assumptions and a pause
drain interval. Delayed replies must consume its original lifetime, controller
restarts must discard elapsed drain progress, and stale replies must never override
newer authority. In the [inspected workerd
source](https://github.com/cloudflare/workerd/blob/v1.20261016.1/src/workerd/api/performance.c%2B%2B#L12-L17),
`Performance::now()` calls `dateNow()` directly. A browser-style monotonic-clock
assumption cannot justify grant expiry. Explicit revocation avoids timers but needs
durable holder membership and can wait indefinitely for an unreachable gateway.

The selected direction is a separate durable route record. The controller writes it
while the installation is live; the gateway reads it directly for each HTTP request
through a private read-only workerd disk binding. The [workerd configuration
schema](https://github.com/cloudflare/workerd/blob/v1.20261016.1/src/workerd/server/workerd.capnp#L891-L930)
supports directory-backed services with writes disabled. No route is reused from an
in-memory cache, and elapsed-time grants are outside this increment.

This adds a route-authority volume and a crash protocol between two durable stores.
Maintainers own that protocol and topology integration. Operators retain one more
volume in backup and recovery. The strongest objection is that another durable store
increases recovery complexity. It is preferable here to a clock-dependent permission
protocol, but requires explicit failure and restore evidence before release. This
proposes replacing ADR 006's per-request route lookup and the ingress-refusal part of
[ADR
027](decisions.md#adr-027-stop-controller-mutations-after-uncertain-metadata-persistence)
for the new family. ADR 027's mutation stop remains mandatory. The existing family
keeps both decisions unchanged. If fresh disk reads or durable ordering cannot be
established on the supported topology, this design is not admitted.

## Route authority and disclosure

The route record is the authority for new HTTP routing. Controller metadata records
desired state, approval progress and the corresponding route-publication intent; its
`route` field alone no longer establishes what ingress currently permits.

Use one bounded, versioned `routes.json` record containing installation identity,
route revision and normalized host entries. Each active entry identifies only its
configured slot and exact completed submission ID/digest. Withheld and retired entries
confer no forwarding permission. Unknown hosts remain unknown. The gateway verifies
the schema, installation identity, unique hosts and configured bindings before
selecting a destination. Its expected installation identity comes from the
independently sealed launch configuration, never from the record being checked.
Missing, malformed, oversized, inconsistent or unreadable authority refuses routing;
it never enables legacy fallback.

The dedicated volume contains routing data only. The controller is its sole live
writer. Offline CLI recovery and retirement may write only with controller and gateway
stopped. The gateway mounts it read-only, and application replicas cannot mount it. Do
not mount controller metadata, artifacts, secret revisions, TLS keys or storage data
into the gateway. The disk binding has no public socket and accepts no path or method
from an incoming application request: the gateway reads only its fixed file with GET.
Workerd disk services can follow symlinks, so publication must use regular files in
the dedicated directory and the topology must exclude other live writers.

Per-request reads do not enumerate the directory. Atomic publication may leave regular
staging siblings after a crash; these do not confer authority or invalidate the fixed
record. Topology/startup inspection checks the directory and writer scope without
treating an expected staging file as an ingress failure.

Fresh enrollment creates and durably publishes an empty record only after proving the
authority volume is fresh and owned. Create-if-absent initialization never overwrites
an existing record or repairs missing retained authority automatically. A valid empty
record reports unknown hosts; missing authority remains unavailable.

Validation: inspect actual mounts and binding reachability. Supply foreign identity,
unknown slots, duplicate hosts and invalid files. Keep a valid fixed record serving
with interrupted staging siblings present. Refuse invalid authority without exposing
record contents or private controller data. Within one reconciled installation
generation, two apps must never select each other's fleet, including after retirement
and reuse. Stopped startup/restore checks below establish that generation; the gateway
cannot detect arbitrary replacement of app storage by a privileged owner while it is
running.

## Fresh reads define the pause boundary

Every incoming HTTP request performs a fresh authority read. Neither the gateway nor
its disk service may reuse a previous record, open file handle, conditional response
or cached permission for a later request. Atomic replacement makes a read observe a
complete old or new record, never a partial JSON update.

A confirmed HTTP admission pause means that requests beginning at the gateway after
acknowledgment cannot use the withheld route. Requests already received can finish,
including one whose old-file read began before replacement but completed afterward.
Pause does not drain those requests or terminate WebSockets. Compatible migrations and
the existing session, queue and cron controls remain necessary.

A [local Docker mechanism check](evidence/serving-authority-disk-local.json) now
observes fresh active, paused and replacement records through a separate read-only
workerd reader. It checks an earlier open read, staging siblings, publisher stop
and reader restart. The measured backing filesystem is ext4 inside Docker Desktop's
Linux VM. An independent audit checks executed sources, actual files, executable hash,
mounts and preserved resource states. This does not qualify the production gateway,
new route schema, two-store crash protocol, another engine or power-loss durability.

Validation: keep one old read open across replacement, then start separate requests
after pause acknowledgment. The earlier request may complete; every later request must
observe the withheld route. Repeat across gateway restart, concurrent requests, record
replacement and controller loss in the actual candidate runtime. Reject any
implementation whose disk service retains stale permission for a new request.

## Persist intent, withhold, then change the backend

Private controller state retains the settled public record revision and digest. Each
route publication also has a durable `routeAuthority.pending` intent containing its
operation identity, direction, previous and intended revisions, intended record
digest, and exact approval identity where applicable. Table revisions are global and
publications are serialized, preserving unrelated app entries. Clearing an intent
records the newly settled revision/digest; it never discards that reference.

The candidate [publication core](../packages/platform/src/route-publication.mjs)
and [portable record codec](../packages/runtime/src/route-record.mjs) implement
this protocol without changing the admitted family. The gateway must apply the same
codec against its sealed identity and slot policy. Revisions use canonical unsigned
64-bit decimal strings; exhaustion refuses further publication. Public files use the
canonical encoding so a settled digest identifies exact file bytes. The public writer
requires an existing dedicated directory and never creates a missing mount path.
The directory must allow traversal by the separate gateway UID without relying on
a shared group. Topology inspection must separately establish the actual mount and
sole writer.

An explicit withdrawal of pending active permission reserves a later revision and
retains the superseded active decision in its private intent. Recovery must recognize
the old settled, superseded active and new withheld records across an interrupted
withdrawal. It must never assign different decisions the same revision. A failed
read-only runtime verification leaves the decision unresolved but permits this
withdrawal; uncertain persistence still requires durable reload first. Resuming a
settled paused route selects its exact completed approval, confirms fresh withholding
and runtime identity/readiness, then publishes active permission. Withdrawing permission
retains any existing approval hold, so a pause cannot authorize an older release after
a failed update. A corrected approval must explicitly select the failed, superseded or current
completed hold it replaces. Only an activating corrected approval can use that path;
a completed older approval cannot replace an unfinished update hold.

The controller must await the core's per-app withheld assertion before an
HTTP-affecting backend effect. Its read-only runtime verification callback must not
re-enter queued publication methods; the controller owns backend serialization.
The active-publication method belongs only to activation completion after backend
readiness; operator unpause and interrupted publication use the verified resume and
reconciliation methods.

The [stopped retirement transform](../packages/platform/src/route-retirement.mjs)
removes the retired host, preserves peers and binds the resulting stores to the
target installation identity. It grants no live-write permission. The candidate
[controller integration](../packages/platform/src/controller-routes.mjs) composes
publication explicitly with an independent policy, separate public path and read-only
runtime verification callback. The public authority directory and private controller
directory cannot contain one another, including through path aliases checked at open;
actual mount isolation still requires the launch inventory checks. Default controllers still reject authority-bearing
state. No environment switch or catalog entry enables this constructor composition.
Sealed launch configuration and stopped recovery integration remain required
before it can serve an application.

Validation: the [publication tests](../packages/platform/test/route-publication.test.mjs)
exercise interrupted writes, reload, active withdrawal and resume, peer preservation,
retirement and slot reuse against temporary files. The [record tests](../packages/runtime/test/route-record.test.mjs)
exercise policy, approval identity, canonical encoding and revision bounds. These host
checks do not establish native fsync ordering, mount isolation or gateway behavior.

Before an HTTP-affecting backend effect, persist the withholding intent bound to the
exact approval and desired withheld route revision. Atomically replace the public
route record with that withheld revision, fsync the file and directory, and confirm
completion before starting the effect or acknowledging HTTP pause. Migration-ledger
reconciliation, claim, publication, ownership reassignment and restored-data changes
are HTTP-affecting effects. Merely changing the controller's in-memory route or saving
its private intent does not establish the pause.

If either store write fails or its outcome is uncertain, latch further backend changes
closed and expose route-publication uncertainty. Do not begin a different release or
infer pause from an unreachable controller. A failed pause publication can leave the
last approved route serving indefinitely while the controller cannot write; that is an
explicit change from today's immediate lookup-based refusal on metadata failure. No
backend-changing effect may proceed in that state. An operator who needs the
installation offline can use its existing ordered stop command. A latched controller
supplies no new per-app kill switch; that emergency action stops the whole
installation.

After the backend and readiness checks succeed, persist the completed approval and its
active-publication intent in the same private save before publishing the corresponding
active route. Clear that intent only after durable public publication is confirmed.
Active permission can never lead the exact durable approval. If final publication is
uncertain, report it separately from backend completion. Further activation, snapshot
preparation and retirement require settled matching authority, rather than only the
private `route` field. A separate explicit publication-reconciliation operation must
identify the exact intent and approval, re-verify runtime identity/readiness, and
publish or withhold that decision without replaying migrations or approving another
artifact.

| Last completed step | Possible public route after interruption | Allowed next action |
| --- | --- | --- |
| Private intent persisted | Previous approved route or withheld route | Establish durable withholding before any effect |
| Withholding durably published | Withheld route | Explicit supported retry or corrected approval under existing hold rules |
| Backend changed or partially changed; completion not durably saved | Withheld route | Reconcile the original approval; never infer success |
| Completed approval persisted | Withheld or exactly matching active route | Explicitly reconcile publication and runtime identity |
| Active route durably published | Exactly matching active route | Serve; a later change requires a new withholding intent |

Failed activation retains withholding until an explicit supported retry or corrected
approval succeeds. Do not automatically republish the previous route: partial
migrations or an uncertain publication can make its old approval pointer insufficient
to establish safe runtime/data compatibility. This preserves the current failure
contract and its downtime cost. Automatic rollback and zero-downtime updates need
separate compatibility and effect-reconciliation work.

Validation: terminate the controller before/after file creation, rename, file fsync,
directory fsync, private saves and each backend effect. Inject write uncertainty at
each store. Verify the actual route and first backend effect, rather than accepting an
operation status alone. No crash state may serve unapproved code or begin an effect
without durable withholding.

## Activation, startup and recovery integration

Apply the same publication interface at every route transition. The implementation
inventory includes [activation preparation](../packages/platform/src/controller.mjs),
[activation completion/failure](../packages/platform/src/activation.mjs), [queue
replacement](../packages/platform/src/queue-replacement.mjs), [queue interruption/hold
recovery](../packages/platform/src/queue-activation.mjs), [cron interruption/hold
recovery](../packages/platform/src/cron-activation.mjs), and
[queue](../packages/platform/src/queue-recovery.mjs) and
[cron](../packages/platform/src/cron-recovery.mjs) recovery acknowledgment. Include
[claim rejection and discovered owners](../packages/platform/src/claims.mjs), startup
queue/cron snapshot recovery, and the offline [retirement
transform](../packages/cli/src/recovery/retirement-plan.mjs) and [restore
path](../packages/cli/src/recovery/restore.mjs). Rejection of a pristine unclaimed
reservation must remove its withheld public entry before freeing the slot; otherwise
that entry prevents another app from using the fleet. The candidate claim-release
publication retains the private reservation through public removal; an interruption
can finish removal without freeing the slot or replaying the rejected approval. Keep this inventory with the
implementation review; a new route write cannot bypass it.

Controller restart does not rewrite active authority merely because it restarts. Load
and compare both stores before changing the backend. An unfinished intent identifies
exactly which old/new records are possible. Startup may complete pending withholding
automatically, but cannot perform its backend effects automatically. Pending active
publication with a withheld public record stays withheld until explicit verified
reconciliation. If the public active record already matches the completed approval and
pending intent, it can keep serving; reconciliation verifies and clears that intent
rather than automatically withdrawing the valid route. Public authority ahead of the
private settled/intent revisions, or a mismatched digest, is a mixed-generation
restore error: withhold affected entries before proceeding and keep ingress stopped if
withholding cannot be confirmed. Startup cannot regenerate active authority from an
older private pointer. Ownership inspection that only reads backend state may run
without an HTTP pause. Any resulting quarantine must publish withholding; its desired
state alone cannot be described as confirmed ingress refusal. Held queue/cron pause
reconciliation remains independent of HTTP admission unless it also changes
HTTP-observable runtime or data.

The controller candidate publishes a permission-only quarantine when a settled public
entry cannot be matched to private ownership or completed approval. This preserves the
entry's actual host and fleet while withholding it; it never adopts that ownership or
regenerates active permission. Startup still refuses until the metadata is reconciled.
An interrupted quarantine may resume permission reduction without backend effects.

A valid pending active decision blocks other publications. If another active entry
needs withholding at that point, the candidate reports
`ROUTE_STARTUP_UNRECONCILED` rather than claiming successful startup or withdrawing the
valid pending app automatically. Launch integration must keep ingress stopped and
provide a control-only recovery path for the exact pending decision. After explicit
reconciliation, the controller repeats withholding and background recovery before it
can report ready. Enforcing this boundary in the actual launch coordinator remains a
release gate; the constructor API alone cannot stop a separately running gateway.

Ownership inspection must finish before an explicit reconciliation can run startup
recovery. Ordinary mutations, snapshot preparation and HTTP resume require startup
recovery to finish too. A permission-reduction command after failed initialization
cannot mark those phases complete. If initialization fails before ownership inspection,
restart with corrected storage/configuration before increasing permissions; a pause
alone never turns the controller ready. Pending-active withdrawal preserves the actual
public host/fleet even when the private slot differs, and does not adopt that slot.

Queue and cron snapshot preparation intentionally requires active HTTP routing. It
pauses background execution and observes retained background state. Do not add an
HTTP-withholding precondition to those paths or equate a dispatch/delivery pause with
an HTTP pause. Preserve those preconditions in the new family's tests.

Full backup/restore and retirement still require the existing stopped-source and
stopped-gateway procedures. Capture the route-authority volume, reconcile it with
controller state and the target installation identity, and keep recovery-held apps
withheld before starting ingress. Full installation startup and restore must compare
both stores, sealed generation/identity and actual slot ownership before opening the
gateway. This can require controller/replica checks while ingress remains stopped. The
ordered startup procedure enforces these checks and starts ingress last; the gateway
itself cannot distinguish a restart from mixed-generation storage. Compose ordering
alone is insufficient without the completed pre-ingress check. A valid record alone
cannot authorize booting a mixed-generation installation. Never copy an active route
into a second live installation. Retirement and slot reuse must update the new
authority volume while all relevant writers and gateways remain stopped.
Runtime-family migration and cross-version restore remain outside this increment.

Validation: run failed and corrected approval, held queue replacement, cron recovery,
active-routing background snapshot preparation, stopped full restore, retirement and
slot reuse. Check both durable stores and app identity at every boundary.

The controller candidate shares background-hold transfer and HTTP withholding intent
in one private save. Restored queue/cron acknowledgment verifies runtime before
persisting acknowledgment with active-publication intent. Background snapshot
preparation checks actual public active authority and does not publish HTTP withholding.

The candidate admin routing API reads actual public authority and accepts exact
approval selections for pause, verified resume and pending-active reconciliation or
withdrawal. It uses the existing admin authentication and CSRF checks; submitter and
gateway credentials confer no routing control. The durable controller has no internal
route lookup endpoint. The existing approval page selects HTTP hold predecessors for corrected approval.
The source [operator routing CLI](http-routing.md) exposes status, exact-approval
pause/resume and both pending-publication decisions, with real-controller
process/filesystem tests. The source [operator routing page](http-routing.md#use-the-operator-page)
adds standard forms and a restricted recovery view, with HTTP and local browser
checks. Native acceptance of both operator surfaces remains open.

Validation: the [controller integration tests](../packages/platform/test/controller-routes.test.mjs),
[background transition tests](../packages/platform/test/controller-route-background.test.mjs),
[restored recovery tests](../packages/platform/test/controller-route-recovery.test.mjs)
and [HTTP authorization tests](../packages/platform/test/controller-route-http.test.mjs)
observe real temporary authority/private files while substituting the backend. They
exercise the source protocol; they do not establish native runtime, image or mount
qualification.

## Pre-ingress observation candidate

A normal durable controller exposes `POST /v1/admin/routing/preflight` to the
operator, using admin authentication and the existing CSRF check. The request
contains only a fresh caller-generated 64-character lowercase hexadecimal
`challenge`. The [preflight](../packages/platform/src/route-preflight.mjs) runs under
controller serialization. It requires completed startup and settled private/public
authority, compares public permissions with private approvals and holds, and invokes
the configured read-only native verifier for every active host. A privately serving
app missing from the public table cannot pass as an empty installation. Withheld
entries confer no permission and their runtime availability is not checked.

After those observations, it re-reads settled authority and compares both its exact
byte digest and active approval/version/secret references with the initial snapshot.
Any pending decision, permission mismatch, runtime refusal or changed reference
returns an unconfirmed 503. On an otherwise available controller, invalid challenge
requests return 400 before their authority reads; requests still join controller serialization, and existing
storage or recovery refusal can take precedence.

HTTP hold lookups use only own entries, so a valid app name such as `constructor`
cannot inherit a hold from the JavaScript object prototype. A successful report
contains schema version 1, the echoed challenge, public
`authority.record`, its raw-byte `authority.sha256`, and `observedActiveHosts`.
Native versions, secret revisions and runtime diagnostics remain private.

This report describes an observation interval. It grants no routing permission,
freezes no later controller work, initializes no storage and starts no gateway. The
report is trustworthy only over the authenticated admin channel; the echoed challenge is not a signature or proof for a third party. The caller must correlate
the challenge with its own current request; an old report cannot authorize a later launch. The host still must keep ingress stopped, verify
actual sealed mounts/images/generation and writer exclusion, and apply the ordered
startup procedure. A report with no active hosts proves no native availability or
whole-installation storage health. The verifier's existing timeout limits apply;
there is no new whole-operation storage deadline.

The restricted recovery service never exposes this endpoint, including after an
exact reconciliation makes its startup-complete field true. The controller instance
retains that restriction too: direct preflight calls and construction of another
ordinary HTTP listener on the marked instance are refused. Restart normally after
the complete launch checks; lookup-family services have no such endpoint. The
[preflight tests](../packages/platform/test/route-preflight.test.mjs) check real
temporary authority files, cross-app checks, changed references and serialized
mutations. [HTTP tests](../packages/platform/test/route-preflight-http.test.mjs)
check authorization, CSRF, error disclosure and recovery/lookup refusal. These source
tests do not close mount inventory, freshness authorization, gateway launch, stopped
restore or native qualification gates.

The [host preflight client](../packages/cli/src/runtime/route-preflight.mjs) now
generates its own fresh challenge, obtains CSRF through the authenticated admin
channel, and checks the returned record against an independently selected durable
profile. It checks the canonical record digest and exact active-host list. Both
HTTP requests and their bodies share a 30-second deadline; actual bytes are bounded
and UTF-8 is decoded strictly. Redirects, stale challenges, recovery-only service,
private errors and foreign authority cannot become an accepted observation.
The [client tests](../packages/cli/test/runtime-route-preflight.test.mjs) cover
those refusals; an [integration test](../packages/cli/test/runtime-route-preflight-controller.test.mjs)
exercises the actual enrolled controller service, authentication and CSRF. The
empty installation in that integration test proves no native application availability.

## Durable runtime profile and sealed layout candidate

The [runtime profile](../packages/platform/src/runtime-policy.mjs) uses schema 3
with exactly `routing: "durable"` and the dedicated `main-durable.mjs` controller
entrypoint. Schema 2 retains its lookup-family meaning. The
[catalog codec](../packages/cli/src/runtime/catalog.mjs) pairs that new profile
with a schema-2 durable-capable catalog entry; a legacy entry cannot authorize the
new execution mode, even if the image fields otherwise match. No such entry is
shipped yet. Storage/fleet installation identity retains the same hashing rules;
execution-mode compatibility is checked separately against the complete profile.

The [sealed layout builder](../packages/cli/src/runtime/durable-config.mjs) adds
separate owned `route-authority`, `gateway-policy` and `route-enrollment` volumes. Only the controller
writes authority; the gateway mounts authority and its policy read-only with image
seeding disabled. The enrollment-control volume is mounted only by the stopped initializer;
normal services never mount it. All declared volume mounts disable image seeding.
Application replicas mount none of these three roles. The gateway uses `serve-durable.mjs`,
keeps only transport/TLS environment fields, and joins only the two fleet networks.
It receives no controller binding, gateway token, storage credentials or admin
credentials. Retained configuration must match the reconstructed sealed layout
exactly; re-entry refuses drift rather than repairing it.

The [controller composition](../packages/platform/src/durable-startup.mjs) requires
that independently installed durable profile and fixes authority at
`/var/lib/fogd-routes/routes.json`. Missing or legacy profiles refuse that entrypoint;
ordinary controller startup refuses a durable profile without explicit durable
routing. Signed native identity proofs retain their existing version-2 protocol.

These are source integration steps, not an admitted installation path. The
[selected-runtime dispatcher](../packages/cli/src/runtime/start-installation.mjs)
routes durable installations through the retained-container coordinator below,
never through its legacy all-services Compose command. Fresh installation enrollment
and stopped restore have the source coordinators below. Native backup/restore
acceptance remains open. The legacy archive layout intentionally does not accept
the new volumes; the dedicated snapshot format below carries their data without
adopting execution authority. A new image and its native
acceptance evidence remain required before catalog admission.

## Fresh installation enrollment candidate

The [fresh coordinator](../packages/cli/src/runtime/durable-installation.mjs) checks
the independent family selection and cached image, confirms the target project,
volume and network names are absent, then reserves the private host installation
directory. It records a synced enrollment intent before creating installation
resources. It creates stopped, pinned containers without building or pulling and
allocates the separate enrollment-control volume. Actual inventory must match the
new sealed plan with every service stopped before any policy or route store is
initialized. An empty filesystem alone never authorizes that initialization.

The [policy installer](../packages/cli/src/runtime/durable-policies.mjs) writes the
full native policy and independently derived gateway plan through create-only
writers in the verified image, then checks both readbacks. The
[route initializer adapter](../packages/cli/src/runtime/durable-enrollment.mjs)
mounts only controller, authority and enrollment-control volumes into a networkless
Node helper. The [helper](../packages/platform/src/fresh-route-enrollment.mjs)
checks all three existing directories are empty, owned and disjoint before setting
permissions, issuing and spending the one-use grant, and initializing route stores.
It starts no application, listener or backend operation. Its paths are fixed by the
entrypoint; serialized input cannot select them. Helpers prohibit image pulls and
volume seeding, receive no provider credentials, and return bounded checked receipts.

The [host record](../packages/cli/src/runtime/enrollment-record.mjs) retains both
`enrollment.pending.json` and `enrollment.complete.json` permanently. Completion
binds the original intent, installation identity, canonical full-plan digest and
inspected resource identity. It is published only after policies, route stores,
receipts and stopped inventory agree and all helpers have returned. No Docker or
runtime write follows that publication. A partial attempt cannot silently retry as
fresh: its resources and intent remain, and ordinary CLI readiness refuses it.
Retained durable startup requires a matching completed host record; marker absence
does not provide a legacy fallback for schema 3. These host records lift an
enrollment refusal, not the independent runtime, storage and ingress gates.

The [pipeline test](../packages/cli/test/runtime-durable-installation.test.mjs)
translates fixed Docker helper calls into the actual filesystem writer, grant and
publication functions, then starts an ordinary source controller on those stores.
It checks the whole source sequence without executing Docker or the helper image.
Other tests cover incomplete enrollment readiness, preserved records, changed
inventory, retained directories and create-only refusal. Native mount/UID identity,
daemon behavior and first-app deployment still need qualification. Interrupted
enrollment reconciliation and native backup/restore acceptance remain open; no new catalog entry or
default cron admission is enabled.

## Retained installation startup candidate

The [host coordinator](../packages/cli/src/runtime/durable-launch.mjs) starts an
already enrolled, stopped installation. It authorizes the full profile against the
independent catalog, verifies pinned images, checks recovery fences and validates
the installed TLS material. It creates no container, volume or policy, pulls no
image, initializes no authority and runs no application migration. The durable
gateway has restart policy `no`: Docker must not reopen ingress automatically
after daemon or host restart, bypassing the pre-ingress checks.

The first retained inventory must match `inventoryBinding` in the completed
enrollment record. The enrolled resource identity must match even when the sealed
configuration and resource names are unchanged. A mismatch refuses before starting
installation services and retains enrollment records and resources. The
[launch regression test](../packages/cli/test/runtime-durable-launch.test.mjs)
checks that a consistently replaced inventory cannot reuse the earlier enrollment.
Recreated resources must use a fresh installation or stopped-restore target with
its own enrollment record.

The [inventory inspector](../packages/cli/src/runtime/durable-inventory.mjs) checks
actual container IDs, images, commands, inherited environment, privileges, mounts,
ports and networks against the sealed layout. It checks every declared volume and
network, including the new routing roles. Foreign containers, including stopped
ones, cannot retain installation-volume or network access. Known bind paths that
overlap volume mountpoints also refuse. This is a local observation, not proof
against privileged writers, arbitrary host path aliases or later Docker mutations.

The [store reader](../packages/cli/src/runtime/durable-stores.mjs) uses sequential
read-only, networkless helpers in the verified image to compare installed gateway
policy and authority with independently derived expectations. The coordinator also
reads back the complete installed native policy. After starting inspected storage,
replica and controller IDs, it obtains a fresh authenticated controller preflight,
then re-reads stores and policy and repeats inventory checks. It compares container
start times as well as immutable identities before opening the inspected gateway
ID last, then inspects again. Readiness retries have a 90-second deadline; the
HTTP client's own bounded reads share that cancellation signal. The admin endpoint
uses the declared published port or an explicit operator `FOGD_SERVER` origin;
remote cleartext and mismatched TLS configuration refuse.

The [launch fence](../packages/cli/src/runtime/launch-fence.mjs) serializes cooperating
CLI attempts using the same private host enrollment directory. A synced exclusive
marker precedes mutations and records checking, starting, preflight, ingress and
completion. An existing or incomplete marker always refuses; PID absence never
reclaims it. Read-only checking failures may release their own marker. Once a start
is attempted, failure retains it and attempts to stop the known gateway ID. Failed
commands or cleanup leave ingress state unconfirmed, not proven stopped. After
verified completion, uncertain fence release cannot trigger another Docker mutation
that races a successor. Interrupted-attempt reconciliation is still an open gate;
there is no automatic marker deletion or force-reset command.

The [coordinator tests](../packages/cli/test/runtime-durable-launch.test.mjs) use real
fence files and substituted Docker observations/effects. Inventory and store-reader
tests use command fixtures; fence tests cover real competing processes and abrupt
termination. These establish source ordering and refusal behavior. They run no
Docker or application runtime and do not establish daemon-version compatibility,
physical mount freshness, controller-loss serving, recovery or native acceptance.

## Retained installation shutdown candidate

`fogd stop --installation PROJECT` dispatches a durable host configuration to the
[shutdown coordinator](../packages/cli/src/runtime/durable-stop.mjs). It matches
the pinned family against the independent catalog and reconstructs the exact sealed
plan before reading project containers. It executes no image and does not require
healthy policy stores, completed enrollment or application credentials. Missing
services and volumes can be reported without recreating them.

Startup and shutdown share the same exclusive host operation marker. Shutdown
records `operation: "stop"` and advances through checking, stopping and completion.
An existing marker refuses either operation. Checking failures can release their
own marker; a failed stop retains it. There is no automatic marker reclamation.

Shutdown targets inspected container IDs, with gateway first. It verifies the same
gateway ID is stopped before stopping controller, replicas and storage. A changed
project inventory, surviving process, running volume writer or disappearing volume
prevents a successful report. Configuration, enrollment records, containers,
networks and volumes are retained. Background pause controls are unchanged; this
command creates no snapshot and proves no storage-health or application-drain
guarantee.

[Source tests](../packages/cli/test/runtime-durable-stop.test.mjs) cover operation
exclusion, partial installations, uncertain commands, retained records and changed
inventory. The [public command test](../packages/cli/test/installation-stop.test.mjs)
uses an isolated synthetic catalog and fake Docker executable. It checks dispatch
without changing shipped admission. Actual daemon shutdown and native durability
still need qualification.

## Stopped durable snapshot candidate

The [backup coordinator](../packages/cli/src/recovery/durable-backup.mjs) requires
an independently authorized durable profile, verified cached image, matching host
enrollment and installed native policy. It inspects the sealed resource inventory,
checks background capabilities and reserves a new private output directory before
requesting queue or scheduled snapshot preparation. Existing output is never
replaced. Preparation may leave background execution paused if a later step fails.

The shutdown scope holds the shared operation fence through archive creation and
verification. It stops ingress first and checks stopped processes and volume
writers before and after the archive task. The task compares the inspected resource
identity before copying and before publishing the manifest. All volume helpers
mount source data read-only without image seeding, prohibit image pulls and use
fixed executable entrypoints in the independently verified image.

`fogd-stopped-durable-v1` archives controller, bucket, native replica and optional
TLS data plus `route-authority.tar`. It excludes runtime policy, gateway policy,
enrollment-control storage and host enrollment records. Those remain independently
selected or newly issued execution authority. The controller archive retains its
old route directory references as source metadata; copying them cannot enroll new
mounts.

The [pair validator](../packages/platform/src/route-snapshot.mjs) requires a settled
private journal with no pending publication, the exact canonical public record and
matching digest and revision. It shares application/approval/hold checks with live
preflight. Unknown capabilities and inconsistent active or withheld routes refuse.
This is a source consistency check; it makes no backend availability observation.

The [bundle verifier](../packages/cli/src/recovery/durable-bundle.mjs) takes the full
profile independently from its caller. It checks the sealed configuration, exact
archive inventory, pinned image IDs and checksums, then reads the actual controller
and authority members without filesystem extraction. Public authority must be one
regular canonical `routes.json` member with bounded output. Interpreted metadata
is checksummed again after parsing. Background evidence must match the archived
state. Snapshot completion is reported only after this verification and the final
stopped-process checks. Failure retains the operation marker and partial files.

[Pipeline tests](../packages/cli/test/durable-backup.test.mjs) exercise real
filesystem initialization, shutdown fences, tar files and bundle verification with
substituted Docker metadata and transport. The positive pipeline is empty;
[bundle tests](../packages/cli/test/durable-bundle.test.mjs) also cover active and
withheld source pairs. These tests execute no Docker or native application runtime.
Legacy-family restore refuses this format. The durable coordinator below integrates
independent selection, fresh mount enrollment, source-writer checks and held
background recovery. Actual backup/restore durability and native acceptance remain
open; no catalog or default cron admission changes.

## Stopped destination routing restoration candidate

The [host planner](../packages/cli/src/runtime/durable-recovery-plan.mjs) takes an
independently selected durable-capable catalog entry and externally recorded source
identity. Its filesystem reader verifies the actual snapshot and derives a digest
from the manifest bytes. The target project must differ from the source. Native
node IDs, storage prefixes, application approvals and secrets remain source data;
target volume and network names are canonical for the new project. Network
placement comes only from the independent target selection. Snapshot data cannot
select another runtime image, execution mode or public listener policy.

The [stopped finalizer](../packages/platform/src/route-restoration.mjs) operates
only on the exact empty stores produced by fresh enrollment. It checks the original
grant, its complete spent marker, full target profile, inventory binding and current
directory identities. The controller state must still match the empty initialization
state; restored controller data files may sit beside it. The target authority must
still contain only the canonical empty revision-zero record.

Before changing either store, the finalizer exclusively creates and syncs a
permanent `route-restoration.spent.json` marker bound to the original grant,
installation, inventory and snapshot. Any existing or partial marker blocks replay.
It projects the checked source onto a new settled revision-one record with every
HTTP route withheld. Formerly active approvals receive exact HTTP holds; existing
holds remain. Nonretired apps are HTTP-paused. Qualified queue and cron snapshot
receipts become pending recovery records, and their consumed snapshot fields are
removed. Missing, expired or unacknowledged background recovery evidence refuses.
The helper resumes no background work and makes no backend call.

Private state is written before public authority, then both readbacks are checked.
The private state uses the destination's enrollment targets, never copied source
directory references. Failures after spending retain all stores and the marker.
An interrupted mismatch is not an ordinary publication intent and cannot silently
replay. A lost acknowledgment can leave a consistent pair; the host enrollment
must remain incomplete until the restore coordinator confirms the whole operation.
HTTP resume and background recovery acknowledgment remain separate operator acts.

The [CLI adapter](../packages/cli/src/runtime/durable-restoration.mjs) fixes the
three mount paths and executable, prohibits image pulls and volume seeding, and
checks a bounded receipt against its own withheld-record digest. Serialized input
cannot select paths, publishers or force flags. The helper receives no network or
provider environment. [Filesystem tests](../packages/platform/test/route-restoration.test.mjs)
cover fresh enrollment, copied bindings, replay refusal, private/public write faults,
source controller approvals, target controller startup, HTTP resume and queue/cron
pending recovery. [Host tests](../packages/cli/test/runtime-durable-restoration.test.mjs)
connect the adapter to actual temporary stores without Docker execution.

The restore coordinator below composes these source components with data copying,
independent policy installation and final host enrollment. Native mount identity,
storage durability and complete backup/restore acceptance remain open.

## Stopped durable restore coordinator candidate

The [restore command](../packages/cli/src/recovery/restore.mjs) dispatches to the
[durable coordinator](../packages/cli/src/recovery/durable-restore.mjs) only when
the independently selected catalog entry supports durable routing. A legacy entry
cannot adopt the new format; a durable entry cannot migrate a legacy archive.
No durable-capable entry is shipped, so ordinary admission remains closed.

The coordinator verifies actual snapshot bytes and cached images, checks source
and related writers, and requires new output outside the source bundle. It holds
the source's host operation fence when that source is enrolled in the current
`FOGD_HOME`. A competing local startup or maintenance operation then refuses.
This does not fence another checkout, engine, remote host or privileged writer;
the operator must keep every source copy stopped.

The shared [enrollment coordinator](../packages/cli/src/runtime/durable-installation.mjs)
reserves destination configuration and a permanent incomplete host record before
resource creation. It records the source relationship, creates stopped resources,
installs execution policies independently and initializes the empty route stores.
Restore tasks run inside that incomplete enrollment, before the completion record.

The [data restorer](../packages/cli/src/recovery/durable-restore-data.mjs) checks
every data target before copying. Bucket, replica and optional TLS volumes must be
empty. Controller storage may contain only its initialized `state.json`. Each fixed
helper mounts one destination volume, prohibits pulls and image seeding, and uses
fixed Node, tar and sync executables without archive-supplied commands. Extraction
gets only the capabilities needed for numeric ownership restoration.

Only data archives are copied. The root source `state.json` is excluded, while
nested application files with that name are preserved. Existing files cannot be
overwritten; the controller state's bytes, inode, owner, permissions, link count
and timestamps must remain identical through extraction. Symlink and hardlink
aliases refuse. Restored files are synced and compared against their archives.
No route authority, execution policy or enrollment-control archive is extracted.

After copying, source writers and snapshot metadata are checked again. The route
finalizer binds the verified source data to the fresh destination, withholds HTTP
and creates pending queue/cron recovery. The coordinator rereads native policy and
rechecks source exclusion. It writes prepared output that explicitly still requires
host enrollment. The enrollment coordinator then compares route-store readbacks,
requires unchanged stopped inventory, and publishes host completion last. No
Docker or runtime write follows completion, including uncertain source-fence release.

Copy, comparison, source-writer, rebinding or final-inventory failure retains the
partial target and incomplete enrollment. Prepared output cannot bypass that
record. A completed target remains stopped; start uses the retained ingress-last
coordinator. HTTP resume and background acknowledgment/resume stay explicit.
Restoring old credentials and application state can resurrect access or replay
effects, so application reconciliation remains necessary.

[Source integration tests](../packages/cli/test/durable-restore.test.mjs) use actual
controller approval, artifact files, private data, GNU tar extraction/comparison,
fresh route enrollment, route rebinding and permanent host records. Docker
inventory and transport are substituted; archive ownership is aligned with the
unprivileged host test identity. They also exercise target controller startup with
substituted ownership reads. [Data tests](../packages/cli/test/durable-restore-data.test.mjs)
cover aliases, partial extraction and comparison failure. No Docker, native
application, native root-ownership or cross-engine recovery trial was run. Those
acceptance gates remain open.

## One-use route enrollment candidate

The [enrollment primitive](../packages/platform/src/route-enrollment.mjs) maintains
separate private host control storage. Issuance creates an exclusive, synced grant
bound to the complete independently selected native profile, installation identity,
a host-supplied inventory binding and canonical controller/authority/enrollment
paths with their filesystem device and inode identities.
The three directories must already exist, have the expected owner and permissions,
be separate and be empty. Grant and spent files use mode 0600; enrollment and
controller directories use 0700, while authority requires 0755 so the separate
gateway UID can traverse and read it. Missing paths are never created by enrollment.

These filesystem checks do not prove that mounts are newly allocated or that writers
are stopped. Only a trusted fresh-enrollment coordinator may issue a grant, after
checking actual sealed mounts, images, storage generation and writer exclusion. Its
binding must identify that independently verified inventory. The primitive validates
the supplied binding as data; it cannot establish those external facts. The fresh
coordinator supplies these source checks; native qualification remains open. It must establish
that the initializer and controller use the same effective UID and stable canonical
paths, device numbers and inodes across their actual mounts and supported restarts.
It must hold writer exclusion
until the initializer is confirmed terminal before ordinary controller startup,
including after an uncertain result. A spent grant is not a process lock; ordinary
startup can resume a retained intent and must never overlap its initializer.
Enrollment control storage must not be mounted into application replicas or the gateway, nor adopted from a data
backup as execution authority.

Spending checks the grant and target stores, then creates an exclusive spent marker
and syncs it before either route store can be initialized. Any existing spent marker,
even an incomplete or unreadable one, prevents replay. Concurrent attempts cannot both
spend the same grant. Invalid profile, binding, grant identity, copied control path or
retained target data refuse without initialization. Existing records and uncertain
markers are preserved; restarting or changing a configuration flag cannot reset them.

The [stopped initializer](../packages/platform/src/route-initialize.mjs) then runs the
existing publication protocol: create the first private initialization intent without
overwriting a state file, exclusively publish empty authority, and settle the private
reference. The private state retains the enrolled controller and authority directory
paths, devices and inodes. Ordinary startup checks these identities before reading or
resuming public authority, including after initialization settles. Moving or replacing
either store requires the separate recovery contract; a copied empty record cannot
authorize a different directory. The initializer starts no listener or gateway and
invokes no backend, credentials or secret-materialization path. Production controller
startup has no initialization flag and requires retained enrollment state before any
secrets, execution or artifact-directory writes. A retained
initialization intent can finish through the existing crash protocol without another
grant; missing retained authority outside that intent still refuses. If an attempt
stops after spending but before any private intent exists, it cannot be replayed:
retain those resources and use an independently fresh enrollment rather than deleting
its marker or treating empty storage as authorization. The coordinator must refuse
rebinding those failed targets through a newly chosen grant directory as well;
creating another control directory is not evidence of fresh target storage.

The [enrollment tests](../packages/platform/test/route-enrollment.test.mjs) exercise
real temporary files, profile/layout binding, permissions, copied grants, competing
initializers, partial spent markers, retained-data refusal, ordinary recovery of
interrupted initialization, directory rebinding refusal, and failures before/after
real public creation through the initializer's trusted publisher seam. The tests
consume the actual grant and inspect its real persisted private intent. These source
tests do not qualify physical mount freshness, whole-installation recovery, gateway
startup or power-loss behavior.

## Candidate controller startup and restricted recovery

An explicit programmatic `startController` option accepts an absolute path to the
fixed `routes.json` record. It requires retained route state and rejects a `fresh`
setting, including a stale false-valued flag; first initialization uses the dedicated
stopped enrollment path above. The [startup composition](../packages/platform/src/startup-routing.mjs)
derives expected installation identity and fleet slots from the independently
installed native runtime profile. It supplies the read-only production verifier;
the route-authority input cannot substitute a public identity or a nominal
verification callback. The normal entry point reads the dedicated installed policy
volume; an injected policy reader remains a trusted internal launcher seam. Neither an environment setting nor the current catalog selects this option. The
caller must establish actual mounts, sole writers and completed enrollment before
using it. Ordinary startup can finish a retained initialization intent on its bound
stores; it cannot recreate missing authority after that initialization settles.

The [controller service](../packages/platform/src/controller-service.mjs) awaits
initialization before listening. A typed unresolved-routing error after ownership
inspection, or an unresolved pending decision after initialization, opens an
authenticated recovery API. Failure before ownership inspection, uncertain storage,
invalid configuration and unrelated errors refuse startup. Durable services open no
legacy internal route listener. Listener failure closes any listeners already opened
by that service and preserves unrelated listeners.

The recovery API exposes admin status and actual per-app public routing views. It
allows only HTTP pause, exact pending-active reconciliation and exact pending-active
withdrawal through the existing admin authentication and CSRF checks. Uploads,
approvals, credentials, secrets, background operations and ordinary HTTP resume stay
unavailable. `GET /v1/admin` reports `recoveryOnly`, `routingStartupComplete` and
`ingress: "keep-stopped"`. A failed response can follow a persisted pending decision if subsequent startup
recovery fails; inspect the actual routing view and pending intent before retrying.
The startup-complete field can become true after an exact reconciliation, but this listener stays restricted for its lifetime. The launch
procedure must check the complete sealed installation and restart normally before
opening ingress. A ready admin listener alone is not permission to start a gateway. Direct HTTP
server construction also refuses ordinary service on an unreconciled durable
controller. Some ownership/storage mismatches expose diagnostics but cannot be
repaired through this API; those require stopped repair or matching storage restore.
After an exact pending decision, the controller repeats withholding and existing
background startup recovery. That can re-establish a held queue pause or its
bootstrap readiness; it does not approve or replay the failed activation.

The [service tests](../packages/platform/test/controller-service.test.mjs) use real
private/public temporary files and HTTP listeners to check these boundaries,
reconciliation and withdrawal without replaying activation, controlled held-queue
pause recovery behind public withholding, and listener collisions. Startup tests
exercise enrolled source composition with substituted backend ownership reads. These do not establish actual mounts, gateway ordering, fresh-volume
authorization, stopped restore or native qualification.

## Read-only runtime verification candidate

The [runtime verifier](../packages/platform/src/route-runtime.mjs) supplies the
controller callback for verified HTTP resume and pending-publication reconciliation.
Its production adapter validates the independent installed runtime profile against
the backend environment. It checks the exact current completed approval, configured
fleet, native version and storage owner. Signed identity verification returns a
fingerprint of the verified process membership; matching fingerprints bracket GET
reads of each replica's version, native health and version again. Owner and approval
references are checked again before success. A changed process, version, owner or
approval refuses verification. Lease renewal alone does not change the fingerprint.

This callback sends no reload, deploy, migration, queue or cron commands, and no
application requests. Native health is separate from application outcomes and storage
durability. Each state/health HTTP read has a three-second deadline; state JSON is
limited to four MiB of actual bytes and strict UTF-8. Identity and lease reads retain
their existing five-second limits. Failures expose a fixed refusal without private
runtime bodies. The controller must serialize backend work around verification, and
launch checks must exclude other live writers. Owner reads retain the backend
storage client's timeout behavior; the per-HTTP deadline does not bound the whole verification. Identity, state and health use
separate ports on a hostname: sealed topology must bind those ports to the expected
native process and supervisor. The fingerprint is not attestation of arbitrary HTTP
responders. These observations do not fence a later process failure or privileged
storage replacement.

The [verifier tests](../packages/platform/test/route-runtime.test.mjs) check failure
boundaries and actual public withholding through controller pause/resume. The
[adapter tests](../packages/platform/test/route-runtime-backend.test.mjs) exercise
signed challenge proofs, executable hashing and storage lease checks with local
fixtures and substituted network/storage reads. They establish source behavior,
not native qualification. The explicit startup composition below uses this adapter;
the retained startup coordinator supplies source inventory and pre-ingress checks.
Their actual daemon and native behavior remain unqualified. This module enables no
runtime family.

## Gateway candidate implementation

The [durable gateway](../packages/runtime/src/gateway-durable.js) reads the fixed
record through its private authority binding on every request, including its health
endpoint. The [reader](../packages/runtime/src/gateway-authority.mjs) requires a
complete HTTP 200 response, bounds actual bytes at 65,536, decodes UTF-8 strictly,
and applies the shared record codec against an independent configured policy. A
three-second read deadline bounds unavailable authority; it is not a permission
lease. Failure never reuses an earlier route decision. Health reports readable
routing authority, not application or storage health.

The [configuration renderer](../packages/runtime/src/gateway-durable-config.mjs)
provides a read-only disk service, only the declared replica bindings, and no
controller binding or outbound internet access. The
[program preparer](../packages/runtime/src/gateway-durable-program.mjs) stages the
complete module graph and optional TLS material outside the authority directory.
It requires existing directories and does not start a runtime. Its caller must
establish sealed policy, actual mount isolation and completed startup recovery.
The candidate has no host launch coordinator or catalog admission yet.

The separate [gateway entrypoint](../packages/runtime/src/serve-durable.mjs) runs
only when a future sealed installation explicitly selects it. Its
[launch policy reader](../packages/runtime/src/gateway-launch-policy.mjs) requires
`/var/lib/fogd-gateway/policy.json` from a dedicated host-controlled, read-only
mount. The schema-1 plan contains exactly `schema`, `policy` and `slots`: the
expected installation identity and the two declared fleet/replica bindings. It
contains no controller credential, TLS material, executable or path selection.
The host must derive that plan from its independently selected installation profile;
public route data cannot supply the expected identity. Missing, invalid, oversized,
symlinked or group/world-writable policy refuses startup without legacy fallback.
Reads bound actual bytes at 16,384 and decode UTF-8 strictly. These file checks do
not prove mount provenance or completion of the host's pre-ingress checks.

The [process supervisor](../packages/runtime/src/gateway-process.mjs) loads the
existing transport/TLS policy, stages the program, and starts the packaged workerd
executable with a fixed `*:8080` listener and `/var/lib/fogd-routes` authority path.
The [executable check](../packages/runtime/src/gateway-executable.mjs) requires a
regular executable with a Linux arm64 ELF preamble. It refuses the optional npm
Node shim so that the observed child is workerd itself. This format check does
not establish executable provenance or replace the host's pinned-image checks.
The supervisor passes an empty child environment, forwards SIGTERM/SIGINT, and waits for the
child's terminal `close` event before removing its own staged program and TLS files.
An error event alone cannot trigger cleanup while the child remains live. Nonzero
exit and signal termination remain failures; the supervisor does not restart the
child or alter authority. Signal handlers cover policy loading, staging and cleanup;
a signal before spawn aborts after any pending setup work completes. There is no
internal forced-shutdown deadline. SIGKILL or host failure can interrupt cleanup;
the supported topology must qualify its temporary-storage lifetime separately.
Its programmatic I/O seams are trusted internal inputs;
installed JSON cannot select them. It creates no authority or policy directory.

The [policy tests](../packages/runtime/test/gateway-launch-policy.test.mjs) use
real files. The [supervisor tests](../packages/runtime/test/gateway-process.test.mjs)
substitute short Node child processes to check actual exits, early and delayed
shutdown, private TLS staging, credential isolation and cleanup ordering. ELF
fixtures are inspected without execution. These tests execute no workerd or Docker
runtime. Native package compatibility, configuration parsing, TLS/exit behavior and
controller-loss serving still require qualification on the new image and topology.
This executable is not an ingress authorization: the host coordinator must verify
sealed images and mounts, exclusive writers, retained storage and current controller
preflight before starting it. The source restore coordinator preserves that ordering;
native backup/restore acceptance remains required.

The candidate forwarding helper preserves the existing gateway protections for
private paths, privileged headers, actual-origin headers, replica health selection
and sent-request non-replay. The pinned legacy gateway and launcher remain
byte-identical to avoid further drift from the frozen runtime inventory. The
controller candidate already changes pinned sources: exporting the qualified family
requires its matching frozen checkout, until a new family is qualified. The [gateway tests](../packages/runtime/test/gateway-durable.test.mjs)
cover fresh decisions, withheld/invalid/unavailable authority, stalled and oversized
reads, and forwarding protections. Host staging tests import the prepared module
graph. These tests do not establish native workerd timeout, configuration parsing,
disk freshness, mounts or controller-loss serving in the candidate topology; those
remain release gates.

## Release evidence and sequence

First prove fresh-read behavior and atomic replacement on the actual supported Linux
filesystem and workerd build. Then implement the publication interface with crash
checks, integrate every route transition, and update the sealed topology, storage
inventory, backup/restore and gateway binding. These change pinned runtime sources and
installation layout: they require a separately built and qualified family. The current
catalog and retained installations cannot be changed in place. The new gateway has no
controller route binding, and the new controller has no legacy internal route
endpoint; testing cannot accidentally succeed through that fallback.

Measure two applications through the current gateway, candidate gateway and direct
replicas during uploads, activation and controller loss. Retain raw latency,
throughput, authority-read counts, resource counters and write-ledger reconciliation.
An existing approved app should serve while the controller is stopped. A restarted
gateway within the same already reconciled installation generation should use its
valid durable authority without that process; this does not bypass the full
installation startup or restore checks. An unreadable authority volume must refuse.
Storage availability and native replica health remain separate dependencies; no
whole-stack availability claim follows.

Repeat the bounded filesystem check with the qualified cached image and a new
private output directory:

```sh
node scripts/serving-authority/check-disk.mjs .fogd/route-disk-NEW
```

It installs nothing, builds no image and starts no application or object store.
Each attempt retains one small scratch volume and its evidence; nonce-scoped
helpers are removed after completion or a handled failure. Forced termination of
the host harness can require local cleanup of its own labelled helpers. The check
writes fixture records only to its new volume, and refuses an existing output
directory. It verifies actual child exits and resource preservation before reporting
success. Minimal filesystem records are deliberately separate from the future
route-authority wire schema.

Release requires successful pause-boundary, crash-ordering, privacy, same-family
recovery and existing selected-admission gates. Preserve internal-path refusal,
privileged-header stripping, origin replacement, replica selection and non-replay.
Retain timeouts, unknown writes and storage-health failures in measurements. Multiple
controllers/gateways, remote filesystem coherence, broader app density and migration
from the current runtime family require separate contracts and evidence.

The [native gateway restart drill](evidence/operator-native-gateway-restart.json)
restarts the existing generation's gateway while its controller is confirmed stopped.
Both approved apps serve through the new gateway process, a D1/R2/Durable Object
write is acknowledged, and its record and body remain after controller return.
Application replicas do not restart during that drill.

The [native pause/resume crash matrix](evidence/operator-native-route-crashes.json)
observes successful directory-sync syscall exits in the actual controller before
sending SIGKILL. It uses the Linux [ptrace interface](https://man7.org/linux/man-pages/man2/ptrace.2.html)
without modifying runtime program files or adding product fault hooks. Six cases cover the
private intent, public commit and private settlement for withholding and resuming
the same approved release. Captured journals and public records validate against
the independent installed identity; every active target matches a completed approval.

Pending active publication opens restricted recovery. Owner mutations refuse;
exact withdrawal and verified reconciliation each pass while ingress stays stopped.
The listener remains restricted after either decision, and ordered stopped startup
precedes ingress. A settled active publication with a lost reply is inspected
without replaying that decision. The peer's four acknowledged records remain intact.

The [native update crash matrix](evidence/operator-native-activation-crashes.json)
adds eight boundaries: approval recorded, before migration, migration ledger recorded,
before publication, waiting for replicas, and the three active-publication stages.
Each candidate adds one SQL migration. Independent captured-state checks match
declared migration hashes, applied ledger entries, native SQL rows and completed
approvals. The first five cases recover through explicit approval of the same
artifact; pending active publication requires exact reconciliation or withdrawal
and ordered startup. The settled publication is inspected without another approval.
The original row and eight migration rows each remain exactly once, and the peer's
four records survive. A fresh stopped snapshot and retained startup preserve both
applications' data.

These process-crash cases change timing and do not qualify power loss or normal-load
performance. The ledger case observes both SQL and the controller ledger already
committed; it does not target a crash between those commits or inside a native SQL
transaction. Other first-claim boundaries and retirement crashes, restricted recovery
browser interaction, broader serving measurements and ordinary family release remain open.
The source durable retirement coordinator verifies the original snapshot pair and
changes only the retired fleet's namespace and native identities. Its stopped helper
removes the retired route and applies ordinary withheld-restoration rules to the
survivors before spending fresh enrollment. Component tests cover copying, empty
replacement disks, approval holds, interrupted publication and incomplete host
completion. A [separate v3 package](evidence/operator-durable-retirement-package.json)
contains this helper and preserves the native binaries. The
[v3 native retirement drill](evidence/operator-native-durable-retirement.json)
qualifies two consecutive HTTP-app retirements, different-name replacements and
ordinary recovery with both tombstones. Independent checks match captured journals
to installed profiles and host enrollment plans, verify five pinned artifact
digests, and compare all 47 stored files in the retired namespaces after recovered
apps acknowledge new writes.

An injected host exception after successful native finalization retains the spent
grant and the unstarted target with incomplete host enrollment. Startup refuses
before Docker contact; a different fresh target completes ordinary recovery.
This is not a process-crash or power-loss test. The
[last-app follow-up](evidence/operator-native-zero-live-recovery.json) retires the
remaining two apps, snapshots an installation with four tombstones and no live
routes, and restores it without creating approval holds. The native controller
reports both slots free. A newly approved app then starts empty and writes while
all retired names remain unavailable. Independent checks preserve the retirement
audits, pinned artifacts and all four retired namespace file maps.

Native background retirement and process-crash gates remain open, and no migration
from v2 is qualified. Both durable families retain candidate admission.

The [native first-claim follow-up](evidence/operator-native-first-claim-crash.json)
kills the controller after a successful private-directory fsync records ownership
confirmation, before migrations or application publication. Captured private and
public records bind the exact approval to a withheld route. After controller
recovery, the native bucket has the expected owner and no deployment objects; the
app returns 503 until explicit approval of the same artifact. That retry starts
with no records and accepts a write, while the peer retains its record. Independent
checks verify the captured route digest, host enrollment, seven artifact digests,
and unchanged stored bytes across four retired namespaces. This covers one
first-claim boundary on the same physical host, with HTTP-only fixtures. The full
first-claim matrix, retirement process crashes, background retirement and ordinary
candidate release remain open.

The [first-claim withholding matrix](evidence/operator-native-first-claim-withholding-crashes.json)
adds three native process kills after the private intent, public withholding record,
and private settlement directory fsyncs. Each new hostname begins without a route.
After restart, exact withholding is settled and native inspection finds neither a
fleet owner nor deployment objects. Exact rejection of two pristine reservations
removes their public entries and releases the slot without assigning ownership or
publishing code. Exact approval of the third starts an empty app and permits a write. The peer retains its
record across all three kills. Independent checks validate each captured record
pair, all nine retained artifact digests and unchanged bytes across four retired
namespaces. These three cuts precede native ownership and do not cover owner-write
uncertainty or interruption before private ownership confirmation.

The [native ownership confirmation gap](evidence/operator-native-ownership-confirmation-gap.json)
kills the controller after its confirmation staging-file fsync succeeds, before
rename over durable state. Captured durable state retains the original claim;
captured staged state differs only by removing that claim. The public route remains
withheld. After restart, native inspection finds the assigned owner and no deployment
objects. Rejection and approval of a different artifact refuse. Explicit approval of
the original artifact recovers without changing owner metadata, starts empty and
accepts a write while retaining the peer record. Independent checks verify both
state versions, the route digest, eight artifact digests and four retired namespace
file maps. This closes that process-crash boundary, not owner-write response
uncertainty, power-loss durability or ordinary runtime admission.

The [native retirement process-crash drill](evidence/operator-native-retirement-process-crashes.json)
kills the unmodified stopped finalizer at two completed directory-fsync boundaries.
After the private write, the target pair intentionally mismatches: private revision
1 and public revision 0. After the public write, both revisions match, but host
enrollment remains incomplete. Both targets retain their spent restoration markers,
unstarted services and empty replacement disks; startup refuses before contacting
Docker. A fresh target from the retained original snapshot completes retirement,
resumes the survivor only after exact approval and deploys a replacement app that
starts empty and accepts a write. Independent checks verify the original archived
state, native inventory bindings, helper restrictions, nine artifact digests and
unchanged bytes across five retired namespaces. No partial target is repaired or
helper replayed. Those two cuts do not cover interruption during marker creation,
partial writes or write outcome uncertainty. Background retirement and ordinary
release remain open.

The [additional retirement store cuts](evidence/operator-native-retirement-store-edges.json)
kill the native finalizer after consumption of the restoration grant, after each
staging-file sync and after each rename before directory sync. The tracer verifies
the rename paths and destination inode against the original temporary file. Captured
views include the fresh pair, staged projections, a mismatched pair and a matching
pair; every interrupted target remains stopped with incomplete host enrollment.
Startup refuses before Docker access in all five cases. Independent native readback
confirms the current private/public stores, spent markers and both retained staged
files, with archive and inventory bindings checked separately. The retained completed
installation restarts with its two saved records, nine artifacts and five retired
namespace file maps unchanged. No interrupted helper is replayed or partial target
repaired. Partial marker/file writes, injected I/O outcome uncertainty, power loss,
background retirement and ordinary release remain outside these process cuts after
successful system calls.

The [native retirement I/O fault drill](evidence/operator-native-retirement-io-faults.json)
adds three partial writes and three error reports after successful directory syncs.
For the marker, private staging file and public staging file, the tracer limits the
write count, verifies the actual short return and prefix bytes, then kills the helper.
For the grant, private and public directory syncs, it observes kernel success, reports
`EIO` to the process and verifies failure exit with restoration uncertainty.
Every target retains incomplete enrollment and refuses startup before Docker access,
including the malformed-marker case and a fully matching committed pair. Independent
native reads verify the partial files, grant identities, inventory bindings and
current store bytes after failure. The retained completed installation restarts with
both saved records, nine artifact digests and five retired namespaces unchanged.
These controlled process/register injections do not reproduce physical disk failure,
capacity exhaustion or machine power loss. Native background retirement and the
broader release gates remain open.

The [lost native owner-response drill](evidence/operator-native-owner-response-loss.json)
discards three bucket responses only after the owner object exists and the exact
original claim remains pending. Socket peers are bound to the owned bucket
container's addresses, and injected connection-reset returns are read back from
registers. The controller durably records failure at activation preparation,
retains the original claim and keeps the app withheld. Native inspection finds its
assigned owner and no deployment objects. Rejection refuses; explicit retry of the
same artifact preserves the owner record, starts empty and accepts a write. The
controller process stays running and the peer retains its record. Independent
checks verify the captured authority digest, network/object scope, seven artifact
digests and four retired namespace file maps. This controlled response-loss case
does not qualify network partitions, partial native object writes, service outages,
power loss or ordinary runtime admission.
