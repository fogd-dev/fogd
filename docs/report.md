# fogd implementation report

fogd is a local, self-hosted deployment platform for the supported subset of Void
apps. workerd handles hostname routing. Each complete app and its stateful bindings
run in a separate two-replica celld fleet. A teammate submits an immutable build;
an admin reviews and approves its exact digest. No Cloudflare account or API is used.

Current status: Docker deploy/approval, private configuration, TLS, stopped recovery,
capacity reporting, and offline retirement are locally qualified. Kubernetes deployment
and stopped recovery have experimental local-kind evidence. Remote infrastructure,
broader background/live applications and portability
remain open roadmap work.

Queued Docker backup/restore has [private-artifact recovery qualification](queue-recovery.md),
including replica-first pause, retention checks, and explicit acknowledgment/resume.
Activated or retired queued history still prevents Kubernetes recovery and expansion.
Queue admission now has an [experimental Docker opt-in](queue-admission.md), off by default.

## What works

| Milestone | Result and reproduction |
| --- | --- |
| 1. Compatibility and architecture | Source-pinned [matrix](compat.md), [architecture](architecture.md), and independent reviews; see README milestone 1 |
| 2. Hello world | Actual `void init` D1 starter builds through Vite and serves `/api/posts` through workerd/celld/MinIO; see README quickstart |
| 3. Realistic app | Notebook uses D1, R2, a SQL-backed Durable Object, and two SQL migrations; recovery script checks both replica failures and workerd restart |
| 4. CLI | `fogd up` creates private local credentials and starts Docker; `fogd deploy` builds in a Void app and submits its artifact |
| 5. Platform design | Claude and Gemini independently reviewed the selected custom approval gate; original proposals and responses are preserved in `reviews/` |
| 6. Platform | Two apps, exact subdomain routing, Basic-authenticated admin UI/CLI, immutable-digest approval, rejection, failure/retry, and runtime resource limits |
| 7a. Native full-stack qualification | Guestbook pages, form actions, typed client/API, split client assets, two approved releases and additive SQL; see the [fixture guide](../examples/guestbook/README.md) |
| 7b. Application growth and logical transfer | R2 additions preserve D1 records; browser attachments and bounded restore with failure/retry; see the [transfer guide](../examples/guestbook/TRANSFER.md) |
| 7c. Private configuration and native auth | Revision-pinned admin secret input, native Void account/session flow, two-app isolation, rotation, and restart checks; see the [accounts guide](../examples/accounts/README.md) |
| 8a. Stopped installation recovery | Fresh-volume restore with exact images, full replica logs, private configuration, interrupted approval retry, and continued writes; see the [recovery guide](recovery.md) |
| 8b2. HTTPS shared profile | Native TLS, Secure Void sessions, private routing listener, certificate recovery, and six-volume installation upgrade; see the [shared installation guide](shared-installation.md) |
| 8b1. Scoped access and admission limits | Named app-scoped deploy credentials, revocation, retained artifact/pending/upload limits, and recovery evidence; see the [access guide](deploy-access.md) |
| 9a–9b. Experimental Kubernetes | Local kind deploy, replica replacement, and fresh-PVC stopped recovery; see the [Kubernetes guide](kubernetes.md) and [recovery guide](kubernetes-recovery.md) |
| 10a. Capacity reporting | Admin API/page/CLI report admission limits and retained ownership; see the [capacity guide](capacity.md) |
| 10c, measurement slice | Warm Docker metrics and bounded stateful reads; see the [measurement guide](capacity-measurement.md). Three-fleet expansion and paired observations are qualified locally |
| 10b. Docker retirement | Fresh-installation transformation retains the other app, retires one name, and frees a fleet without inheriting old state; see the [retirement guide](retirement.md) |

The live Docker acceptance test passed for hello and notebook side by side. It
verified no route before approval, rejection, submitter/admin separation, wrong-digest
rejection, artifact-path rejection, D1/R2/DO writes, isolated SQL activation failure,
corrected resubmission, and controller/workerd restart persistence. Unit tests cover
interrupted activation, migration reconciliation, controller metadata loss, auth,
artifact validation, ownership conflicts, and ingress behavior. The sample production builds pass. The final implementation also passed the approval smoke on fresh
Docker volumes after review fixes.

The initial direct runtime recovery test passed with both replicas force-stopped in
turn, a write between rejoining/failing replicas, and a workerd restart. The same recovery check passed on the platform fleet. A separate clean checkout
with fresh Docker volumes passed installation, startup, both CLI builds, and the
complete approval smoke test; details are recorded in [notes](notes.md).
Run `node scripts/platform-smoke.mjs` on a fresh stack and `node scripts/recovery.mjs`
after approving notebook second. The README contains all six reproduction sections.

The M7a browser smoke passed on fresh local Docker volumes: rejection before first
activation, approved pages and CSS, form writes/reload, typed API reads, a generated
additive migration, existing rows with the new default, a new history page, and
controller/workerd restart. The ordinary Void development server passed the same
browser form/API check with its separate local database. Type-checking includes
negative client contracts. Both ordinary and fogd builds passed in a Docker run
with `--network none`; hosted execution remains unverified.

A fresh smaller agent independently completed the documented automated workflow
from a clean checkout with new credentials and volumes, without author hints.
The [onboarding record](onboarding.md) closes the revised M7a reproducibility gate.
Human usability and manual admin-UI onboarding remain unverified and optional.

M7b's local growth smoke passed with an approved R2 addition, retained D1 messages,
browser upload/download, and logical transfer to a second app. A SQL trigger forced
restore to fail after object writes; no message/attachment rows committed, and an
identical retry completed without duplicates. Corrupt/different snapshots were
refused, a new message was saved after restore, and controller/workerd restart
preserved the records. Base and attachment fixtures also built with networking
disabled. See the [M7b review response](reviews/m7b-response.md).

M7c qualifies the accounts fixture with two isolated apps, CLI secret input and
approval, browser signup/login/logout, private API checks, ordinary updates, rotation,
and controller/workerd/celld restart persistence. Invalid environment values leave
routing paused; failed retries retain their pinned revision. Void's native auth uses
an explicit scrypt adapter because celld lacks that Node primitive. Secret revisions
stay outside artifacts, but injected values are plaintext in celld's bucket. See the
[review amendments](reviews/m7c-response.md) for the scope and upstream gap.

## Runtime boundary and corrections to the initial assumptions

Splitting a worker's native bindings across workerd and celld would need an API
bridge with significant semantic gaps. Keep complete apps in celld and use native
HTTP external services in workerd. Both runtimes have dynamic worker loading, but
neither standalone runtime supplies Cloudflare Workers-for-Platforms dispatch
namespaces. celld explicitly rejects AI and dispatch bindings in its config parser.

celld has one live deployed entrypoint per fleet prefix, so two apps need two fleets.
Its single-entry `no_bundle` collector does not upload Vite JavaScript chunks: fogd
disables worker code splitting during the build. No upstream runtime patch was needed.

Bucket-backed state does not mean replica disks and names are disposable. A recovery
experiment failed when a restarted replica received a random new identity; witness
requests for the old log were rejected. Retaining the original node IDs, peer
addresses, and log volumes recovered the acknowledged data. Stable IDs plus a
conservative lease-expiry delay are now the default. See ADR 005 and its source review.

## Limits and open gaps

- This is for trusted, reviewed apps. celld's internal operator interfaces and shared
  local bucket credentials do not form a hostile tenant sandbox. Fleet networks help
  separate apps, but storage credentials must be scoped before crossing trust boundaries.
- Two static app slots are provisioned. There is no scheduler, autoscaling, automatic
  slot recycling, certificate/DNS provisioning, or public production deployment.
- MinIO and the controller are single points of failure. Routing returns 503 when
  the controller is unavailable. Preserve coordinated controller, bucket, and replica
  backups. Lost controller metadata quarantines occupied slots; restore it explicitly.
- Only the adapter's validated configuration subset is accepted: string variables,
  one D1 database per app, R2, local SQL-backed Durable Objects, and static assets.
  Existing resource identities remain fixed. R2 additions are supported and stay
  reserved after approved failures; D1/DO additions and resource retirement remain
  unsupported.
  Unsupported AI, WfP, Hyperdrive, queues/workflows, cron, cross-app service bindings,
  automatic runtime auth-migration control paths, and other unsupported nonempty
  declarations fail rather than disappear. Native auth uses checked-in generated SQL.
- R2 multipart handles are process-local upstream. Examples exercise ordinary puts
  and gets. Native React pages and client assets are tested; larger asset collections,
  streaming, WebSockets, and remote two-host
  deployment have not been qualified by these tests.
- Approval pauses routing. Schema changes and deployment are not one transaction;
  in-flight requests and existing Durable Object alarms are not quiesced. Use
  backward-compatible SQL. A route pause alone does not make a backup consistent;
  there is no automatic rollback. Applied migration hashes are immutable. A failed,
  unapplied migration may be corrected after authoritative ledger reconciliation.
- Basic auth is appropriate for this loopback HTTP demo. Public use requires TLS,
  scoped teammate credentials, audit retention, and stronger identity management.
- CPU/memory/V8/request-size limits are coarse. There is no per-request CPU billing,
  hostile-code isolation, total artifact-storage quota, or automatic artifact pruning.
- The expanded CLI has not been published to npm. Use the workspace CLI or invoke its script
  with `FOGD_HOME` pointing at this checkout. Future package names use `@fogd/`.

## Decisions in one place

1. Keep complete apps and native stateful bindings in celld; use workerd for ingress.
2. Give each app a separate fleet/prefix and two persistent replicas.
3. Build pinned MinIO source in Docker because upstream images were unavailable.
4. Disable worker code splitting to match celld's single-entry artifact collector.
5. Keep node identity, advertised address, and log volume together across restarts.
6. Use a small approval controller with conditional bucket ownership fences and
   static workerd backend bindings. Pause before activation, verify both versions,
   reconcile migration ledgers, and require explicit retry after interruption.
7. Select the native Void worker entry and materialize asset ignore rules before
   celld deployment, while retaining normal client splitting.
8. Expose status through the existing team credential with fixed failure messages;
   individual identities and raw diagnostics remain separate concerns.
9. Upload only runtime worker modules and enforce secret-file asset exclusions;
   omit local preview secrets and worker source maps.
10. Use fresh-agent onboarding as the reproducibility gate without waiting for humans.
11. Reserve approved additive R2 identities, even after failure; show changes against
    the active release.
12. Qualify one bounded logical guestbook transfer during an explicit maintenance
    window, with digest-based retries and atomic SQL completion.

The [feature table](features.md) compares the implemented platform with its runtimes,
Void, and hosted Cloudflare. Read [decisions.md](decisions.md) for context, alternatives, and reasons, and
[platform.md](platform.md) for the deployment state machine and operational scope.

The [M7a review response](reviews/m7-response.md) records Claude and Gemini findings,
including preview-secret packaging and browser-test fixes.

M7c adds ADR 013 (private revision pinning) and ADR 014 (the explicit password
primitive adapter). The next roadmap milestone is M8: recoverable installation,
starting with a stopped backup/restore qualification before shared hosting.

## M7c verification record

The final unit suite passes 31 tests, including pre-claim secret pinning across
restart and canonical metadata rejection. `pnpm build` and syntax checks pass.
The quality gate passes without relaxed thresholds. The original platform smoke
also passes on fresh volumes, covering hello/notebook approval, failed SQL recovery,
D1/R2/DO behavior, and controller/workerd restart.

`docker build -f docker/verify.Dockerfile -t fogd-verify:m7c .` followed by
`docker run --rm --network none fogd-verify:m7c` passes ordinary and fogd builds
for guestbook, attachments, and accounts. It verifies the accounts secret declaration
survives staging. This is build portability evidence, not hosted Cloudflare execution.

The final accounts smoke passes on fresh rebuilt Docker volumes with both
`accounts` and `accounts-peer` active. It checks CLI secret input/approval, missing
and invalid configuration, pinned retries, browser account/session behavior,
cross-app cookie refusal, control-plane separation, ordinary updates, rotation,
and restart persistence. Review evidence is retained for both Claude and Gemini.

## M8a recovery evidence

Two complete local restore drills passed. The clean-stop run took 27.3 seconds to
snapshot and 10.2 seconds to restore. The forced-stop run took 26.8 seconds and
10.7 seconds, excluding subsequent startup/health waits. These are observations on
this development machine, not capacity or recovery-time guarantees.

The forced-stop snapshot recorded exit 137 for the controller and both notebook
replicas. After restore onto fresh volumes, the accounts approval returned failed
with its original secret revision; explicit retry succeeded. Existing account
sessions, fresh password login, notebook D1 rows, R2 bytes, and Durable Object counts
survived. New writes and approvals succeeded. The literal-dollar gateway credential
survived configuration serialization. Occupied-target refusal, checksum corruption,
incomplete manifests, and configuration drift have regression coverage.

Every archive is checked before target creation and compared against restored volume
contents before the completion receipt. Backups contain plaintext credentials and
require private storage. No writes after a source resumes are included in its prior
snapshot. Cross-version upgrades, concurrent source/clone serving, and shared remote
operation remain unqualified. Claude reviewed the design; Gemini's attempt hit its
provider quota without a verdict. See [review amendments](reviews/m8a-response.md).

The final post-review crash drill also passed: snapshot 26.6 seconds, restore 10.4
seconds, excluding startup waits. One preceding run exhausted Docker's network
address pool because earlier stopped test projects retained their networks. Restore
failed before starting a target. Removing only those old test containers/networks
while retaining volumes and snapshots allowed a fresh-target rerun. No system
network configuration or unrelated Docker workload was changed.

## M8b1 access and capacity evidence

Real CLI/Docker checks passed for two scoped teammates, separate approvals,
cross-app and cross-status refusals, admin isolation, one-time token issuance,
revocation, and controller restart. A fresh-volume restore retained a valid
credential, a revoked credential, disabled legacy access, and a full artifact quota.
Both recovered apps remained controlled by their existing approval records.

The upload drill admitted two concurrent 32 MiB artifacts, counted them exactly,
and completed rejection/revocation without a controller restart. Cgroup memory peak
was 376 MiB under the default 512 MiB limit. Unit tests cover revocation ordered
before queued submission, concurrent admission, scope/privacy, malformed limits,
restart accounting, and a third upload refused while two bodies are held open.

Credential hashes live in the controller volume and never appear in admin/status
projections. Logical artifact quotas exclude app data, metadata, private revision
history, and transient activation copies. Orphans count conservatively; pruning is
not automatic. One bootstrap admin and optional legacy local access remain. The next
slice qualifies HTTPS and explicit shared-mode policy; remote hosting is not yet
claimed. See [review amendments](reviews/m8b-response.md).


## M8b2 transport and upgrade evidence

The local shared-profile drill passed scoped CLI deployment/approval over HTTPS,
untrusted-CA refusal, plaintext refusal, public/private routing separation, native
Void Secure/HttpOnly sessions, and spoofed forwarding-header rejection. A stopped
snapshot restored the TLS volume, credentials, secrets, and live login session into
fresh volumes; normal certificate verification still rejected untrusted clients.

A separate drill restored the original six-volume M8a snapshot with its old images,
verified HTTP account login, then deliberately upgraded the configuration/images
and enabled shared HTTPS. D1/R2/DO records, account login, private revisions, and
approval history survived. A release pending before the upgrade activated afterward.
This tests a fogd control-plane/configuration upgrade with pinned upstream runtimes.

Claude reviewed design and code. The code review found Compose's implicit root
`.env` fallback; every CLI Compose call now suppresses it and uses the resolved
installation environment. A real Compose configuration check verified that missing
settings no longer inherit root credentials. See [review response](reviews/m8b2-response.md).

Certificate renewal remains operator-managed. Private network traffic remains HTTP,
end-user IP forwarding is absent, and shared mode does not qualify untrusted tenants.
M9a starts with isolated local Kubernetes evidence; actual remote host/storage/network
failure qualification is still open.


## M9a Kubernetes evidence (experimental)

An isolated kind v0.33.0 / Kubernetes v1.37.0 cluster ran the same accounts and
notebook fixtures with native HTTPS, scoped CLI submission, and separate approval.
The live drill passed D1/R2/DO writes, native account sessions, individual replica
replacement, controller/gateway replacement, PVC identity retention, and image
config-ID checks against the preloaded Docker images. Kubeconfig and private files
remain inside ignored repo paths; no existing cluster context was modified.

Stopping one kind worker also stopped its co-located controller and one replica of
each fleet. All five sampled requests were unavailable during that 20-second
observation. Starting the node again restored service and the same notebook data.
This demonstrates the singleton controller availability dependency. It does not
qualify host loss, a replaced disk, or a network partition. Local kind networking
also lacks Compose's per-fleet separation.

The [Kubernetes guide](kubernetes.md) describes the experimental manifests and
reproduction. Kubernetes stopped recovery is [M9b](m9b.md); full M9 additionally
requires actual remote host/storage/network evidence. Docker backup refuses a
Kubernetes installation profile rather than silently snapshotting another stack.

The committed setup runner passed from scratch on m9verify. After review fixes,
m9final2 passed the stronger drill: replacement replicas served both apps while the
alternate replicas were absent, before the gateway restarted. Stable per-replica
Services preserve backend addresses across pod IP changes. Namespace creation is
separate from normal workload manifests so their deletion retains PVCs. The final
suite has 50 passing tests, passing builds and quality checks. Review amendments and
local capacity failures are recorded in [the response](reviews/m9a-response.md) and
[notes](notes.md). No Kubernetes recovery claim is included in M9a.


## M9b stopped Kubernetes recovery

The experimental adapter restores the local two-slot kind installation onto six
fresh claims in a new namespace. Two full drills passed: the reviewed run took
about 101 seconds to capture and 96 seconds to restore, excluding application
startup. It preserved D1/R2/DO records, native account sessions and login, private
secret revisions, scoped deploy credentials, approval history, and a pending
approval. Approval and new writes worked after startup. The source remained stopped
until explicitly restarted.

The reviewed snapshot recorded clean exit code 0 for all six stateful containers.
The stateless gateway wrapper exited 1; that outcome is retained in stop.json.
Unknown or nonzero stateful exits warn that upstream crash recovery may be needed.
A completed archive does not imply a clean shutdown or a live recovery guarantee.

Validation refuses occupied namespaces, corrupted files, unexpected writers, image
identity conflicts, and nonempty restore claims. It verifies archive tag/config
metadata before loading images and checks helper placement and received bytes.
No recovery operation deletes a namespace or claim or force-removes a pod. Only
manifest.json marks a complete snapshot; failed attempts remain for inspection.

This qualification covers local kind and its local-path storage only. Physical host
loss, remote network policy, alternate storage, large volumes, automatic resumption,
and capture of an already-stopped source remain open. See the [operator guide](kubernetes-recovery.md)
and [review response](reviews/m9b-response.md).

## M10a capacity reporting

The admin API, page, and `fogd admin capacity` expose slot occupancy, pending limits,
and retained artifact accounting. Cached bucket owners remain visible separately
from controller assignments, including duplicate claims. Paused or quarantined apps
retain their slots. Rejected and superseded artifacts retain their byte cost.

Controller and HTTP tests compare CLI/API output, deny deploy-only access, escape
page labels, retain duplicate ownership, and verify accounting after restart. The
report is read-only and makes no live bucket reads. It measures admission accounting,
not app data, free disk, CPU, memory, or cost. See the [capacity guide](capacity.md).
M10b qualifies retirement/reuse below. Runtime density and capacity expansion remain open.

The final suite passed 64 tests, example builds, and the code-quality gate. Claude
approved the design and implementation; [review amendments](reviews/m10a-response.md)
record the additional admission-boundary and ownership-reconstruction checks.


## M10b Docker retirement evidence

The full local TLS drill retained accounts and its native session while retiring
notebook. The old hostname returned 404; stale approvals, secrets changes, and scoped
deploy authority could not reactivate it or submit a differently named replacement.
The old bucket prefix retained objects, while the replacement prefix had zero objects
before workers started. Replacement then showed empty D1 rows and Durable Object
state and successfully wrote and retrieved new D1/R2/DO data.

The final fixture captured its stopped snapshot in about 26 seconds and restored
with retirement in about 11 seconds, excluding admission preflight and subsequent
startup. All target volumes were fresh. The unaffected fleet kept its runtime
identities, private configuration, data, and login. No old app data, artifacts,
secrets, source volumes, or snapshots were deleted.

Retirement supports active or paused apps with a known active deployment and no
quarantine or unresolved migration. It refuses older runtime images that cannot
enforce permanent name tombstones. Multi-app tokens retain their other scopes;
operators revoke obsolete tokens separately. Ordinary backup restore can resurrect
prior app access and credentials, so the source must stay stopped. Publication of
the final Compose file and completion receipt follows restoration and validation.

This is a Docker-only maintenance workflow with whole-installation copying and
retained recovery material. It does not qualify erasure, artifact pruning, same-name
reuse, Kubernetes retirement, hostile tenants, or additional concurrent fleet capacity.
The [review response](reviews/m10b-response.md) records the design and implementation
reviews; [notes](notes.md) record fixture failures and their corrections.

The negative drill interrupted after the controller archive copy. No final Compose
file or completion receipt existed, every partial target container remained stopped,
and the same target was refused on retry. A fresh target completed successfully.
An older runtime bundle was refused before target container creation. Ordinary
restore recovered notebook's original D1/R2/DO record, then the test returned to the
retired installation with accounts and replacement available side by side. The full
workspace suite passed 70 tests, example builds, and quality checks; Claude's final
review found no blocker.

## M10c warm capacity baseline

The [measurement tools](capacity-measurement.md) captured the existing two-app
Docker installation on 2026-10-18. The [recorded reports](evidence/m10c-two-fleet-capacity.json)
include samples, image identities, configured ceilings, and workload history.
The Docker Desktop VM had 10 CPUs, about 15.6 GiB RAM, and nine other running
containers. Host builds/tests and reviewer processes also ran during observation.
This is exploratory evidence on a shared machine.

| Window | Whole-stack observed memory | Mean sampled CPU, 100% = one core |
| --- | --- | --- |
| Warm idle, six samples | 730–747 MiB | 2.96% |
| Stateful reads, twelve samples | 754–855 MiB | 19.22% |
| After reads and app health probes, six samples | 852–869 MiB | 3.00% |

Four paced clients completed 4,304 HTTPS reads in 120 seconds with zero errors:
35.9 requests/second, 17.5 ms p95 and 31.7 ms p99 response latency. The fixed
one-entry endpoint reads D1, R2, and a Durable Object. The other app received no
load workload. Both app routes responded afterward, and the fixture still had one
entry and one recorded ID. Memory remained above the earlier warm window; these
samples do not establish the cause or a steady-state maximum.

Both Claude reviews completed: [design](reviews/m10c-design-claude.md),
[measurement code](reviews/m10c-measurement-claude.md), and
[accepted changes](reviews/m10c-response.md). Measurement/parser and HTTP fixture
tests cover invalid observations, replaced containers, failed reads, TLS policy,
and output-file conflicts. The workspace tests, example builds, and quality gate
pass. Runtime code and deployment configuration are unchanged by this slice.

The subsequent three-fleet qualification below adds per-app load comparison,
stopped restore, and retirement.
Cold-start costs, write-heavy workloads, sustained growth, disk costs, remote-host
operation, and maximum safe density remain unmeasured.

### Recovery inventory foundation

The two-fleet recovery foundation passed on 2026-10-19. Backup, bundle verification,
restore, image inventory, and retirement use one derived layout. Storage bindings,
node identities, mounts, and network membership must agree with it. Configuration
checksums are verified before deriving a bundle's archive set. The existing bundle
format remains supported; custom host/prefix overrides now have explicit limits in
the [recovery guide](recovery.md).

Both retained M8b2 TLS and M10b snapshots verified. A fresh backup/restore drill
preserved the accounts route and the replacement app's exact D1/R2/DO fixture;
the original installation remained stopped. Backup took 29.1 seconds and restore
13.8 seconds, excluding startup. The [Claude review](reviews/m10c-layout-claude.md)
found no blockers; accepted test and documentation improvements are recorded in
the [response](reviews/m10c-response.md). The subsequent expansion qualification follows below.

## M10c three-fleet expansion

On 2026-10-19 the Docker qualification passed for both a fresh rendered three-fleet
installation and expansion of a stopped two-fleet snapshot. The renderer preserves
environment substitutions, requires an explicit project name, and gives separate
projects separate physical volumes and networks. Two-fleet rendering matches the
source Compose definition. The [operator guide](expansion.md) documents commands,
maintenance downtime, credentials, and the unsupported shrink/upgrade paths.

The expansion preserved existing replica identities, controller metadata, scoped
credentials, secret revisions, and every archived source-volume file. A third scoped app was approved
and wrote isolated D1/R2/Durable Object data. A canonical fourth app submission was
refused for exhausted capacity. Gateway and replica restarts preserved data. Full
three-fleet backup/restore preserved all apps and a native Void session. Retirement
of the middle fleet preserved both surviving apps and allowed a different app name
to use empty capacity; retired data remains retained. Source and ordinary recovery
copies remained stopped during that recovery/retirement drill. The later paired
measurement intentionally restarted the two source fixtures one at a time; they
are disposable copies, not current recovery points after those runs.

Fault injection stopped expansion after copying controller metadata. No completed
configuration or receipt appeared. Reusing that partial target was refused; a fresh
project succeeded. Running-source and occupied-target refusals also passed. These
are stopped local installation transitions, not online scaling or remote failover.

The fresh-install drill separately submitted `alpha`, `beta`, and `gamma` with
independent scoped credentials, checked that pending releases had no route, approved
each, applied migrations, and verified isolated D1/R2/DO writes across all three.
A Docker network-pool exhaustion interrupted initial resource creation; removing
only stopped negative-fixture containers/networks freed space. Their volumes were
retained, and the fresh installation then passed. No unrelated workload or system
network configuration was changed.

| Operation | Observed duration, excluding startup |
| --- | --- |
| Two-fleet source backup | 28.3 seconds |
| Expansion restore onto three fleets | 14.4 seconds |
| Three-fleet backup | 28.6 seconds |
| Ordinary three-fleet restore | 14.4 seconds |
| Three-fleet middle-app retirement restore | 14.9 seconds |

The three-fleet snapshot included 11 files: configuration, image archive, bucket,
controller, TLS, and six replica archives. Its image archive was about 744 MiB;
bucket and controller archives about 5.46 and 3.99 MiB. These tiny fixtures do not
predict larger-data recovery time. Source volumes, target volumes, and snapshots
coexist and must all fit on disk. Paired read workloads and resource observations
are recorded in the [measurement guide](capacity-measurement.md) and its linked
raw reports. All workload HTTP responses were successful, and the original active
installation's three routes were checked after the measurement restored it.

The first expansion drill stopped at a test-harness CA path error: child builds
changed directory and could not resolve a relative trust path. The continuation
then correctly rejected a renamed, noncanonical fourth-app artifact. The harness
now uses absolute CA paths and builds a real fourth app; the subsequent capacity,
restart, and occupied-target checks passed. These continuations are recorded as
separate evidence, not a claim that the initial command passed uninterrupted.

M10 now covers admission reporting, stopped retirement, bounded Docker expansion,
and measured local operating costs. Kubernetes remains at two fleets. Automatic
scaling, density guarantees, erasure, artifact pruning, expanded-installation image
upgrade automation, and remote-host recovery remain open. M11 next addresses
background and collaborative application behavior in separately reviewed slices;
M12 broadens portability. No hosted Cloudflare execution has been performed.

After the [final Claude review](reviews/m10c-expansion-final-claude.md), the checked-in
expansion drill passed end to end on a fresh target. It used the credential issued
before expansion to submit the third app afterward. Specific running-source and
occupied-target errors are now asserted. Source comparison establishes that every
archived file is unchanged; it does not prove that no additional files exist.
The [review response](reviews/m10c-expansion-response.md) records all accepted
changes. Final checks passed: 83 tests, all example builds, syntax, and quality gates.

## M11a runtime qualification in progress

A new [repeatable harness](queue-qualification.md) passed on two fresh fleets and
through stopped recovery. A producer-only platform bootstrap established delivery
pause before application publication. A held v1 consumer and a v2 consumer ran
concurrently, with the queue cell on the current runtime generation. Persistent
pause survived full recovery with pending work and an interrupted lease; explicit
resume completed the pending job's first attempt and the interrupted job's second.

The probes exposed a critical limit: acknowledged work scheduled with `waitUntil`
produced effects while the queue was paused and empty, including an effect beyond
the configured handler response budget. Queue emptiness or a live-lease count alone
cannot prove a drain. Retry exhaustion also removed messages without a dead-letter
queue. [ADR 025](decisions.md#adr-025-persistent-queue-pause-with-compatible-handler-overlap)
therefore selects persistent pause with compatible old-handler overlap, durable
application input/job records, and explicit reconciliation, without a runtime fork.

[Lifecycle](evidence/m11a-queue-lifecycle.json) and
[recovery](evidence/m11a-queue-recovery.json) evidence retain phase observations.
The [Claude review](reviews/m11a-probes-claude.md) and
[response](reviews/m11a-response.md) distinguish observations from remaining gates.
The [native imports evidence](evidence/m11a-native-imports.json) adds Void typed
producer/consumer code generation, R2 retained input, and D1 results. Initial D1
migration succeeds under a producer-only bootstrap before application publication.
An old v1 handler and a new v2 handler complete against an additive migration.
Killing both replicas during each allowed attempt exhausts delivery without a
failure row; explicit reconciliation completes the retained job once. A browser
probe preserves the job URL and results across reloads, including paused delivery
and a verified retry. It uses a test transport to the private runtime.

Controller activation failure, retention-age recovery policy, and queue retirement
remain unqualified. These are direct-runtime probes; fogd queue admission remains
disabled. [Claude review and response](reviews/m11a-native-response.md) document
the corrected crash proof and stronger assertions. The imports fixture also passes TypeScript checking, and all 88 workspace
tests and example builds pass.

The internal [queue resume gate](queue-qualification.md#resume-generation-gate)
now validates the approved version on both replicas and current-generation queue
ownership before resume, with separate post-mutation confirmation. Live resident
and cold-queue probes pass; an unapproved version stays paused. This does not yet
persist controller delivery intent or enable queue admission. The
[review response](reviews/m11a-generation-response.md) records exact-cell matching
and explicit unknown mutation outcomes. The workspace now
passes 95 tests and all example builds.

The internal [delivery journal](delivery-journal.md) now persists operator intent,
activation holds, and runtime observations separately. Process-kill tests cover
both ordinary resume and activation release around durable writes. A refused
runtime generation keeps the activation hold. A real-celld probe confirms recovery
from an injected lost resume response through explicit reconciliation, without
automatic action on reload. [Selected evidence](evidence/m11a-delivery.json) records
the unknown outcome alongside the actually running queue. Controller integration
and queue admission remain pending; this is not full activation recovery.
The [review response](reviews/m11a-delivery-response.md) records the hold-release
fix and conservative recovery choice. All 109 tests, example builds, syntax, and
quality checks pass.

Controller metadata write failures now stop further mutations until restart.
Possibly referenced artifacts survive an ambiguous submission write, and activation
error handling cannot continue migration reconciliation after a failed progress
write. Authenticated APIs return 503 while internal routes report paused. Tests use
real state files with injected pre-write and post-write failures and verify explicit
retry from a fresh controller instance. This fixes the persistence boundary needed
for delivery integration; queue approval and bootstrap integration remain pending.
See [ADR 027](decisions.md#adr-027-stop-controller-mutations-after-uncertain-metadata-persistence)
and the [recovery procedure](recovery.md#recover-from-a-controller-metadata-write-failure).
Credential and secret-metadata writes share the same guard. Reload reports
unreferenced artifact entries; first claims without a committed app record remain
quarantined. All 119 tests, example builds, and quality checks pass.
The [review response](reviews/m11a-controller-storage-response.md) records the
shared credential/secret guard, operator diagnostics, and remaining first-claim gap.

[Recoverable ownership claims](ownership-claims.md) close the first-claim gap for
new approvals. Intent precedes the bucket effect; confirmation precedes publication.
Interrupted claims require explicit original approval retry, and unclaimed
reservations can be rejected after checking for absent ownership and deployment
objects. Real-file failure tests, subprocess SIGKILL tests, and a bounded MinIO
backend probe cover these boundaries. Legacy owners without intent still quarantine.
Queue bootstrap and delivery integration remain pending.
All 131 tests, example builds, and quality checks pass. The
[review response](reviews/m11a-claims-response.md) records the cross-fleet release
fix, supported-state boundary, and delayed bucket-write limitation.


The [queue activation coordinator](queue-activation.md) now connects the delivery
journal to approved activation. It persists bootstrap progress before effects,
confirms pause before migration ledger writes, publishes only after migrations,
and releases delivery only after readiness. Restart reholds interrupted activation
and confirms pause without automatic resume. The active pointer cannot authorize
bootstrap replay. Queue declarations and journals require a permanent capability
marker; supported older controllers refuse this state.

Controller tests exercise lost runtime responses, ambiguous writes, and real process
SIGKILL for first activation and updates. Their runtime effects use a persistent
stand-in. A [built-controller Docker probe](evidence/m11a-activation.json) also passes
against real celld: bootstrap readiness, D1 migration, a lost successful resume
response, reload pause, explicit retry, and an update preserving operator pause.
The native Void app processes retained input after explicit probe resume. This probe
uses a private controller and staged artifacts; it does not exercise public HTTP
approval or the gateway. Public queue admission remains closed. Operator controls,
corrected-artifact recovery, stopped backup/restore with retention policy, and
retirement/isolation remain gates. All 185 tests pass. The follow-up recovery policy
keeps other apps routable when one queue pause cannot be confirmed.


[Admin delivery controls](delivery-controls.md) expose recorded status, explicit
refresh, pause, and resume through authenticated HTTP, CLI, and browser interfaces.
Resume requires the inspected deployment ID and digest, then rechecks runtime
generation. Admin views omit private runtime hashes. Unknown runtime outcomes return
502 and preserve journal intent; storage uncertainty returns 503. The page explains
that operator pause persists across approvals and hides controls for unavailable
fleets. All 195 tests pass, along with builds and quality checks.

The [selected live evidence](evidence/m11a-admin-delivery.json) records real celld
resume/observe/pause through the admin endpoint and browser buttons, with forbidden
credentials, missing CSRF, and wrong-digest refusals. The fixture was privately
staged before testing these controls; this does not qualify public queue upload.
The [Claude review response](reviews/m11a-admin-delivery-response.md) records explicit
CLI approval binding and the strengthened serialization test. Corrected-artifact
hold transfer, stopped recovery/retention, retirement/isolation, and public approval
acceptance remain before queue admission.


[Queue replacement approvals](queue-replacement.md) recover from an invalid unapplied
migration without discarding the original attempt's ledger evidence. Preflight confirms
pause, reconciles the original artifact, and rejects changes to applied SQL. One
atomic state write then transfers the hold with the candidate approval and selected
secret revision. Operator pause and the last completed runtime version survive the
transfer. CLI and browser controls bind both approvals' IDs and digests.

All 218 tests pass, including ambiguous persistence, secret rotation, and real
process SIGKILL during reconciliation and hold transfer with runtime stand-ins.
Builds and quality checks pass. The [live D1 evidence](evidence/m11a-queue-replacement.json)
confirms a write followed by invalid SQL rolls back its entire file, earlier files
retain their hashes, and corrected SQL activates through explicit HTTP replacement
approval. A separate browser check verifies the button posts both identities.
The [two-review response](reviews/m11a-repair-response.md) records the startup guards,
pre-intent metadata rollback, and retry limitations. Public queue admission remains
closed pending stopped recovery/retention, retirement/isolation, and full deployment
acceptance.


## M11a queued retirement checkpoint

Docker retirement now accepts the privately qualified queued app profile with an
explicit `--stop-queued-work` flag and an unexpired stopped snapshot. The target's
queue becomes retained audit history. Surviving apps receive recovery receipts;
only explicit acknowledgment restores HTTP access, and delivery still needs resume.
The generated state is validated before target creation and written once.

The [local evidence](evidence/m11a-queue-retirement.json) records retirement with
pending work, an empty replacement queue/database, successful replacement work,
47 unchanged retained prefix objects after replacement traffic, and successful
survivor recovery. A subsequent backup includes only the two live queued apps.
The [review response](reviews/m11a-queue-retirement-response.md) records both Claude
reviews and their fixes. ADR 034 explains the permanent audit and capability.

This is partial retirement acceptance: a live restore containing only retired queues
and a prefix comparison beginning at the source remain next. Public queue admission,
Kubernetes queue recovery, and queued expansion remain closed. Retention still runs
on wall-clock time, and starting older installations can resurrect retired work.


### Queued retirement acceptance completed locally

The [completion drill](evidence/m11a-queue-retirement-complete.json) closes the two
remaining retirement checks above. Each of the two remaining apps had a non-empty backlog
when retired. Every retained object's SHA-256 hash matched between the stopped source
and restored installation. A subsequent backup with no live queued apps omitted queue
recovery preparation and restored successfully: the controller ran, all three retired
routes returned 404, and the retained prefixes still matched.

The harness now waits for application readiness before submission and approved replica
generations before acknowledgment. Earlier attempts exposed those missing waits;
they did not change the recovery protocol. Public admission remains closed. The next
slice must also ensure that never-approved queued uploads do not disable backup.

A separate read-only inspection compared the first retired app's 47 objects with its
retained stopped source as well. Every running target service had zero restarts,
and bucket-init had exited successfully. Comparisons cover the observation period,
not a four-day retention wake. The [review response](reviews/m11a-queue-retirement-complete-response.md)
records these limits. The next [admission design response](reviews/m11a-queue-admission-response.md)
also covers disabled-environment refusal and recovery of rejected pristine claims.


## M11a canonical admission foundation

The normal build/upload path validates one producer/consumer pair, derives a stable
app-prefixed name, and retains queues in resource identity. It rejects unsupported
policy and binding/secret collisions. New queue submissions and approvals require
an explicit controller opt-in; ordinary Docker defaults and Kubernetes remain off.
Never-approved artifacts can be backed up without queue preparation. A rejected
pristine claim requires its atomically persisted release receipt before backup can
classify it as artifact-only history.

The [public-path checkpoint](evidence/m11a-queue-public.json) uses an ordinary scoped
CLI deployment of examples/imports, without private staging. It proves no app ownership
or deployment before approval, pending-only backup/restore, exact approval, Void
physical-name dispatch, failures and explicit retry without duplicate business rows.
Idle celld wake-format objects are runtime metadata; the preapproval check inspects
app ownership and deployment objects rather than requiring an entirely empty prefix.
The canonical update and retirement drills below close those integrated checks.
The final acceptance audit and reviewed decision on default enablement remain.


The [failed-claim Docker drill](evidence/m11a-queue-public-claim.json) also passes:
normal scoped upload, bucket outage before claim, verified rejection, and successful
backup with only the active canonical queue prepared. Two unused-fleet replicas exited
143, so the bundle explicitly requires crash recovery. Restoring that bundle remains
next work. Regression tests also cover disabling admission during an already-approved
failure and inert queue history after a non-queue app reuses the same name.


The [current-image history regression](evidence/m11a-queue-public-history.json) closes
the review's two Docker gaps. A controller SIGKILL during approval leaves a pinned
failed request; it retries successfully with FOGD_QUEUE_APPS=0. A non-queue approval
under a previously queued app name leaves superseded, rejected, and released queue
history recoverable. Backup succeeds and prepares only the actual live queue.
All 261 tests, builds, and quality checks pass. The [two-review response](reviews/m11a-queue-admission-code-response.md)
records the fixes and remaining full application acceptance work.


## M11a canonical pending-work recovery and browser acceptance

The [pending-work drill](evidence/m11a-queue-public-recovery.json) submitted the same
job twice through workerd while the ordinarily deployed app was operator-paused.
Both messages survived a complete stopped backup and fresh simultaneous startup.
The restored app returned 503 until explicit recovery acknowledgment; acknowledgment
preserved the pause. Explicit resume drained both messages, leaving exactly two
unique result rows. This verifies the example's idempotent database writes, not a
general guarantee about external effects. The recovery review changed after startup;
the first acknowledgment was refused and the updated review was acknowledged.

The [browser drill](evidence/m11a-queue-public-browser.json) used Chromium directly
through the workerd virtual host, without intercepted requests. Submission, saved
job URL, reload while paused, one retryable failure, completion, and reload of the
two results passed with no browser errors. Delivery is paused again. All 261 tests
and syntax checks passed; queue admission remains opt-in.


## M11a canonical update and retirement

The [normal CLI update drill](evidence/m11a-queue-public-update.json) keeps a v1 handler
in flight while approving v2's additive D1 migration. Approval took 374 ms in this
local run; this is not a performance guarantee. The v2 handler completed pending
work before v1 finished. Each job had one attempt and the expected processor marker,
and the queue drained. Archived controller state confirms the migration was absent
before the update and present afterward. Pause limits new delivery; it is not a drain.

The [canonical retirement drill](evidence/m11a-queue-public-retirement.json) retained
one pending message, compared every old-prefix object's bytes before and after
retirement and replacement approval, and verified the retired route returns 404.
The neighboring hello app retained its empty response, which proves availability
but not preservation of nonempty data. The populated rerun below closes that gap.
A new scoped CLI deployment
and exact approval ran a replacement hello app in the released fleet. This is the
local two-fleet canonical path; earlier three-fleet isolation evidence remains
separate. Source volumes and private recovery material remain retained.

All 261 tests and example builds pass. Queue admission remains opt-in pending the
final M11a acceptance audit and policy review.


## M11a populated-neighbor retirement rerun

The [strengthened retirement drill](evidence/m11a-queue-public-populated.json) inserts
a unique post into the neighboring hello app through a private fixture D1 command,
verifies it over HTTP, and then runs the complete backup/retirement/replacement
sequence. The post survives unchanged, the replacement app has an empty database,
and all retired-prefix byte hashes still match. Both apps occupy different fleets;
the released fleet receives a new retirement-generation prefix. This closes the
empty-neighbor evidence gap without changing the historical first-run record.

The prior target was stopped and removed without deleting volumes before restarting
the source for this rerun. An initial resume attempted before runtime readiness
returned an unknown outcome; the explicit retry succeeded, and the queue drained
before the new test began. No source and restored copies ran together.

Operator guides and the imports example now consistently describe the Docker
opt-in instead of the earlier blanket refusal. Full tests and example builds pass;
the default admission policy remains unchanged pending the acceptance audit.


## M11a bounded closeout

The [acceptance audit](m11a-acceptance.md) maps every queue-slice requirement to its
evidence and states the lower-level probe limits. The populated-neighbor and offline
second-target gaps are closed. `docker run --rm --network none fogd-verify:m11a`
passes typechecking and both-target builds for guestbook, grown, accounts, and imports;
the imports queue declarations match and canonical staging succeeds. No hosted
Cloudflare execution was attempted.

Queues are now documented as supported opt-in for the qualified local Docker
profile. The default remains 0 by deliberate policy, not unfinished acceptance.
M11's live-session and scheduled/workflow slices, M12 broader portability, and
remote-host qualification remain open. This closes M11a only.


## M11b reviewed plan and native transport probe

The [M11b plan](m11b.md) preserves native Void WebSocket rooms and separately qualifies
SSE. Its review found four corrections: terminal operation rejection, preserved
WebSockets across code updates, explicit eviction evidence, and an authoritative
snapshot source independent of SSE delivery. The plan incorporates all four.

A minimal `defineRoom` route built and staged without a shim, then passed scoped
CLI upload, exact approval, an HTTP request, and typed WebSocket messages through
workerd in Chromium. [Transport evidence](evidence/m11b-native-websocket.json) records
the immutable artifact. The repeatable probe lives in scripts/live-native.mjs.
This is not yet a durable collaboration app; persistence, reconnect, updates, idle
behavior, failure, SSE and recovery remain open acceptance items.

The completed M11a populated-retirement stack was removed without deleting its
volumes to release Docker network address pools for the new isolated fixture.
Example builds, syntax checks and quality gates pass. No runtime adapter change
or upstream patch was required for this initial transport probe.


## M11b checklist server protocol

[examples/checklist](../examples/checklist/README.md) now implements a native room
with synchronous SQLite transactions, revisions, accepted/refused operation receipts,
and full snapshots. Seven real-SQLite tests cover rollback, replay after later edits,
conflicts, invalid input, capacity, durable rejection and additive receipt schema.

The [reviewed Docker probe](evidence/m11b-board-protocol.json) deploys two apps through
the normal scoped CLI. Through workerd and Chromium it verifies initial snapshots,
concurrent unique revisions, duplicates, conflicts, semantic rejections without
closing sockets, sender-disconnect peer notification, invalid-room refusal,
cross-origin refusal, and separate app/room state. No runtime adapter shim is used.
The [review response](reviews/m11b-board-response.md) records the fixes and remaining
upstream broadcast limitation.

This is a server protocol checkpoint. Browser persistence/reconciliation, failure
and update qualification, SSE, idle eviction, and stopped recovery remain M11b work.


## M11b browser reconciliation and SDK patch

The [checklist UI](../examples/checklist/README.md) now persists individual pending
operations before sending, waits for the first snapshot of a connection, retries
unknown outcomes with the same IDs, and settles terminal rejection. Lower restored
state is visible but blocks writes until explicit acceptance. Shared-tab watermark
and key-deletion races have focused tests.

Review exposed Void 1.1.11's pre-open buffering race. The [upstream-candidate patch](patches/void-websocket-send.md)
adds `sendIfOpen` without changing existing `send`. It is version-pinned and required
by this example; moving the source must carry that patch. Both Docker builds install
with the frozen patched lockfile. [Offline build evidence](evidence/m11b-offline-builds.json)
covers the checklist and earlier examples with no network or hosted execution.

The [browser evidence](evidence/m11b-browser.json) records two users converging,
closing-window submission, no operation before a delayed initial snapshot,
lost-ack persistence/reload without an extra mutation, typed rejection settlement,
and explicit acceptance of an injected higher browser watermark. The watcher uses
a direct workerd connection; only the writer is proxied for fault injection.
This is not physical restored-state evidence. All 278 tests, typechecking, builds,
and quality checks pass. Node failures, update/hibernation, SSE and stopped recovery
remain open M11b work.

## M11b owner and gateway process loss

The [physical failure probe](evidence/m11b-process-failure.json) preserves an
acknowledged checklist edit after killing its owning celld process. The survivor
reports the same cell as resident and published, and acknowledges a second edit
while Docker inspection confirms the original owner is still stopped. After the
owner restarts, a separate workerd kill/restart produces another close/reconnect
and a third acknowledged edit. The final board has exactly three items at revision
three.

In this run, the first authoritative snapshot arrived about 10.5 seconds after
owner kill initiation and 1.1 seconds after workerd kill initiation. New edits were
acknowledged after 11.4 and 1.3 seconds respectively. Both legs observed close code
1006. These are single-run timings including retry/recovery, not availability
bounds. The owner leg's ingress node is unknown and may be the owner itself.

Claude's [review](reviews/m11b-failure-claude.md) required stronger evidence of
survivor takeover and explicit timing events; the [response](reviews/m11b-failure-response.md)
records the assertions added before this passing run. The probe and syntax/quality
checks pass. Non-owning ingress loss, idle eviction, compatible updates, SSE and
stopped backup/restore remain open.

## M11b native socket idle eviction

The [idle probe](evidence/m11b-idle.json) verifies a 30-second ordinary-policy
observation and an explicit five-second eviction configuration. Both replicas
report the configured value. The room leaves their resident sets about 5.2 seconds
after the last active-state observation; the prior owner reports a dormant cell.
The same WebSocket then carries a checked-item operation, advancing the durable
board from revision one to two without reconnecting. The room returns on the same
owner, so this run makes no claim about an ownership move.

The checklist message handler requires room parameters restored from Void's socket
attachment. Missing parameters fail before a mutation. This makes the post-eviction
acknowledgment evidence that the room parameters remain usable. The later update
experiment shows that this does not prove reconstruction in a fresh isolate: idle
eviction can retain the original JS socket object.
The [source review](reviews/m11b-idle-source-claude.md) confirms that celld's resident
list describes in-memory cells and that idle eviction is disabled when unset.

All 278 tests and offline builds pass. The physical probe passes, with the original
replica configuration restored during cleanup. The [review response](reviews/m11b-idle-response.md)
records readiness and evidence improvements. Non-owning ingress loss, compatible
updates, SSE, room-move behavior and stopped recovery remain open.

## M11b non-owning ingress failure and update investigation

The [ingress probe](evidence/m11b-ingress.json) verifies the remaining distinct node
failure path. The browser's selected socket closes after the non-owning ingress is
killed. A control socket directly to the room owner stays open, sees the new board
revision and answers a message. The browser reconnects and commits a second edit
while the ingress remains stopped; owner and workerd process start times remain
unchanged. Cleanup restores the original gateway order and starts the killed node.
Claude's [follow-up review](reviews/m11b-ingress-control-claude.md) accepts the control
socket evidence. This qualifies ingress loss separately from owner loss.

A subsequent compatible-update experiment exposes an open failure: approval leaves
the original socket open, but its first message reaches a handler without its Void
room parameters. The guard throws `Missing checklist room attachment`, celld closes
with 1011, and the browser reconnects before recovering the edit. Reconnection does
not meet the preserved-socket acceptance requirement. The runtime attachment/reload
path is under investigation; the requirement remains open. No runtime workaround
or compatibility claim is included in this checkpoint.
