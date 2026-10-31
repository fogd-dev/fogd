# Proposed roadmap

**Product goal: Cloudflare you can control and touch.** Build toward the
[vision](vision.md): an application cloud you own and run on your infrastructure.
Homelabs and team infrastructure are places to use it. The capability milestones
below support that product; later scopes and sequencing remain proposals.
M7–M8 and M10–M11 have bounded local qualification; M9 has experimental local
Kubernetes evidence. Broader operator readiness and later capabilities remain open.

M7a is qualified locally, including a successful [fresh-agent onboarding test](onboarding.md).
Human usability feedback is optional and does not block progress. See the [fixture guide](../examples/guestbook/README.md)
and [implementation report](report.md). M7b, M7c, M8a, M8b1, and M8b2 are locally qualified; M9a and M9b have experimental local Kubernetes evidence; M10a capacity reporting and M10b Docker retirement are qualified; M10c qualifies fresh three-fleet Docker installations, stopped expansion/recovery/retirement, and paired resource observations. M11a queues, M11b live sessions, and M11c scheduled work have bounded local qualification. Workflows and general Durable Object alarms remain open.

## Current foundation

The local prototype builds selected Void apps, requires approval of an immutable
artifact, routes up to three apps on qualified Docker layouts, and tests a subset of D1/R2/Durable Object behavior and
replica recovery. Native React browser/SDK workflows and a bounded email/password auth flow are qualified. Additional
SDK/framework paths, shared remote operation, broader resource evolution, and
shared-operation recovery policy remain gaps. M8a qualifies stopped local backup/restore. M7b qualifies R2 additions and one bounded
logical transfer profile. See [report.md](report.md) for exact evidence.
Do not infer product support from the runtimes' feature lists.

## Immediate priorities

The bounded [M11c acceptance](m11c-acceptance.md) and public-selector release check
are complete. Additional cron qualification work needs an identified acceptance gap
or a reproducible defect; broader topology and runtime admission remain gated.

The [v8 acceptance audit](operator-v8-acceptance.md) qualifies explicit fresh local
two-fleet installations with verified release comparisons, attributed decisions
and artifact pruning that retains history. Its
[empty-engine versioned rehearsal](evidence/operator-v8-versioned-pruned-recovery.json)
covers received-client update, stopped backup and fresh pruned-state recovery.
The [admission receipt](evidence/operator-v8-admission.json) records the actual
qualified-catalog installation check. Default cron admission remains closed.
V7 remains closed because its image lacks the retention correction. There are no
existing user installations; fresh installation is the release target.

Safe turnover follows the [application lifecycle contract](application-lifecycle.md).
The [v9 acceptance boundary](operator-v9-acceptance.md) adds explicit fresh local
two-fleet archival and restoration with retained data, reviewed capacity changes
and owner recovery approval. The native and received-operator checks cover peer
preservation, background holds, secret rotation and interrupted commands. Default
cron admission stays closed. [Verified preview preparation](previews.md) binds an
exact proposal without executing it. Internal deadline and authenticated HTTPS
ingress components have process, container and browser checks. Internal signed
execution decisions and isolated bridge/DNS controls also have bounded component
checks. The internal decision coordinator verifies prepared artifact bytes and
current source snapshots before signing. A candidate backend image has bounded
native HTTP/D1/R2 and storage/replica expiry evidence. Its exact-artifact controller
has signed-input and native activation checks with no upload/approval HTTP API.
The native gateway and authenticated HTTPS ingress also have a protected-URL
D1/R2 check. Fresh enrollment, shipped preview-runtime admission, ordered shutdown,
public launch and complete fresh-app/update trials remain open under
issue #2 and must reuse these fencing and restoration rules. Existing
deployments are QA fixtures; cross-family migration is outside this release path.

The internal preview host plan now seals role/network/volume placement and binds
realized commands to the signed target. Read-only eligibility includes retained
names/ports, active memory limits and held allocations. An internal engine-bound
host fence and append-only reservation ledger retain budgets across stop, expiry
and interruption. Internal stopped allocation creates the full role layout and
verifies actual resource identities, limits, mounts and network placement without
starting services. The plan includes a budgeted networkless input installer;
checked artifact/secret/TLS installation has actual mount readback with every
application service still never-started. Shipped runtime admission, source
recheck and final launch checks remain the next host-lifecycle work before
public preview launch. The ledger is local coordination, not a distributed engine
lock or a Docker memory allocation.

Internal manual teardown confirms ingress, management and native-writer shutdown
before stopping storage. Explicit post-expiry memory retirement requires the
ordered journal and a fresh stopped graph; names, data and physical resources
remain retained. Native lease cleanup, data recovery, automatic expiry ordering
and full fresh-app/update browser acceptance are not established by that check.

Before selecting another binding milestone, implement the proposed
[operator-readiness contract](operator-readiness.md) under G2 and G3. It addresses
these current gaps:

- **Installability:** a supported runtime must have a documented, reproducible path
  onto another supported machine. A local image digest and receipts alone do not
  provide that path. The [offline transfer commands](offline-installation.md) now
  have same-engine installation and app-persistence evidence; isolated-store and
  second-machine acceptance remain open.
- **Everyday operation:** provide scoped application diagnostics and an artifact
  retention policy that preserves active releases, held operations, and recovery
  references. Enforce shared-installation storage credential requirements without
  silently changing credentials on existing data. [Host build-cache retention](build-retention.md)
  now has local interrupted-prune and restore evidence. Owner-only
  [controller artifact retention](controller-artifacts.md) commands are implemented
  in source, including explicit pruning and interrupted-prune resume. The
  [native candidate drill](evidence/operator-native-artifact-retention.json) covers
  quota refusal, interrupted pruning, explicit reclamation and retained recovery.
  [Concurrent approval and backup](evidence/operator-native-artifact-concurrency.json)
  during uninterrupted deletion also pass with protected hashes and restored data.
  Ordinary runtime-family release remains open.
- **Capacity and serving:** measure latency, throughput, memory, and controller-loss
  behavior across declared app counts and concurrent uploads. Use those results to
  decide app density and routing architecture; caching needs an explicit approval
  and pause contract. The [paired serving probe](serving-measurement.md) now
  exercises local two-fleet reads during uploads, peer activation and controller
  interruption. Two [native candidate write runs](evidence/operator-durable-write-serving-local.json)
  retain all 11,672 acknowledged writes in first ledger reads and sample no errors
  during peer uploads, activation or controller interruption. Two
  [concurrent-app write runs](evidence/operator-concurrent-write-serving-local.json)
  also retain all 14,816 acknowledged writes. They record 48 gateway HTTP 503
  responses during the writing peer's activation, with no sampled errors for the
  other app or through controller interruption. These observations do not qualify
  zero-downtime updates. Broader application counts and density limits remain open.
  [Native candidate restart and crash checks](evidence/operator-native-route-crashes.json)
  cover paused/resumed authority and recovery; the
  [gateway restart drill](evidence/operator-native-gateway-restart.json) covers serving
  through controller loss. Eight [native update crash cases](evidence/operator-native-activation-crashes.json)
  cover selected activation, migration-ledger and active-publication boundaries.
  A [native first-claim crash](evidence/operator-native-first-claim-crash.json)
  after durable ownership confirmation preserves withholding before migrations or
  application publication; an explicit same-artifact retry starts empty and writes
  while retaining the peer record. Three earlier
  [withholding crash boundaries](evidence/operator-native-first-claim-withholding-crashes.json)
  recover without native ownership or deployment objects; exact rejection releases
  pristine reservations and exact approval starts an empty app. A native
  [ownership confirmation gap](evidence/operator-native-ownership-confirmation-gap.json)
  also preserves an assigned owner before controller confirmation: rejection and
  alternate approval refuse, while the original approval recovers without changing
  owner metadata. A [lost owner-response drill](evidence/operator-native-owner-response-loss.json)
  also records a failed claim after ownership is assigned but bucket responses are
  lost; exact retry preserves the owner record and peer data without a controller
  restart. Other owner-write failure modes, retirement process-crash
  matrices, broader counts and loads remain open. The [v3 native retirement drill](evidence/operator-native-durable-retirement.json)
  covers two retirements, different-name replacements, retained namespace bytes
  and ordinary recovery with both tombstones. An injected host error after native
  finalization preserves incomplete enrollment and refuses startup. Two
  [native retirement process cuts](evidence/operator-native-retirement-process-crashes.json)
  after private-state and public-route directory fsyncs also preserve incomplete
  enrollment and refuse startup before Docker. A fresh target from the original
  snapshot retains survivor data and supports a new empty app and write. Five
  [additional store cuts](evidence/operator-native-retirement-store-edges.json)
  cover a consumed restoration grant, both staging-file syncs and both renames
  before directory sync. All interrupted targets stay fenced; the completed
  installation restarts with its saved records. The
  [partial-write and I/O drill](evidence/operator-native-retirement-io-faults.json)
  adds truncated marker/private/public writes and reported errors after successful
  syncs. All six targets stay fenced, and the completed installation retains its
  data through another restart. The
  [last-app follow-up](evidence/operator-native-zero-live-recovery.json) restores
  four tombstones with no live apps and then approves a fresh app in the freed
  capacity. Native background retirement, process-crash gates and ordinary release
  remain open.
  Existing v2 installations cannot run this protocol or adopt v3 through an
  unqualified family migration.
- **Operator workflow:** make installation, deployment, diagnosis, backup, recovery,
  and upgrade procedures easy to find. Record the current downtime and loss
  boundaries alongside the supported commands. The [standalone developer client](developer-client.md)
  supplies deployment and scoped status outside the checkout without operator images;
  app dependencies and operator approval remain prerequisites.
  [Native restricted browser recovery](evidence/operator-native-restricted-browser.json)
  now exercises exact pending withholding and reconciliation with JavaScript
  disabled, keeping ingress stopped until ordered startup and retaining app data.

The contract supplies acceptance conditions for each increment. These are product
priorities, not newly qualified capabilities. Exact-artifact approval and
the existing recovery boundaries remain in force.
Its [next runtime release requirements](operator-readiness.md#next-runtime-release)
separate clean builds, installation on another engine, controller-loss serving and
live application diagnosis. The [serving-authority proposal](serving-authority.md)
selects durable route authority and fresh-read/crash gates for a new runtime.
Host CLI improvements do not close those release gaps.

The next release targets fresh installations. The
[v4 candidate](evidence/operator-durable-v4-source-build.json) now carries the
source-only migration-retry fix in a source-built immutable image. Two fresh
[native retry checks](evidence/operator-native-migration-retry-v4.json) verify the
fully committed HTTP migration/controller-ledger gap. Full-family background,
recovery and independent-installation qualification remain open. Cross-family
migration remains refused and does not block the fresh-install release path.
The [v4 background lifecycle attempt](evidence/operator-native-background-v4.json)
failed because a plain HTTP pause blocked explicit cron resume. The source fix
separates those permissions while preserving activation and recovery holds. The
[v5 source build](evidence/operator-durable-v5-source-build.json) carries that fix
under a new immutable identity. It must pass native acceptance before admission.
V5 now has [bounded native background evidence](evidence/operator-native-background-v5.json)
and [HTTP migration-retry evidence](evidence/operator-native-migration-retry-v5.json)
on another isolated Docker engine on the same physical host. The background trial
checks cron and queue resume with HTTP withheld, a controller outage across an
observed cron deadline, and a stopped snapshot. A
[cron activation interruption](evidence/operator-native-cron-activation-v5.json)
also checks unpublished and held-migration minutes, controller loss after
publication, confirmed rehold, pinned secret-revision refusal and original retry.
The corrected probe restarts only the verified controller; the earlier ordinary
startup refusal remains unaccepted. The
[v5 activation matrix](evidence/operator-native-cron-activation-matrix-v5.json)
adds native resume, durable dispatch release and operator-paused update cuts.
Each requires confirmed rehold and exact retry; the paused update remains paused
until a separate resume. Two earlier probe failures remain unaccepted. The
[v5 unreachable-member pause](evidence/operator-native-unreachable-pause-v5.json)
preserves unconfirmed intent across controller restart while native work continues,
then confirms explicit pause after rejoin. Its held minute leaves all recorded
ledgers unchanged and preserves an acknowledged peer import. The
[v5 offline build check](evidence/operator-native-offline-builds-v5.json) builds
minute and three-minute fixtures through ordinary Void and fogd with networking
disabled, then approves and executes both on v5. Read-only engine-local sources
and retained outputs remove the host-path sharing dependency. The SDK dependency
preparation uses networking and has its own receipt. The
[v5 compatible replacement check](evidence/operator-native-compatible-replacement-v5.json)
now covers migration overlap, interrupted callbacks, lost acknowledgments and
unchanged ledgers during confirmed pause. The first timing-window failure remains
unaccepted and retained. The [final v5 acceptance audit](operator-v5-acceptance.md)
now qualifies explicit fresh-install selection and verifies the actual public
catalog through transfer, deployment, update, restart and fresh recovery. Default
cron admission remains closed. [Versioned release artifacts](releases.md) now
combine the operator/runtime bundle and standalone client, with verified
[empty-engine onboarding](evidence/operator-versioned-release.json). Public
publication and broader preflight remain open. A
[native SQL rollback check](evidence/operator-native-migration-rollback-v5.json)
verifies failure after application SQL but before migration-name bookkeeping.
Two failed exact approvals leave no new row or ledger entry; removing the SQL
fault permits one successful commit of the same artifact while preserving peer
data. Native process interruption and power-loss behavior remain outside this
check. A
[paused-snapshot restore](evidence/operator-native-background-recovery-v5.json)
now verifies fresh target volumes, cold and acknowledged background holds, explicit
resume and unchanged old occurrences. The
[v5 recovery matrix](evidence/operator-native-background-full-recovery-v5.json)
adds due timers, a pending retry with original queued input, and an older snapshot
on fresh targets. Background work stays held until explicit resume; the original
queued input completes without resubmission. Older recovery acknowledges possible
lost results or replayed effects. The
[v5 sequential retirement check](evidence/operator-native-background-retirement-v5.json)
adds four retirements, fresh queue/cron capacity, retained survivor input and
zero-live recovery. All five source snapshots retain their bytes after the three
restore audits. The
[v5 dual-cron check](evidence/operator-native-background-retirement-dual-v5.json)
adds retirement beside another live cron across a shared deadline, explicit
survivor resume and a verified no-replay interval. Both source snapshots restore
with their recorded data and retirement history. The
[v5 scheduler failure check](evidence/operator-native-background-failures-v5.json)
adds owner/waker loss during a pending retry, lease-bounded takeover and owner
rejoin, followed by full cron-fleet downtime. A recorded quiet restart completes
the overdue occurrence and skips missed natural ticks; peer queue records remain
unchanged. A [sparse terminal retry check](evidence/operator-native-cron-terminal-v5.json)
also verifies the six-attempt ceiling, native backoff, future correction and no
failed-occurrence replay. The
[retirement evidence map](evidence/operator-v5-retirement-evidence-map.json) links
13 retained v3 finalizer interruption/I/O cases to the unchanged v5 store/fencing
mechanism, with dependency, runtime and coordinator checks. It records inference
from existing evidence, without claiming a new v5 fault run. Other failure paths
and full family acceptance remain open.

The [v5 publication map](evidence/operator-v5-publication-evidence-map.json) also
maps 14 retained HTTP publication/activation cases to unchanged v5 paths. It
rechecks captured stores and records the five unavailable original temporary
harness files. The [clean-recipe map](evidence/operator-v5-clean-recipe-evidence-map.json)
verifies the original clean-engine recipe against the later uncached v5 build:
build machinery, native inputs and root dependencies match, while changed context
members are declared program files. Neither map claims a new interruption run or
a fresh v5 builder. Final family acceptance and ordinary admission remain open.

The [v5 received-code installation](evidence/operator-v5-received-installation.json)
checks the offline operator/client path on an independent existing Docker engine on
the same physical Mac. Both scoped HTTP/D1 apps retain data after full stop/start. The
[proposed-release rehearsal](evidence/operator-v5-release-rehearsal.json) adds the
public command path through received-client update, stopped backup and fresh
recovery. Its private catalog changes only v5's admission field; the repository
stays closed. Exact approvals, native readiness observations and separate HTTP
resumes preserve saved rows and leave the pending peer update inert.
Internal candidate selection and prepared project dependencies are explicit
assistance. Separate physical-machine and ordinary released-family installation
remain open.

The [v5 write checks](evidence/operator-native-write-serving-v5.json) retain all
14,842 acknowledged writes across single-writer and concurrent two-app profiles,
including controller interruption. The updating peer returns 20 gateway HTTP 503 responses
during activation; zero-downtime updates remain unqualified. An actual v5 archive
also passes [unsupported-family refusal checks](evidence/operator-v5-family-refusal.json)
before target allocation. These bounded checks leave ordinary v5 admission closed
and do not add cross-family migration to the fresh-install release requirements.

## Milestones and acceptance gates

| Milestone | Capability and goal | Exit evidence | Outside this milestone |
| --- | --- | --- | --- |
| M7a. One complete Void app, twice | Qualify the full-stack development/deploy loop (G1, G3, G4) | One supported UI/assets/typed API/D1 fixture; two releases retain records; submitter-visible status; approval checks; offline second-target build; a fresh agent reproduces the documented local workflow without author assistance | Shared remote hosting, app-auth/provider integration, new binding families |
| M7b. Grow that application | Add resources without abandoning data (G1, G3, G4) | One compatible resource addition preserves identities and records; logical export/restore fixture covers the supported data profile; unsupported/destructive changes fail explicitly | Resource renames/deletions, general migration tools, slot reuse |
| M7c. Private configuration and app identity | Preserve the supported Void environment/auth experience (G1, G3) | Required-secret declarations validate before activation; operator-supplied secret values stay out of submitted/downloadable artifacts and status; a bounded native Void auth flow and its migrations work; app login is separate from deploy permission | Every auth provider, universal SSO/RBAC, weakening reserved-route protection |
| M8. Recoverable installation | Operators can keep and recover applications (G2, G3) | Document required state and identities; establish a stopped/quiesced backup; restore onto fresh storage; test upgrade/interruption; record recovery time and loss boundary; qualify separate platform identities, TLS/access policy, secret recovery, and quotas for shared operation | Global HA, live geo-replication, arbitrary untrusted tenants |
| M9. A second deployment environment | The same application contract works outside local Docker (G2, G3) | Operator follows installation and recovery procedures; actual host/storage/network failure tests validate the declared topology; app authors need no cluster credentials | A Kubernetes operator, automatic multi-region placement, organization-specific features in core |
| M10. Capacity and retirement | Operators can host more apps and retire them safely (G2, G3) | Export/retention/deletion are explicit; slot reuse cannot inherit data or authority; capacity refusal is observable; per-app operating costs are measured | Automatic scaling without measured limits, destructive schema rollback |
| M11. Background and collaborative applications | Supported app types expand with tested semantics (G1, G3) | Separate slices qualify queue/scheduled/workflow and Durable Object alarm activation, retries, draining, and idempotency; another qualifies live sessions, reconnect, and reconciliation through updates/failure | Enabling every upstream binding together; claiming sockets survive process loss |
| M12. Broader portability | Supported apps move between targets (G4) | Repeatable preflight, documented code/config differences, logical export/import, offline managed-target builds, and U10-driven non-Void Workers import as a separate conditional slice | Emulation of every Cloudflare control-plane API; claiming hosted tests were run |

Milestone numbers continue the six completed prototype milestones. [M7a](next-milestone.md)
records the current qualification; M7b, M7c, M8a, M8b1, and M8b2 are locally qualified; M9a and M9b have experimental local Kubernetes evidence; M10a capacity reporting and M10b Docker retirement are qualified; M10c qualifies fresh three-fleet Docker installations, stopped expansion/recovery/retirement, and paired resource observations. M11a queues, M11b live sessions, and M11c scheduled work have bounded local qualification. Workflows and general Durable Object alarms remain open. Later
milestones are capability groups to split
into bounded specs, not promises of one large release each. Security and recovery
needed for shared or valuable data cannot be deferred behind a pilot deadline.

## Cross-cutting portability work

Start a portability fixture in M7 and carry it through every milestone. Build the
same supported app for local and offline Cloudflare targets without forking app
logic. Record unsupported features immediately. Establish logical data roundtrip
fixtures as stateful behavior is qualified; preserve this evidence during runtime
upgrades. M12 broadens the audience and tooling rather than postponing portability
until the end. No Cloudflare credentials or API calls are allowed.

Physical backups support recovery of the declared installation; logical exports
support application migration. They are distinct contracts. A file copied from a
bucket is not automatically a restorable database or a portable application.
See [compatibility-policy.md](compatibility-policy.md).

## Candidate pilots and prerequisite discovery

| Pilot | What it can validate | What it cannot establish alone |
| --- | --- | --- |
| An existing FilOz demo | Void fit, deploy/update effort, shared access and approval, persistent URL | Universal demand, all frameworks, or general platform reliability |
| A personal homelab application | Installation, small-capacity operation, recovery, and operator clarity | Worldwide availability or shared-team identity requirements |
| An independent app with an offline managed-target handoff | Code/data portability and specific incompatibilities | Actual hosted execution or business demand |

The pinned starter has passed the local [M7a qualification](next-milestone.md).
Inventory a candidate pilot app when one is available. App selection can refine
requirements; lack of an immediately supplied demo need not block documenting the
reusable contract. Do not invent a dashboard or force each app to use every binding.

Kubernetes is a candidate M9 target for the FilOz pilot; a two-host homelab remains
another. Select one second environment first based on operator access and readiness.
Private installation details stay in the operator's repository. Prefer ordinary
platform resources before designing a custom scheduler or Kubernetes operator.

## What the next spec needs to resolve

The [M7b contract](m7b.md) qualifies additive R2 declarations and the guestbook
logical transfer profile. The [M7c contract](m7c.md) and [review amendments](reviews/m7c-response.md) qualify
private configuration and one native Void auth flow. The [M8a recovery contract](m8a.md) qualifies stopped local backup/restore.
M8b1 qualifies scoped credentials and admission limits. [M8b2](m8b2.md) qualifies
HTTPS, explicit shared-mode policy, and recovery/upgrade evidence with those controls.
The [M9a Kubernetes contract](m9a.md) has local kind deployment/pod-replacement evidence.
[M9b stopped Kubernetes recovery](m9b.md) has fresh-claim restore evidence; remote-host qualification remains open.
[M10a capacity reporting](m10a.md) is qualified through controller, HTTP, and CLI
tests. [M10b retirement](retirement.md) qualifies the offline fresh-installation path.
The [M10c expansion guide](expansion.md) qualifies three Docker fleets, fresh
rendering, stopped expansion, full restore, and middle-fleet retirement/reuse. The
[measurement guide](capacity-measurement.md) records paired two/three-fleet reads
and local operating costs. M10 is complete within this bounded Docker scope.
The [M11a queue proposal](m11a.md), [review amendments](reviews/m11a-response.md),
and [repeatable runtime qualification](queue-qualification.md) now define the next
implementation slice: controller delivery lifecycle. The internal generation gate
and [delivery journal](delivery-journal.md) are integrated into the
[activation coordinator](queue-activation.md), with private-artifact controller tests
and process-kill recovery evidence. A built-controller Docker probe also covers the
combined lifecycle with private artifacts. [Authenticated delivery controls](delivery-controls.md)
are qualified through HTTP, CLI, and browser checks. [Corrected-artifact recovery](queue-replacement.md)
qualifies original migration reconciliation and atomic hold transfer. The [Docker queue recovery protocol](queue-recovery.md) qualifies retention checks,
persisted pause, and explicit recovery acknowledgment with private artifacts.
Queued Docker retirement now has [isolation evidence](evidence/m11a-queue-retirement.json)
and [source-preservation/zero-live restore evidence](evidence/m11a-queue-retirement-complete.json).
The [admission foundation](queue-admission.md) now has normal scoped CLI upload,
pending-only backup/restore, exact approval, and derived-name dispatch evidence.
Canonical artifacts now pass duplicate pending-work recovery and direct gateway
browser acceptance, additive update with old/new handler overlap, and retirement
with retained-prefix verification and ordinary replacement approval. The reviewed
[M11b live-session plan](m11b.md) now has a passing minimal native WebSocket
transport probe and [checklist server protocol](../examples/checklist/README.md),
including real-runtime transaction/receipt checks. [Browser reconciliation](evidence/m11b-browser.json)
now covers persistent pending work and lost acknowledgments using an explicit
[Void client patch](patches/void-websocket-send.md). Owner and gateway process-loss
checks pass. Explicit idle eviction also preserves the socket and usable room parameters; it does
not prove attachment reconstruction in a fresh isolate. Non-owning ingress failure passes with a direct-owner control socket.
An explicit [celld patch candidate](patches/celld-preaccept-attachment.md) now passes
preserved-socket updates after idle eviction. Upstream 0.6.2 remains the default and
fails that gate. Route pause/new upgrades also pass on the candidate: existing
sockets keep writing while new connections are refused. The experimental SSE observer passes hints, reconnect snapshots and deployment
cancellation with a version-pinned Void registration patch. Real publication stalls and cross-app SSE isolation also pass in the
[bounded fault drill](evidence/m11b-sse-failure.json). Healthy hibernated-room
[ownership movement](evidence/m11b-move.json) also passes with native reconnects.
[Stopped board/receipt recovery](evidence/m11b-restore.json) and explicit
lower-revision reconciliation also pass. The [M11b acceptance audit](m11b-acceptance.md)
qualifies the bounded local Docker slice, including two-app preapproval refusal.
The [M11c acceptance audit](m11c-acceptance.md) qualifies approved scheduled work
on the frozen local Linux arm64 two-fleet Docker family. Scoped HTTPS upload,
exact approval, dispatch pause, native failures/retries, compatible replacement,
held due/retry/older recovery, and retirement have bounded evidence. The ordinary
public CLI selectors use the same frozen image and recorded source bytes. Default
installations, other topologies, Workflows, and general Durable Object alarms remain
outside this admission. Next, define and implement the
[operator-readiness slice](#immediate-priorities) before another binding milestone. Owner application
[inspection](application-inspection.md) connects recorded release and control state.
The host [gateway request check](application-check.md) reports a requested endpoint's
status and header timing without response contents. The source
[private replica-log capture](application-logs.md) selects one app's fleet for local
Docker-owner files. The [v5 diagnostic check](evidence/operator-native-diagnostics-v5.json)
covers failed and corrected handlers, distinct private configuration, unavailable
replicas, paused routing and controller loss. Application-health assertions and
submitter-facing logs remain open.

## Opportunities to explore later

| Idea | Product outcome to investigate | Admission condition |
| --- | --- | --- |
| Optional Filecoin storage | Additional storage choice or offsite recovery | Upstream direction is sufficiently settled for a separate product/contract review; no integration research now |
| Better generated-app guidance | Coding agents produce deployable apps with useful preflight feedback | Demonstrated friction in supported Void projects; avoid a separate app-generation product |
| Isolated preview environments | Review a proposed app before production activation | A separate policy for executing approved preview code and isolating data, credentials, and effects |
| App catalog or templates | Reuse working applications on owned infrastructure | Repeated deployment demand and a maintenance/upgrade owner |
| Native compute or AI services | Apps use capabilities beyond the initial runtime subset | Concrete need, operating model, and explicit portability boundary |
| Hosting customer extensions | Operators allow outsiders to deploy code | A separate tenant threat model, isolation evidence, quotas, and incident process |

These are brainstorming candidates, not committed scope. Each must advance a
[product goal](vision.md) and have a testable scenario before becoming a milestone.
The [vision review response](reviews/vision-response.md) records accepted feedback,
disagreements, and proposed defaults. Earlier discussion remains in the
[initial review record](reviews/roadmap-response.md).
