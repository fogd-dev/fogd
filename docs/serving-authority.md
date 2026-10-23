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
Dedicated operator CLI and routing UI controls remain open.

Validation: the [controller integration tests](../packages/platform/test/controller-routes.test.mjs),
[background transition tests](../packages/platform/test/controller-route-background.test.mjs),
[restored recovery tests](../packages/platform/test/controller-route-recovery.test.mjs)
and [HTTP authorization tests](../packages/platform/test/controller-route-http.test.mjs)
observe real temporary authority/private files while substituting the backend. They
exercise the source protocol; they do not establish native runtime, image or mount
qualification.

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
not native qualification. Startup composition with the sealed route policy and
pre-ingress recovery checks remains open; this module enables no runtime family.

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
The candidate has no launcher or catalog admission yet.

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
