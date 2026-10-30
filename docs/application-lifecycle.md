# Application lifecycle and capacity reclamation

Fogd needs reversible app archival as well as permanent retirement. This contract
tracks [issue 8](https://github.com/fogd-dev/fogd/issues/8). Reversible archival has
a private implementation and bounded native evidence; public archival and preview
expiry remain unavailable. Stopped retirement has a delivered review and optional
execution binding. It does not grant archival restoration rights.

## State meanings

The [glossary](../GLOSSARY.md) keeps execution, retention and capacity distinct.

| State | Execution | Fleet capacity | Restoration rights | Status |
| --- | --- | --- | --- | --- |
| HTTP paused | New HTTP requests withheld; background controls remain independent | Still occupied | Exact reconciliation/resume under existing controls | Implemented |
| Installation stopped | All installation writers confirmed stopped | Assignments retained | Start the same installation or use stopped recovery | Implemented |
| App archived | App ingress and background writers fenced; data retained under an archive identity | Reusable only after verified completion in a fresh target | Explicit restoration of the same app from its retained archive | Private protocol; release gates open |
| Preview expired | Preview authorization ended; writer confirmation remains a separate fact | Occupied until writers are fenced and reclamation completes | Determined by an explicit preview retention policy | Future issue #2 integration |
| App retired | Old app cannot execute or reclaim its name in the new installation | Released fleet has fresh storage authority | Independent app restore unsupported; an older whole snapshot can resurrect prior state | Implemented stopped retirement |

HTTP pause is not proof of quiescence. A desired stop, expired authorization or
uncertain native reply cannot manufacture a free slot. Retained artifact bytes,
application data and available fleet slots remain separate measurements.

## Delivered: review stopped retirement

`fogd retire plan` verifies a durable snapshot against an independently selected
qualified runtime and source identity. It returns versioned JSON describing exact
app/release identity, snapshot hash, target project/network binding, whole-installation
downtime, stopped target services, survivor holds and retained data.

The report shows verified archive-member bytes, zero disk reclamation and one
fleet slot released only after verified target completion. It excludes credentials,
secret revision values/IDs, native node identities, bucket prefixes and raw configuration.
It leaves live source status, cached image availability and target availability
explicitly unobserved. The review is not a capacity reservation or a live-health
check. A fingerprint verifies the selected files, not publisher trust.

`--expected-plan SHA256` makes execution recompute that review before Docker
verification, fencing or allocation. Changed snapshot identity, app/digest, target
project, network placement or background-loss consent refuses before mutation.
Generated replacement IDs and timestamps are not reserved by planning. The output
directory is chosen at execution and retains its independent freshness/path checks.
The existing coordinator still checks source writers and snapshot bytes repeatedly,
keeps partial targets stopped/incomplete and requires explicit survivor recovery.

Validation covers stable reviews across independently generated replacement IDs,
changed intent, private-value exclusion, real CLI planning without Docker, blocked
stale execution, and matching execution through the existing fenced coordinator.
Special-file metadata refuses before opening a named pipe. A
[read-only native v8 snapshot check](evidence/operator-retirement-review-v8.json)
rehashes all 11 retained snapshot members, confirms stable reviews and stale refusal
without Docker, and verifies all 117 image source pins. It executes no new native
retirement. The
[retirement guide](retirement.md) supplies the operator commands.

## Archive protocol implementation in progress

The source-only [archive state protocol](../packages/platform/src/app-archive.mjs)
projects a verified app into a name-reserving archive, then restores that same app
into unassigned capacity behind a pending recovery gate. It binds the retained
snapshot, release, fleet namespace, native identities and storage origin. It keeps
current credential records, unrelated apps, release history and artifact references.
Queued and scheduled metadata retain their original paused receipts in the archive record.
Restoration derives fresh pending recovery gates for the target slot; it preserves
observation times, queue expiry, cron hold revision and prior recovery history.

The [archive route protocol](../packages/platform/src/app-archive-routes.mjs)
connects this state to durable routing: archival removes that app's public route,
survivors become withheld behind exact approval holds, and restoration adds only
withheld authority for the archived release. It uses the shared stopped store writer,
which spends fresh enrollment once and verifies both private and public readbacks.
Interrupted or lost write replies remain uncertain and refuse replay. A
[private image check](evidence/operator-app-archive-routes-v9.json) exercises both
packaged Node helpers on fresh route-store volumes and verifies that controller
startup still rejects the capability before backend access. It does not run celld
or copy native app data.

These helpers do not stop application writers or copy native application data.
The host archive commands use the stopped coordinator described below. Default
controller startup and shipped runtime selection still refuse the capability.
The stopped coordinator, background receipt projection, vault checks and attributed
approval are internal components. An explicit internal controller profile now
supports held startup and an owner recovery API. Native background, interruption
and concurrency acceptance and operator commands remain required before release.

## Retained snapshot and data-copy implementation

The internal [archive data stage](../packages/cli/src/recovery/app-archive-data.mjs)
binds the reviewed archive identity to both snapshots, the original app/release
records and its storage identity. It verifies that the retained MinIO namespace,
including its ownership object, still matches the original snapshot. Changed or
missing data refuses before target access.

Restoration keeps the current bucket, controller files and peer disks. Only the
archived app's two replica disks come from the original snapshot, mapped into
unassigned capacity. The fresh controller state remains intact for the one-use
route finalizer. Current authority files take precedence over older copies; this
data step does not select or materialize application secrets. A
[Docker copy check](evidence/operator-app-archive-data-v9.json) restores synthetic
SQLite snapshots on fresh volumes, independently verifies all four replica rows,
and compares the namespace reader against a retained native MinIO sample. This
is data-stage evidence, not full celld archival acceptance. Both snapshots are
rechecked after copying. A changed source or failed copy leaves partial targets
unconfirmed, retained and stopped.

Copy-plan previews do not reserve new background recovery IDs. Rechecking the plan
compares all receipt contents, prior history and target bindings while excluding
only those generated IDs. The final route-store writer creates and persists the
actual pending gates. Validation: independent queue/cron previews have different
IDs, yet the same retained data copies successfully; changed snapshot or receipt
bindings still refuse completion.

Archived queue and scheduled receipts remain inactive audit data, including expired
queue receipts. Live peers still need valid current recovery evidence. Restoring
background execution requires fresh diagnosis and acknowledgment later.

Restoration changes only the saved receipt's slot label after binding the retained
fleet namespace and native node identities. The immutable archive keeps the original
receipt. The new pending gate binds the current restoration snapshot and retains
prior recovery history without reusing its acknowledgment. A queue's original expiry
is not extended: existing recovery diagnosis records possible loss when it has
expired. Scheduled recovery still requires the original paused native revision.
Archive state validation refuses altered receipts, snapshot bindings, prior history,
acknowledged gates and resumed controls while archive recovery remains pending.

Component checks exercise the existing recovery diagnosis with backend stand-ins and
persist both background families through the stopped route-store helper into a
different slot. A [private packaged check](evidence/operator-app-archive-background-v9.json)
independently verifies the saved receipts, storage and route identities, and that
controller startup still refuses archive state before backend access. These checks
do not prove native holds or controller startup admission.

The namespace reader accepts ordinary GNU/USTAR backup files, directories and GNU
long names described in the [GNU tar format reference](https://www.gnu.org/software/tar/manual/html_node/Standard.html).
It preserves UTF-8 filename identity and refuses links, duplicate/unsafe paths,
unsupported extensions and malformed headers without extraction. Its bounds are
200,000 members and 16 MiB of member names per bucket archive. Physical member bytes
are separate from logical app data, free capacity and disk allocation.

## Restored execution approval

The internal recovery approval operation verifies the exact saved artifact against
canonical admission, the enrolled private/public stores, retained runtime identity,
current bucket owner and complete migration ledger. Migration inspection selects
existing ledger rows; a missing ledger refuses rather than creating an empty one.
It confirms native background holds, including the saved cron revision, before
consuming the archive recovery gate. These are observations under serialized
controller access; the launcher still must exclude other writers.

Approval reads the pinned revision from the current vault. It never falls back to
the retained source vault or silently selects a newer revision. Missing values,
changed bytes during verification, unavailable runtimes and changed artifacts or
migrations keep recovery pending. The operation does not publish code, apply
migrations or materialize secrets. Rotation uses a separate explicit current-vault
review and approval operation, described below.

An authenticated owner must select the exact archive identity, restoration snapshot,
deployment, artifact digest, pinned revision and current review context. A fresh
attributed decision intent precedes the checks. Its success and the consumed gate
are saved together; the archive ledger links that decision and requires it to occur
after the history boundary recorded at restoration. The original deployment's
approval cannot substitute for this recovery decision. Native inspection can
materialize a retained cell, so failures after native contact are recorded as
unconfirmed. Failures caught in local artifact/vault checks remain refused.

Successful approval leaves HTTP withheld and preserves pending queue/cron recovery.
The consumed archive remains recorded and cannot be restored or approved again.
Later app updates do not rewrite its original retained record. A failed intent or
completion save trips the existing storage fence. A lost reply after the final save
can leave a completed decision with the gate consumed; callers must inspect the
stored outcome and never infer permission from a successful-looking response.

A [private packaged check](evidence/operator-app-archive-approval-v9.json) verifies
actual canonical artifacts, vault availability and enrolled store readbacks. Its
native owner/runtime/migration observations are stand-ins. Component checks cover
queue and cron holds, changed evidence, stale review and lost save replies.

This operation has no shipped command or default entrypoint. Ordinary startup still
rejects archive state, including approved records. The internal composition below
exposes it only when an independently supplied profile explicitly selects archives.

## Internal controller composition

The internal controller can start archived, restored and consumed records only with
an explicit profile bound to its configured fleets and durable route authority.
This is a constructor composition, not an environment setting or installation
option. Legacy validation receives live apps while retained deployments and pins
remain accounted for. A configured native fleet claiming an archived name refuses
startup instead of adopting its storage or overwriting the archived record.

Before owner approval, the app name remains reserved and HTTP stays withheld.
Deployment, scoped credential issuance, secret replacement and ordinary background
controls refuse. Startup defers queue/cron recovery diagnosis for that app. After
the attributed approval is saved, recovery diagnosis runs; loss/replay acknowledgment
and explicit background resume remain separate. HTTP-only apps require a separate
routing resume. Restart preserves completed approval and the resulting controls.

The internal owner API provides recorded selection and review context at
`GET /v1/apps/APP/archive-recovery` and accepts the exact selection plus review at
`POST /v1/apps/APP/archive-recovery/approve`. Existing artifact review supplies the
code comparison; canonical artifact, vault and runtime checks run during approval.
Basic owner authentication, CSRF and origin checks protect mutation. The request
cannot override the authenticated actor or select another app through its body.
Default HTTP composition exposes neither endpoint.

Admin inspection returns archive summaries and preserves the existing filtering of
private materialized versions. Saved app/deployment configuration, native storage
identities and vault values are not copied from archive records into responses.
A [packaged controller check](evidence/operator-app-archive-controller-v9.json)
starts the actual internal controller, exercises the owner API over loopback, reads
back held approval, separately resumes HTTP and restarts. Its native observations
are stand-ins; it does not qualify native worker execution or release admission.

## Stopped enrollment coordinator

The internal coordinator now composes archival/restoration planning, fresh stopped
enrollment, data copying and one-use route finalization. Independent runtime and
source identities select the plans; a snapshot cannot choose its runtime. The
archive commands provide no override for runtime qualification.

Restoration acquires launch/stop fences for both the current and retained source,
in project-name order. One atomically published two-source exclusion record links
the target to both sources and their recovery relatives before Docker allocation.
Existing single-source records remain readable. Duplicate sources and replacing
an existing record refuse. Older CLIs that cannot read the new record refuse it.

Local operation exclusion also covers the connected source, target and sibling
graph. Retained startup acquires its own launch fence before checking peers.
Restoration acquires both source fences and rechecks peers before allocating or
copying a target. Only fences actually acquired by that operation are excluded
from its peer checks. A pending peer operation refuses even when every container
is stopped; partial files, directories and symlinks at its marker also refuse.
Validation: either ordering of sibling startup and restoration blocks the later
operation before a writer starts or a target is allocated. Markers are never
cleared to make the check pass. This is local CLI exclusion, not fencing against
privileged or independently managed remote writers.

Both sources must remain stopped. Their snapshots are reverified before data copy,
after it, and after route finalization and policy readback. Output cannot be inside
either snapshot. Lost source confirmation, changed bytes or uncertain copying keeps
host enrollment incomplete and retains all partial resources. Source fences are
released once; a lost release reply reports the overall operation unconfirmed even
when the stopped storage enrollment itself completed. No automatic replay follows.

A [Docker coordinator check](evidence/operator-app-archive-coordinator-v9.json)
uses synthetic snapshots and staged source host records, acquires both real source
fences, creates eight stopped services, and verifies actual policy, route and SQL
readbacks. Independent audit preserves all pre-existing fixture resources.

Completed storage enrollment still leaves HTTP withheld and archive recovery
pending. The controller continues to reject the archive capability before backend
access unless the explicit internal profile is supplied. Remaining native
background/interruption acceptance and operator commands are required before
release.

## Fixed archive controller mode

Archive recovery uses a separate fixed controller entrypoint, bound by the installed
runtime policy and independent host catalog mode. Ordinary durable startup cannot
load an archive policy; the archive entrypoint refuses an ordinary durable policy.
Changing an environment variable or substituting the controller command cannot
select archive recovery. Malformed mode declarations reach strict validation and
cannot fall back to generic startup.

The [native entrypoint check](evidence/operator-app-archive-entrypoint-v9.json)
qualifies fresh private enrollment, the fixed controller process, exact-release
approval, native D1 writes and existing migration-ledger inspection, followed by
fenced stop/restart and retained data. This verifies ordinary app execution through
the new composition. It does not qualify archived-app restoration or capacity reuse.
The catalog lists `celld-archive-v9-linux-arm64` as a closed candidate for release
rehearsal. Ordinary enrollment/export and default cron admission stay closed.

Archive-mode backups validate the complete registry and paired route stores. They
retain detached background history without contacting archived apps or extending
old receipt expiry. Live queue/cron apps still need current snapshot evidence;
unacknowledged background recovery refuses before preparation. Ordinary durable
mode refuses archive metadata, including unmarked archive fields. Archive-mode whole-installation restoration also preserves detached archive records
and pending app-approval gates. It uses fresh enrolled stores, withholds every live
route, retains native/storage identities and permits independently selected target
networks. The host checks this projection before allocation; the fixed offline
helper spends fresh enrollment once and binds the new physical stores. Ordinary
durable mode still refuses archive metadata, even when its marker is removed.
Keep each archive's original retained snapshot: whole recovery preserves its
reference and restoration rights; it does not replace that retained source.

Archive-aware diagnostics return a safe archive summary and distinguish archived
apps from pending archive recovery. Neither selects a native fleet or sends an
application request. Registry and decision changes invalidate observation boundaries
for surviving apps too. Diagnostics do not grant execution or restoration rights.

The [native D1 lifecycle check](evidence/operator-app-archive-readers-v9.json)
backs up A, archives it into a fresh target, deploys B into the released fleet, and
restores A into the other fleet from two verified snapshots. Both apps remain
withheld at restored cold start. A failed early resume and an unconfirmed native
approval preserve the gate; a fresh exact review/approval and separate HTTP resume
restore access. Independent retained restart returns both apps' saved SQL rows.
This is a private D1/HTTP check, not general archival qualification.

The [whole-snapshot and R2 check](evidence/operator-app-archive-whole-v9.json)
adds native object data, whole-installation recovery with detached A, and new SQL
and object writes by B afterward. A can subsequently restore from its original
retained snapshot through exact owner approval and separate HTTP resume. Independent
restart returns A's original and B's latest SQL/object data. Audit verifies current
credential bytes, fresh physical enrollment and source exclusions. This remains a
private two-fleet D1/R2 check. It does not qualify native queue/cron archival,
interruption or concurrent admission.

Private archive recovery supports explicit secret rotation against the current
vault. The owner stages values for an exact archive/release selection, obtains a
new rotation review, and approves that selection. The saved original pin may be
unavailable: rotation uses the newly selected current revision, never a retained
source vault. It publishes unchanged canonical code and reads the complete SQL
ledger without applying migrations. HTTP stays withheld; queue/cron recovery
remains pending and retains its original timestamps, expiry and acknowledgment
requirements. Validation: missing old values, changed selections and uncertain
publication cannot silently approve execution; explicit retry retains the selected
revision and values commitment, and a recorded publication completes without
republishing. In-progress rotation prevents snapshot copying. Repeated archive
lifecycles retain historical decisions while binding the current execution to the
latest completed rotation.

The [native rotation check](evidence/operator-app-archive-rotation-v9.json) restores
a fresh secret-bearing D1/R2 app, makes its old target vault pin unavailable while
retaining the bytes, and refuses original-pin approval. Explicit rotation uses new
current-vault values; separate HTTP resume returns the new configuration hash and
original SQL/object data, including after retained restart. Independent audit
rechecks image/host sources, canonical artifacts, credentials, physical stores and
source exclusions. Uncertain publication and completion saves have component
evidence; native background behavior is checked separately below.

The [native background check](evidence/operator-app-archive-background-native-v9.json)
qualifies separate queued-message and scheduled apps through stopped archival,
two-source restoration into the other fleet and current-vault rotation. A queued
message stays unprocessed until explicit recovery acknowledgment and queue resume;
its handler and a later message use the new configuration. Original receipt times
and queue expiry remain unchanged. Scheduled recovery retains the original native
hold revision and crosses a minute without a new invocation. Acknowledgment leaves
dispatch paused; separate resume produces only future invocations with the new
configuration. Both apps retain SQL, objects and handler records after restart.

Independent audits recheck sources, snapshots, physical stores, canonical artifacts,
current credentials and source exclusions. The first queue restoration exposed the
copy-plan ID comparison defect above and remains stopped/incomplete; acceptance
uses a fresh target. The cron driver's final inventory assertion mistakenly treated
its deliberately restarted source fixture as untouched. Read-only reconciliation
and the independent audit permit only that owned source's start/finish timestamps
to differ and check every unrelated resource exactly. No restore or approval is
replayed to repair the report. These per-family checks do not qualify combined
background peers/capacity reuse or coordinator interruption/concurrency.

The [native coordinator fault check](evidence/operator-app-archive-faults-v9.json)
uses authentic scheduled-app snapshots and five fresh stopped targets. It verifies
lost copy and route-helper replies, a lost source-fence release reply, competing
startup/restoration and interruption of the owned Node coordinator after an actual
replica copy. A related sibling startup initially reached an intercepted Docker
start despite held source fences; the peer-operation guard now refuses before
that boundary. The inverse ordering refuses restoration before allocation.

Copy/route reply loss keeps enrollment incomplete and startup refused. Lost fence
release confirmation remains unconfirmed even when host enrollment completed; its
app recovery gate and HTTP/background holds persist. Coordinator interruption
retains the partial copy and both source fences. Independent audit rechecks host
completion states, physical store bindings, replica bytes, exclusions and preserved
resources. None of these targets runs application code. Native worker interruption,
multi-host exclusion and combined background peers remain outside this check.

## Reviewed operator commands

The [archive command reference](archival.md) defines `fogd archive [restore] plan`
and matching execution. Both operations require independently selected runtime
and snapshot identities. Execution requires the exact review SHA; the plan reader
checks it before runtime verification, source fencing or target allocation.
There is no candidate-selection override and no admitted shipped archive family.

Each versioned review describes whole-installation downtime, stopped target services,
withheld peers, name reservation and restoration rights. It reports verified
snapshot-member bytes separately from unknown logical app bytes, zero disk
reclamation and conditional fleet capacity. Generated archive and recovery IDs
are not reservations. Restoration binds both snapshots, the retained archive
identity and the selected unassigned fleet. Reviews omit private vault/native
configuration; live sources, cached images and target availability remain unobserved.
Validation: changed intent or snapshot bytes refuses before Docker or allocation,
and independently generated archive IDs produce the same review.

The [native command check](evidence/operator-app-archive-commands-v9.json) exercises
the actual parser and reviewed command composition with a trusted private candidate
selector/authorizer. It archives a D1/R2 app, backs up the stopped target and restores
the app through a second exact review. Receipts identify the actual archive and
held lifecycle state. Owner approval and separate HTTP resume remain necessary;
original data survives retained restart. Independent audit recomputes reviews and
verifies receipts, physical stores, credentials, artifacts and source exclusions.
Real CLI planning/stale-execution tests use a synthetic qualified catalog and no
Docker. Neither check qualifies a shipped archive release or combined backgrounds.

`fogd admin archive APP` provides endpoint-bound owner recovery reviews, explicit
approval and secret staging from standard input. Original and rotation approval
use saved exact reviews; a changed endpoint refuses before HTTP. Rotation requires
staging, a fresh rotation review and explicit rotation approval. Replies omit
secret values and private runtime versions. Uncertain mutation replies are not
automatically replayed. Approval leaves HTTP and background controls held.

The [native owner CLI check](evidence/operator-app-archive-owner-cli-v9.json) uses
the stock CLI over certificate-verified HTTPS on two fresh private targets. Original
approval and current-vault rotation both require a separate HTTP resume; SQL,
objects and selected configuration survive retained restart. Independent readback
checks owner decisions, endpoint-bound reviews, canonical artifacts, vault revision
selection, physical enrollment and preserved resources. Target preparation uses a
trusted private candidate selector; the owner CLI has no injected HTTP provider.
This check does not qualify background acknowledgment/resume or public admission.

The [native peer/capacity check](evidence/operator-app-archive-peers-v9.json)
archives a paused queue app with retained input, approves a new cron app in its
freed fleet, then restores the queue app into the other fleet. Restoration into
the occupied cron fleet refuses before allocation. Queue secret rotation leaves
the cron peer's release and configuration unchanged. Both backgrounds stay held
across a minute. Each requires its own recovery acknowledgment and explicit
background resume; acknowledging the cron peer leaves queue recovery pending.
Retained and future queue input uses the new queue configuration. Cron records
only future times after resume. Both apps retain SQL, objects and handler records
through stopped restart.

The original peer harness incorrectly requested HTTP resume after acknowledgment
had already restored HTTP. The controller refused the active route. Saved-state
reconciliation verified successful acknowledgments, active routes without pending
operations and paused backgrounds before continuing only the unexecuted background
resumes. Independent audit checks unchanged acknowledgment timestamps, peer release,
credentials, artifacts, physical stores and retained resources. The failed harness
result remains retained. This qualifies one queue app with one cron peer on the
private two-fleet candidate; it does not qualify both handlers in one app or public
archive admission.

The [native command fault check](evidence/operator-app-archive-command-faults-v9.json)
exercises reviewed command composition against the queue/cron peer snapshots.
Concurrent archive and restoration commands refuse before allocation while another
command holds both source fences. Only the confirmed returning command emits a
completion receipt. Terminating an owned Node command after storage completion
but before result emission leaves host enrollment complete and all execution held;
an explicit existing-target replay refuses without changing its stores.

Termination after an actual archived replica copy leaves target enrollment
incomplete, retains both source fences and blocks source, sibling and target
startup before writer actions. Independent audit recomputes reviews, compares
eleven native replica archives, verifies physical enrollment/store bindings and
checks both command children emitted no receipt. All target services remain
unstarted. The first harness failed while reading an omitted optional network
plan; its incomplete target remains retained and acceptance uses fresh targets.
These are bounded local command checks, not power-loss or remote-writer fencing.

Before archive admission, qualify release of the updated host CLI and archive
runtime. End-to-end release acceptance remains open. There are no
existing user installations to migrate; acceptance targets fresh installations and
same-family recovery.

The [private v9 release preparation](evidence/operator-archive-v9-release-preparation.json)
packages the closed candidate's pinned images, archive guide, owner commands and
standalone developer client. Only the selected admission field changes in a private
proposal; ordinary source selection/export stays closed. Standalone verification
authenticates the proposed versioned bundle before import on a newly empty engine.
The received operator enrolls fresh TLS storage, and the included client deploys
two ordinary Void apps from prepared dependencies. Exact approvals, compatible SQL
update, pending code/SQL isolation and retained restart pass. Independent audit
rehashes the received program and verifies physical enrollment, canonical artifacts
and attributed approvals. This preparation checks installation; received archival
and owner recovery have separate evidence below. The engines run on one physical
Mac, and no public publication occurs.

The [received v9 recovery check](evidence/operator-archive-v9-received-recovery.json)
uses that authenticated operator without runtime, plan or HTTP-provider overrides.
Its actual CLI backs up the stopped installation, reviews/archives the baseline
app, then reports one available fleet and protects the archived artifacts. The
surviving peer accepts a new write while its pending update stays inert. A current
snapshot and the original retained snapshot restore the baseline into fresh stores
through a second exact command review.

Archive-pending diagnostics remain inert and return no replica probes. The first
harness incorrectly awaited ordinary readiness from that diagnostic; saved-state
reconciliation confirms pending approval before continuing only unexecuted owner
actions. A null-secret owner review and approval pass the controller's own checks
and leave HTTP held. Separate resumes expose original baseline data and the peer's
latest write. The pending peer update remains inactive, and the SQL migration
ledger stays unchanged through retained restart. Independent audit rechecks received
files, both command reviews, snapshots, physical stores, current credentials and
archive/decision history. All 24 related services are stopped and retained. Final
admission audit and actual qualified-catalog release checks remain open.

## Remaining archive protocol

Archive support needs a separate immutable runtime and native acceptance before
admission. Implement it as an app lifecycle capability with these conditions:

- Bind the archive to the exact app, release, source storage identity and verified
  retained data. Reserve the archived app's name; another app cannot adopt it.
  Validation: changed identity, data, capability or release refuses restoration.
- Fence app ingress and background writers before releasing capacity. The initial
  supported workflow requires whole-installation downtime and fresh target storage.
  Validation: interrupted or uncertain reclamation leaves capacity occupied or the
  target incomplete; concurrent admission cannot reuse its authority.
- Retain all surviving apps, decision history, protected artifacts and recovery
  references. State the retained-data policy before mutation. Validation: archive A,
  use its capacity for B, then restore A into available fresh capacity; A's saved
  records survive and B's records remain unchanged.
- Require explicit reconciliation/approval before restored code or background work
  runs. Current operator authority governs credentials; restoration cannot silently
  resurrect revoked global credentials. Validation: cold restore is inert and old
  queued/scheduled work needs its recorded recovery acknowledgment and resume.
- Report archive identity, execution uncertainty, retained bytes and capacity as
  separate stable fields. Validation: lost replies and interrupted cleanup never
  produce a completed/free result; replayed or conflicting archive identities refuse.

Preview execution/expiry stays in [issue 2](https://github.com/fogd-dev/fogd/issues/2).
It must reuse the same writer-fencing and reclamation rules rather than invent a
second cleanup mechanism. Live slot reuse, automatic data erasure and unlimited app
density remain unsupported. Issue 8 stays open until the archive protocol, mutation
results, native interruption/recovery gates and release admission are verified.
