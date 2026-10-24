# Operator readiness: run the cloud you own

Status: shared storage credential admission and offline transfer commands are
implemented. Transfer has same-engine evidence; second-machine and other image-store
acceptance remain open. Owner inspection implements part of application diagnosis;
local native observation has failure/recovery evidence; scoped logs and broader
live application/controller diagnosis remain open. A bounded two-fleet serving probe
covers uploads, peer activation and controller interruption. Host build-cache
retention has local interruption and restore evidence; controller artifact retention
and broader serving/capacity acceptance remain open. This advances G2 and G3 in the
[vision](vision.md): **Cloudflare you can control and touch.** It does not add
another application binding. The [roadmap](roadmap.md) places this work before
further binding milestones.

An operator should be able to put fogd on another supported machine, deploy a
useful application, find out why it failed, and keep or recover its data. Today,
local qualification depends on cached images and private setup state. More binding
names do not remove that operating burden.

## Scope and sequence

Deliver the following increments separately. Each implementation names its current
limitations and preserves explicit approval, installed identities, stopped recovery,
and default runtime admission. An increment is complete only with evidence for its
own acceptance conditions; it does not imply completion of the whole contract.

### 1. Shared storage credentials

Shared bootstrap generates admin and gateway credentials. The Compose template
retains a development storage password for local use; shared CLI operation must
refuse that password. See
[bootstrap](../packages/cli/src/bootstrap.mjs) and [Compose](../compose.yaml).

Shared startup must require an explicit storage account and a non-development
password before persisting generated configuration or mutating Docker resources.
Both variables must be nonempty and the password must differ from the literal
example development password. The account name `fogd-local` is allowed with a
private password; this increment adds no entropy policy.

The same check applies when the shared profile comes from existing configuration,
including TLS import, enrolled startup from saved Compose configuration, and
experimental Kubernetes rendering. Snapshot restore preserves original credentials
in stopped Docker containers or Kubernetes Secrets with writers stopped; it does
not repair them. Kubernetes startup through kubectl is outside this CLI guard. Local development keeps its existing behavior.
Process environment values retain their existing precedence and are not copied into
the environment file automatically; operators must retain the chosen credentials.

Validation: exercise the real CLI with missing, empty, development, and explicit
credentials; invalid cases leave the environment file unchanged and perform no
Docker mutation. Valid credentials reach the existing enrollment path. Re-entry
preserves the configured values. Errors never include credential values. The
before-write guarantee covers environment credential refusals. A later refusal of
hardcoded custom Compose credentials can follow generated admin/gateway settings;
it must still precede installation writes and Docker mutations.

Startup must never replace an existing storage credential automatically. Existing
shared installations using the development account must receive an actionable
refusal explaining that data and credential migration need a deliberate maintenance
procedure. Changing an environment variable alone is not evidence that stored data
and all consumers have migrated.

Validation: a pre-existing environment file containing the development password
remains byte-for-byte unchanged after refusal. Explicit supported credentials are
preserved across repeated bootstrap calls. Document the migration limitation before
changing this behavior.

### 2. Install on another supported machine

The [offline transfer guide](offline-installation.md) documents the implemented
export, authenticated bootstrap, verification, and import commands. The
[local transfer evidence](evidence/operator-transfer-local.json) covers a transferred
CLI outside the checkout, fresh private-credential enrollment, scoped app deployment,
and saved data after a full installation stop/start on the same classic `overlay2`
engine. This does not complete the separate-machine acceptance condition below. The
[candidate distribution drill](evidence/operator-candidate-transfer.json) also
loads an authenticated bundle into an empty independent engine, then uses its
received operator and standalone developer client for scoped HTTPS deployment and
data after restart. It requires internal candidate selection and shares the
physical host; ordinary released-family and separate-machine acceptance remain
open.

Provide an operator path for transferring the qualified runtime and storage images,
matching CLI source, runtime catalog, and required configuration instructions to a
second Linux arm64 Docker host. Begin with an offline transfer bundle; registry
publication and a native rebuild are separate work. Private credentials, TLS keys,
application artifacts, and installation identities must not enter that bundle.

Validation: export from the cached qualified inputs, inspect bundle contents and
hashes independently, and load into an isolated Docker image store. Follow the
published instructions using only bundle contents and declared host prerequisites.
Enroll fresh storage with explicit credentials, deploy and approve the supported
fixture, and verify persistent data through a restart. Record any author assistance.
A second Compose project on the original daemon alone does not prove this gate.

Import must reject altered, missing, wrong-architecture, or unexpected inputs before
starting containers. No installation identity or application state may be inherited
from the source machine. Existing stacks and volumes must remain untouched.

Validation: corrupt and omit individual bundle members and supply an unsupported
architecture; each case refuses without starting services. Compare source resources
before and after transfer. Image identity must equal the qualified catalog pins.

### 3. Diagnose an application

The owner can use [`fogd admin inspect APP`](application-inspection.md) to connect
recorded routing, release history, activation progress, ownership/migration
references, and background controls. The [submitter status command](submission-status.md)
now bounds reads, verifies submission identity and limits output to public fields
and fixed explanations, with [local evidence](evidence/operator-submitter-status-local.json)
for failed SQL, correction and credential boundaries. Both views report recorded
state and withhold private errors. [Local native observation](application-observation.md)
checks approved versions, signed runtime identity and replica health without app
requests. It does not establish controller storage health or application outcomes.
Source status reporting now recognizes the existing queue activation and replacement
steps with fixed public explanations. The frozen runtime still discards those labels;
new-family qualification, scoped logs and broader live diagnosis remain open.
The host [gateway request check](application-check.md) sends an explicit app-path
GET and reports status and time to headers without response contents. It has host
HTTP/TLS and mocked-Docker tests; native acceptance, application-health assertions
and scoped logs remain open. These commands implement part of this increment.

Provide scoped deployment diagnostics that connect a submitted release, approval
progress, runtime state, and the application's recorded failure. Correct unknown
progress labels for existing queue lifecycle steps when a new runtime family can be
built and qualified. The [private replica-log interface](application-logs.md) defines local Docker-owner
capture and its disclosure policy. The source CLI implements that owner-only
surface with bounded process/file tests and a mocked Docker boundary. Raw streams stay in
private files and are not safe submitter-facing output. Native acceptance and a
separate structured shared-log interface remain open.

The [native diagnostic drill](evidence/operator-native-diagnostics.json) covers
two durable-candidate apps with private configuration. A request check observes a
500 while signed native readiness remains confirmed; a corrected release returns
200. Owner log captures retain only the selected fleet’s process streams in private
files, including while routing is paused, a replica is stopped or the controller is
down. During controller loss, gateway checks still report 200 while native readiness
stays uncertain. A stopped or still-recovering replica remains uncertain until
fresh native checks confirm it.
These internal candidate checks do not complete native queue-step, shared-log or
full-family qualification.

Validation: submit a failing application, observe its failure through the supported
CLI, correct it, and observe the successful release. Exercise all existing queue
progress steps. An app-scoped submitter cannot inspect another app, operator
credentials, secret values, or private runtime controls. A withheld or unreachable
runtime is reported as uncertain rather than healthy.

### 4. Retain releases deliberately

The [host retention commands](build-retention.md) implement the local build-copy
subset with [same-engine evidence](evidence/operator-retention-local.json) for an
interrupted operator prune, offline resume, overlapping approval and backup, another
deployment, and fresh-volume restore. Legacy and uncertain outputs remain kept.
[Controller artifact retention](controller-artifacts.md) is implemented in source
with an owner-only preview, exact-release pins, explicit pruning, quota
re-accounting, and interrupted-prune resume. Temporary-filesystem tests cover
process interruption, metadata write uncertainty, protected releases and completed
stopped restore. The frozen server does not provide these endpoints. The
[native candidate drill](evidence/operator-native-artifact-retention.json) covers
quota refusal, protected artifacts and pins, interrupted pruning, explicit resume,
quota reclamation, another deployment and restoration of a retained pre-prune
snapshot. Approval and backup attempts while pruning remains pending refuse.
The [uninterrupted concurrency drill](evidence/operator-native-artifact-concurrency.json)
also starts approval and backup after observing partial deletion. All commands
complete, protected hashes match in source and snapshot, and fresh-resource restore
preserves the completed prune, approved update and application data. Ordinary
runtime-family release remains open.
The [held-route diagnosis](evidence/operator-held-observation.json) reproduces a
cold restored fleet with expired node leases. The routing verifier refuses before
native state/health requests; later lease renewal permits signed verification
without an operator restart. Owner observation now exposes native facts and lease
state while HTTP routing stays held. Full startup timing and recovery qualification
remain open; observation never substitutes for a new exact routing decision.

The owner can inspect [backing filesystem space](storage-space.md) without
starting services or recreating missing volumes. These observations are separate from
artifact quota accounting, per-volume usage and storage-health checks.

Provide an inspectable retention plan and an explicit execution command. Active
releases, unfinished operations, recovery references, and operator-selected retained
releases must remain protected. Define which local build outputs and controller
artifacts are covered; deleting an artifact is distinct from retiring an app or
deleting its data. Automatic pruning is outside the first increment. Host build-output
retention can ship separately; controller artifact deletion requires a new qualified runtime.

Validation: fill the declared artifact quota, preview reclaimable bytes and protected
references, execute the plan, and successfully deploy again. Interrupt execution and
retry. Concurrent approval and backup must not lose a referenced artifact. Verify
protected bytes and restore the retained recovery point after pruning.

### 5. Measure serving and capacity

The [paired serving guide](serving-measurement.md) supplies a repeatable local
two-fleet read workload during maximum-size uploads, peer activation and controller
interruption. It compares the complete gateway path with one direct replica and
retains raw errors and resource counters. The [write workload](serving-measurement.md#write-workload-and-response-reconciliation)
adds response/ledger reconciliation with one writing app and an idle or deploying
peer. Its corrected local trial failed the native storage-health check with
HTTP 507 responses and low Docker backing-filesystem headroom, so write-performance
acceptance remains open. Broader app-count, concurrent-app write-load and density
acceptance below remain open.

Measure end-to-end latency, throughput, memory, and failure behavior across the
currently supported app counts, with idle apps, active traffic, and concurrent
uploads. Include controller interruption because routing depends on the controller.
Publish the workload, hardware, duration, errors, and distributions with the results.

Validation: repeat the workloads and preserve raw measurements. Separate ingress,
controller, and application costs where measurable. Record rejected admissions and
recovery after interruption. Choose density limits or routing changes from those
measurements; route caching needs an explicit approval and pause contract first.
No speed or availability target is established by an unmeasured guess.

## Operator workflow and costs

The [standalone developer client](developer-client.md) lets developers submit and
inspect their releases using an endpoint and scoped deploy token. Its image-free
bundle has a separate state home and can run outside the checkout. Operators keep
installation and approval authority; this does not complete second-machine
installation acceptance.

Link installation, deploy/approval, diagnosis, backup, recovery, and upgrade from one
operator entry point as these increments ship. Record required downtime, loss
boundaries, and commands that require a stopped installation. A fresh operator must
be able to follow the supported path without relying on private qualification files.
The [operator guide](operator-guide.md) provides that entry point and the public
startup network-plan option removes qualification-time Compose editing. Independent
human usability and second-machine acceptance remain open.

The maintainers bear the cost of packaging, compatibility checks, diagnostics, and
retention safety. Operators still maintain host capacity, certificates, and backups.
Doing nothing leaves a capable local prototype whose operating procedures depend on
its author. Adding more bindings first is attractive for app coverage, but it leaves
the same installability and maintenance barriers for every new app.

Workflows, general Durable Object alarms, broader architectures, remote topology
qualification, hosted Cloudflare execution, and arbitrary untrusted tenants remain
separate roadmap work. This contract does not authorize image builds, dependency
installation, public publication, or changes to private infrastructure.

## Runtime change boundary

The credential increment changes host CLI admission, not the frozen runtime image.
The transfer increment can use cached images without a build. Correcting controller
progress labels and reclaiming controller artifacts change frozen image sources;
they require separately authorized image assembly and qualification of a new family.
They must not alter the current catalog pins or be presented as host-only changes.
Host-side work can continue while that build constraint remains in force.

### Next runtime release

The next runtime release should remove installation and operating barriers before
adding another binding family. These requirements remain open:

- **Build from declared inputs.** Record the native source revision, patches,
  dependency locks, toolchain and base-image inputs, and the resulting native,
  supervisor and program fingerprints. Exercise the recipe on a clean build host
  without an earlier private seed image or undeclared cache. A new build receives
  its own runtime-family identity and qualification; it need not reproduce the
  current cached binary's digest. Maintainers own the recipe and patch upkeep.
  The [source-preparation command](runtime-selection.md#prepare-the-next-native-source)
  declares and checks the upstream source, dependency lock and ordered patches;
  the [build-context command](runtime-selection.md#prepare-a-runtime-build-context)
  captures pinned base images, production sources and dependency locks. The candidate
  recipe declares the prebuilt V8 archive and bindings with content hashes and
  uses the locked workerd platform package without installer fallback downloads.
  The [source-build command](runtime-selection.md#build-a-source-candidate) connects
  preparation, bounded private build logs and checked image fingerprints. It has
  process/filesystem tests with a substituted Docker executable and
  [native build evidence](evidence/operator-source-build.json) from a fresh isolated
  engine without a private seed image. Native tests, strict lint and output
  fingerprint checks pass. Separate-machine installation, image digest
  reproducibility and application lifecycle qualification remain open.
- **Install independently.** Follow the public installation procedure on a
  separate supported Docker engine using the distributed release and declared
  prerequisites. Deploy, approve, update, restart and recover an application while
  checking its saved records and pending-code isolation. Record assistance and
  failures. This tests distribution and operation separately from building source.
- **Serve through controller loss.** Define the route authority, staleness bound
  and pause acknowledgment before introducing a gateway cache or another routing
  mechanism. The [serving-authority proposal](serving-authority.md) selects a separate
  durable route record, fresh gateway reads and a crash-ordering contract before
  implementation; no new route authority is enabled. Test controller loss alongside approval,
  migration, operator pause,
  retirement and restart. A warmed route must not bypass a required pause or serve
  another app's data; retain unknown outcomes and measure recovery. Gateway code is
  part of the pinned runtime program, so this change needs a new family too. The
  source [routing CLI](http-routing.md) supplies exact-approval operator controls;
  native acceptance remains open.
- **Inspect live applications.** Define an app-scoped diagnostic interface and
  its disclosure policy before exposing runtime logs. Test two applications,
  private configuration, unavailable replicas, and failure followed by correction.
  Filtering mixed stdout by an app name or replacing known secret strings alone
  does not establish isolation or safe disclosure.

The [durable candidate evidence](evidence/operator-durable-candidate.json) covers
internal enrollment on a separate classic-overlay2 engine, two approved apps,
controller-stop serving with an acknowledged app pause, a write during controller
loss, and D1/R2/Durable Object data after retained startup. This uses local HTTP on
the same physical machine. The separate
[HTTPS and recovery evidence](evidence/operator-durable-https-recovery.json) covers
scoped HTTPS deployment, native operator forms, stopped backup, fresh-resource
restore, explicit HTTP resume, retained D1/R2/Durable Object data and new writes.
The source refuses startup while its restored target runs. One initially uncertain
resume stayed withheld; a new decision succeeded after fresh state and native
identity/version/health checks. The separate candidate distribution drill covers
bundle transfer and received-code operation. The
[native gateway restart](evidence/operator-native-gateway-restart.json) serves both
apps and acknowledges a durable write after gateway restart while the controller
stays stopped. The [native route crash matrix](evidence/operator-native-route-crashes.json)
covers six pause/resume publication boundaries, restricted APIs, exact pending
withdrawal/reconciliation and ordered restart, preserving the peer's four records.
Eight [native update crash cases](evidence/operator-native-activation-crashes.json)
also cover selected activation, migration-ledger and active-publication boundaries,
with nine retained SQL rows, four peer records and a fresh stopped snapshot. They
do not cover the gap between native SQL commit and controller ledger commit.
The durable snapshot retirement coordinator has component checks for source
verification, fresh replacement identities and disks, survivor holds and incomplete
enrollment after faults. The [v3 candidate package](evidence/operator-durable-retirement-package.json)
includes the new stopped helper and preserves the pinned native binaries. Native
retirement and same-family recovery have [bounded native evidence](evidence/operator-native-durable-retirement.json)
from a fresh two-fleet installation. Two retirements preserve prior history,
different-name replacements use fresh storage, and recovered apps retain data and
accept new writes. The post-finalizer host-error case keeps its target unstarted
and enrollment incomplete. [Zero-live-app recovery](evidence/operator-native-zero-live-recovery.json)
also preserves four tombstones and restores two free slots; a new app starts empty
and writes after exact approval. Native background retirement and v2-to-v3 migration
remain unqualified. The [native first-claim crash](evidence/operator-native-first-claim-crash.json)
interrupts the controller after durable ownership confirmation and before migrations
or application publication. The app remains withheld, its bucket has an owner but
no deployment, and explicit same-artifact approval starts empty and permits a write.
The peer record and retired namespaces remain intact. Three earlier
[withholding publication crashes](evidence/operator-native-first-claim-withholding-crashes.json)
recover without native ownership or deployment objects. Exact rejection releases
two pristine reservations; exact approval of the third starts empty and writes.
Ordinary released-family selection, native owner-write uncertainty, retirement
crashes, restricted recovery browser interaction and the full recovery/load matrix
remain open.

Cached-image transfer remains useful without a source rebuild, and existing local
qualification remains evidence for its recorded artifact. Neither closes the
separate-machine or clean-build requirements. The released legacy routing behavior
still refuses during controller loss and retains the measured application outage.
The durable candidate's availability evidence remains bounded to its declared
topology and generation. Broader serving availability remains an explicit product gap.

Existing shared installations with the development password were already outside
the shared guide's requirement to choose a private password before first use.
Refusing that configuration is intentional hardening. It does not claim a credential
migration is qualified, or silently turn an environment edit into a migration.
