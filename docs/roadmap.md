# Proposed roadmap

**Discussion draft.** Build toward the [vision](vision.md): make owned infrastructure
an integrated platform for building, deploying, and running applications, with
freedom to choose where they live. Milestones below advance reusable capabilities.
The FilOz demo-hosting use case is a candidate first pilot, not the north star.
M7a–M7c and M8 are locally qualified; M9 has experimental local Kubernetes evidence.
Later milestones remain proposals.

M7a is qualified locally, including a successful [fresh-agent onboarding test](onboarding.md).
Human usability feedback is optional and does not block progress. See the [fixture guide](../examples/guestbook/README.md)
and [implementation report](report.md). M7b, M7c, M8a, M8b1, and M8b2 are locally qualified; M9a and M9b have experimental local Kubernetes evidence; M10a capacity reporting and M10b Docker retirement are qualified; M10c qualifies fresh three-fleet Docker installations, stopped expansion/recovery/retirement, and paired resource observations. M11 background and collaborative applications is next.

## Current foundation

The local prototype builds selected Void apps, requires approval of an immutable
artifact, routes up to three apps on qualified Docker layouts, and tests a subset of D1/R2/Durable Object behavior and
replica recovery. Native React browser/SDK workflows and a bounded email/password auth flow are qualified. Additional
SDK/framework paths, shared remote operation, broader resource evolution, and
shared-operation recovery policy remain gaps. M8a qualifies stopped local backup/restore. M7b qualifies R2 additions and one bounded
logical transfer profile. See [report.md](report.md) for exact evidence.
Do not infer product support from the runtimes' feature lists.

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
records the current qualification; M7b, M7c, M8a, M8b1, and M8b2 are locally qualified; M9a and M9b have experimental local Kubernetes evidence; M10a capacity reporting and M10b Docker retirement are qualified; M10c qualifies fresh three-fleet Docker installations, stopped expansion/recovery/retirement, and paired resource observations. M11 background and collaborative applications is next. Later
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
Next: the [M11c scheduled-work contract](m11c.md), informed by
[source discovery](m11c-discovery.md) and the [native timer probe](cron-qualification.md).
Native timer, retry-owner-loss and isolated watchdog probes pass their recorded
profiles. The experimental [native hold](patches/celld-cron-controls.md) also has
bootstrap/adoption and replica-restart evidence. An experimental controller
transport checks approved replica/cell generations before resume and preserves
uncertain mutation outcomes. Platform admission remains closed
while the [experimental activation journal](cron-activation.md) is qualified through
controller interruption and native bootstrap drills. Approval pins its artifact and
secret revision before effects. The [Void refresh fixture](../examples/refresh/README.md)
has bounded native workerd, sibling-retry and lost-reply evidence plus offline
target builds. [Operator dispatch controls](cron-controls.md) provide recorded
status and explicit observe, pause and artifact-pinned resume. Selected
[controller SIGKILL cuts](cron-activation.md#native-process-interruptions) also pass
their bounded native profile. The ordinary Void [failure profile](cron-failures.md) records `noRetry`, counted
terminal retries, owner takeover and autonomous overdue work after downtime.
The bounded [replacement profile](cron-replacement.md) covers old work through
compatible migration, lost completion near publication, unfinished application
status and new-code native retries. The [stopped cron recovery profile](cron-recovery.md)
qualifies same-version local Linux arm64 Docker with two application fleets, due
timers, pending retries and an older snapshot. The full rerun verifies queued
survivor input, source/target approval pins and final source-volume preservation
with the same executable sources as the retirement profile. The
[bounded retirement profile](retirement.md#experimental-scheduled-app-retirement)
covers cron/queue survivors, isolated replacement capacity and zero-live restore.
A [two-cron retirement/source-restore profile](retirement.md#retirement-beside-another-scheduled-app)
also covers the held survivor and both source schedules. Normal scoped cron
admission and release-bound runtime qualification remain open. The
[early identity primitive](patches/celld-runtime-identity.md) has bounded native
metadata evidence. The [caller policy](cron-runtime-policy.md) now has native
app-free refusal/bootstrap evidence. The
[signed binding foundation](patches/celld-runtime-binding.md) adds storage-origin
and region claims, fresh lease-key possession proofs and separate bootstrap/live
command checks, with app-free evidence on a fat-LTO release build. General runtime
lifecycle fencing, shipped-runtime selection and the remaining scheduled lifecycle
qualification on this binary remain open.
The [host preboot foundation](cron-runtime-preboot.md) now validates an independent
runtime/storage launch policy before experimental restore creates application
containers. Its app-free native profile checks image/program identity and
read-only startup. Normal CLI cron restore and retirement refuse all scheduled
history. The [sealed scheduled recovery profile](cron-sealed-recovery.md) qualifies
due/retry/older snapshots and a queued survivor on this release binary and layout.
A qualified-runtime registry, the remaining release-runtime lifecycle and ordinary
admission remain open; historical receipts retain their pinned-source scope.
The [guarded release activation profile](cron-sealed-activation.md) qualifies
selected publication/resume/durable-release controller kills and paused-update
recovery on that binary. Remaining lifecycle gates, runtime selection and normal
scoped cron admission remain open.

The [M11a acceptance audit](m11a-acceptance.md)
closes bounded Docker queues as supported opt-in; default admission stays off by
policy. Scheduled/workflow lifecycle remains open M11 work. The native Void imports fixture
qualifies D1 bootstrap ordering, additive migration overlap, and reconciliation after
killed consumers exhaust delivery. The qualified queue contract permits compatible
handler overlap, not draining. Live collaboration remains a separate slice.
Preserve secret revisions, controller metadata,
bucket state, and every replica identity/log together. M9 retains the second
deployment environment.

Fresh-agent onboarding measures whether the written workflow can be executed
without author assistance. It does not establish human usability. Human feedback
can improve the product later and is not a milestone dependency.

HTTP route pauses do not drain in-flight requests or existing Durable Object alarms.
M7 uses a documented compatible migration contract; incompatible migrations and
background activation require a stronger lifecycle protocol. Code rollback is safe
only against a compatible resource/schema contract. Recovery work in M8 must account for controller metadata, bucket data, every
replica log/identity, and the gateway configuration needed to reconstruct routing.
Document what is backed up versus reproducibly generated, and cover all writers.

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
