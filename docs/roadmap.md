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
  in source, including explicit pruning and interrupted-prune resume. Native runtime
  qualification and the quota-fill/reclamation gate remain open.
- **Capacity and serving:** measure latency, throughput, memory, and controller-loss
  behavior across declared app counts and concurrent uploads. Use those results to
  decide app density and routing architecture; caching needs an explicit approval
  and pause contract. The [paired serving probe](serving-measurement.md) now
  exercises local two-fleet reads during uploads, peer activation and controller
  interruption; broader counts and loads remain open.
- **Operator workflow:** make installation, deployment, diagnosis, backup, recovery,
  and upgrade procedures easy to find. Record the current downtime and loss
  boundaries alongside the supported commands. The [standalone developer client](developer-client.md)
  supplies deployment and scoped status outside the checkout without operator images;
  app dependencies and operator approval remain prerequisites.

The contract supplies acceptance conditions for each increment. These are product
priorities, not newly qualified capabilities. Exact-artifact approval and
the existing recovery boundaries remain in force.
Its [next runtime release requirements](operator-readiness.md#next-runtime-release)
separate clean builds, installation on another engine, controller-loss serving and
live application diagnosis. The [serving-authority proposal](serving-authority.md)
selects durable route authority and fresh-read/crash gates for a new runtime.
Host CLI improvements do not close those release gaps.

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
[inspection](application-inspection.md) connects recorded release and control state;
live outcome observation and scoped logs remain open.

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
