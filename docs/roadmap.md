# Proposed roadmap

**Discussion draft.** Build toward the [vision](vision.md): make owned infrastructure
an integrated platform for building, deploying, and running applications, with
freedom to choose where they live. Milestones below advance reusable capabilities.
The FilOz demo-hosting use case is a candidate first pilot, not the north star.
M7a and M7b have entered implementation; later milestones remain proposals.

M7a is qualified locally, including a successful [fresh-agent onboarding test](onboarding.md).
Human usability feedback is optional and does not block progress. See the [fixture guide](../examples/guestbook/README.md)
and [implementation report](report.md). M7b and M7c are locally qualified; M8 is next.

## Current foundation

The local prototype builds selected Void apps, requires approval of an immutable
artifact, routes two apps, and tests a subset of D1/R2/Durable Object behavior and
replica recovery. Native React browser/SDK workflows and a bounded email/password auth flow are qualified. Additional
SDK/framework paths, shared remote operation, broader resource evolution, and
installation backup/restore remain gaps. M7b qualifies R2 additions and one bounded
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
records the current qualification; M7b and M7c are locally qualified; M8 is next. Later
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
private configuration and one native Void auth flow. Next, split M8 into a stopped
installation backup/restore slice followed by shared-operation identity, TLS/access
policy, and quota qualification. Preserve secret revisions, controller metadata,
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
