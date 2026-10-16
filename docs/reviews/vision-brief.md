# Vision and roadmap review brief

Status: discussion only. Review the product vision and proposed roadmap; do not
implement, deploy, publish, edit files, or invoke other reviewers. No external API
calls, credential access, or private infrastructure inspection. Filecoin research
is explicitly out of scope. Inspect local fogd code/docs only when needed.

## User direction, authoritative for this round

The user corrected a previous synthesis that made their FilOz demo-hosting use
case the product north star. FilOz is a possible first pilot, not the product's
purpose. The user also rejected "Workers programming model" as sufficient vision
because it omits Void's full-stack SDK and developer-experience benefits.

The user said this is the closest vision to something exciting:
"Make infrastructure you control a complete platform for building, deploying, and
running applications—with an integrated developer experience and the freedom to
choose where they live."

The accompanying explanation: Void provides the developer experience to preserve;
Workers compatibility provides a portability contract; celld/workerd provide runtime
capabilities; fogd makes the whole system operable on owned infrastructure. Full
support across the layers is a direction, not a claim about v0.

Keep this as the anchor. Challenge whether promises and roadmap serve it; do not
replace it with "team demos" or a personal app simply because either is a pilot.

The user wants vision/goals -> clear roadmap -> peer review/brainstorming -> later
implementation. No next large implementation yet. They want an intentional north
star and explicit scope, not a feature wishlist or a roadmap made only of bindings.

They named eventual Filecoin storage/offsite redundancy, encryption, ACLs, then
explicitly said that work is heavily in flight and to stop diving into it. Keep
it a deferred opportunity; do not investigate it or design an adapter.

## Feedback requested

1. Does the vision distinguish fogd from a container host without turning named
   dependencies into the purpose? Does it preserve enough of Void's actual benefits?
2. Are G1–G5 concrete enough to reject unrelated work? Suggest a small decision
   filter and measurable product signals without invented performance targets.
3. Stress-test M7–M12 order, size, dependencies, and exit criteria. Recommend the
   smallest coherent next implementation spec, but do not implement it. Flag any
   claim the current runtime split/build output prevents us from honestly making.
4. Separate broadly useful platform capability from pilot-specific policy. Do
   admin approval, personal installations, portability, and future extensions fit
   coherently? Which promises are in tension?
5. Brainstorm at most three opportunities that strengthen the vision, state why,
   and label what should be deferred. Critique the existing opportunity list.
6. Identify contradictions, premature architecture decisions, hidden operating
   costs, and overclaims. Offer a clear recommendation and 2–3 unresolved decisions.

Use roughly 900–1400 words. Ground material claims in local sources. Return your
own review. Preserve the existing no-Cloudflare-credentials/API and no-npm-publish
constraints. Do not claim a local emulator proves managed-service equivalence.

## Prior discussion and triage

Earlier Claude favored portable app incubation; Gemini favored internal app hosting.
Both favored proving a complete useful app before broad bindings. Some raw reviews
claimed zero marginal cost, easy rollback, or sufficient pause-only backups; these
were corrected in the appended triage. The user rejected the invented benchmark
or integration dashboard. There is still no selected real demo or UI framework.

## Review snapshot

The following full documents are frozen inputs for this review. Later revisions
will be recorded in a separate response. Original briefs and review outputs remain
in docs/reviews/ for reference, not authority over the user corrections above.


---

Snapshot: docs/vision.md

# Vision and product goals

**North star:** Make infrastructure you control a complete platform for building,
deploying, and running applications—with an integrated developer experience and
the freedom to choose where they live.

This vision anchors planning. The goals and sequence below are proposals, not a
claim that fogd v0 implements them. Current evidence lives in [features.md](features.md)
and [report.md](report.md); [roadmap.md](roadmap.md) connects goals to milestones.

## What the experience should feel like

A developer creates a complete application, runs it locally, and declares the data
and capabilities it needs. They deploy to a fogd installation, receive a usable URL,
and keep updating the app without separately managing its runtime and storage.
Operators decide who can deploy, what capacity applications receive, and how the
installation is maintained and recovered. An individual can fill both roles.

The app should remain useful after the developer closes their laptop. Its data
should survive the documented failures and be recoverable after loss. Moving to
another installation or a supported managed target should have an explicit,
tested path for code and data. Each target retains its own operational properties.

## What each layer contributes

| Layer | Contribution to the vision | Boundary |
| --- | --- | --- |
| Void SDK | Full-stack composition: server routes, rendered pages, typed resource APIs, and types carried into the UI | A successful backend build alone does not qualify the SDK experience |
| Void CLI and Platform experience | Integrated builds, resource provisioning, migrations, deployments, and administration | fogd provides the owned-infrastructure path; existing Cloudflare provisioning is not reused |
| Workers application contract | A recognizable runtime and resource model, including Durable Objects, with compatibility targets | Compatibility needs method, lifecycle, and failure evidence, not just accepted configuration |
| celld and workerd | Runtime capabilities and self-hosted execution building blocks | Their combined feature inventories do not establish fogd support |
| fogd | Installation, resource lifecycle, deploy policy, routing, diagnosis, recovery, and a coherent developer/operator workflow | fogd integrates upstream capabilities rather than reimplementing every service |

Void's features are optional and composable. Preserve the SDK experience without
requiring every application to use every abstraction. Void is the first supported
development path; accepting other Workers projects is a later compatibility goal.
Source: [Void README at the audited revision](https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/README.md).

## Product promises and evidence

| ID | Proposed promise | Evidence that would support it |
| --- | --- | --- |
| G1 | Build a complete app through an integrated developer experience | A supported Void template carries a typed UI/API/data change through local development, build, deployment, and update; needed assets and app authentication work |
| G2 | Operate the application on infrastructure you control | A documented installation supplies resources and stable routing; a second person follows installation/upgrade/recovery procedures without undocumented author intervention |
| G3 | Keep control as applications and collaborators grow | Distinct submit/approve rights, declared resource changes, scoped credentials, useful diagnosis, and enforced capacity policy pass scenario tests |
| G4 | Retain freedom to move code and data | A supported app builds for the declared targets, exports and restores its state, and receives explicit compatibility findings; hosted behavior stays unverified without hosted tests |
| G5 | Expand capabilities without making the default installation depend on them | An optional integration has its own contract and evidence; baseline installation and existing app behavior remain testable independently |

Track developer and operator effort separately: initial setup, per-app manual work,
updates, failure diagnosis, and recovery. Record assistance and failures rather than
inventing a speed or cost advantage. Compatibility evidence and recovery drills
matter alongside convenience. A shorter deploy command alone does not satisfy G1–G4.

## Use cases that can test the vision

FilOz's team demo-hosting need is a candidate first pilot: colleagues already build
apps and want an easy persistent destination on their infrastructure. It can test
G1–G3. A homelab can test installation and recovery with limited resources; an
independent product can test the option to move to managed hosting; a learning
environment can expose the runtime and state model. These uses inform priorities
without narrowing fogd to demos, one organization, or one deployment topology.

Future Filecoin storage is an optional possibility under G5. Upstream storage,
encryption, and access-control work is still evolving. Keep it in the opportunity
list without designing an integration or making it a near-term dependency.

## Boundaries and tradeoffs

"Your own application cloud" is the ambition. Matching Cloudflare's global network,
attack-absorption capacity, every service, or managed operations is outside the
software promise. Compatibility should grow through explicit profiles. Operators
still provide capacity and maintain the system; self-hosting is not cost-free.

Coolify is a valid alternative for container applications and database deployment.
fogd's proposed distinction is integrating Void's application experience with
declarative resources and a tested portability contract. If it only wraps container
launches, that distinction has not been demonstrated.
Sources: [Coolify applications](https://coolify.io/docs/applications/),
[databases](https://coolify.io/docs/databases/).

Public hosting of arbitrary untrusted code, a general container orchestrator, and
automatic multi-region operation are separate investments. Retain trusted,
reviewed code as the initial hosting boundary. No Cloudflare credentials/API calls,
npm publication, or changes to private infrastructure are part of this planning work.

## How to keep the roadmap intentional

Every proposed milestone names the promise it advances, a product scenario, an
acceptance condition, and work it deliberately excludes. Prioritize gaps that
block complete apps or safe operation before adding unused binding names. Keep
platform capability separate from the pilot used to test it.

A new idea belongs in exploration until it has a user outcome, an operating cost,
a compatibility boundary, and evidence that would justify implementation. Revisit
the sequence when a pilot disproves an assumption. Change the vision explicitly
if needed; do not change it accidentally by accumulating pilot requirements.


---

Snapshot: docs/roadmap.md

# Proposed roadmap

**Discussion draft.** Build toward the [vision](vision.md): make owned infrastructure
an integrated platform for building, deploying, and running applications, with
freedom to choose where they live. Milestones below advance reusable capabilities.
The FilOz demo-hosting use case is a candidate first pilot, not the north star.
This planning work does not start the next large implementation.

## Current foundation

The local prototype builds selected Void apps, requires approval of an immutable
artifact, routes two apps, and tests a subset of D1/R2/Durable Object behavior and
replica recovery. Complete browser/SDK workflows, shared remote operation, resource
evolution, and backup/restore remain gaps. See [report.md](report.md) for exact evidence.
Do not infer product support from the runtimes' feature lists.

## Milestones and acceptance gates

| Milestone | Capability and goal | Exit evidence | Outside this milestone |
| --- | --- | --- | --- |
| M7. Complete app lifecycle locally | Preserve Void's developer experience through fogd (G1, G3) | Supported starter with rendered UI/assets, typed API/data access, persistent records/files, chosen app-auth flow, and an update with backward-compatible migration; second developer can submit, observe status, obtain approval, and diagnose a failed release | Kubernetes installation, new background bindings, generalized framework support |
| M8. Recoverable installation | Operators can keep and recover applications (G2, G3) | Document required state and identities; establish consistent backup; restore onto fresh storage; test upgrade/interruption; record recovery time and loss boundary; scope secrets, TLS/access policy, and quotas for shared operation | Global HA, live geo-replication, arbitrary untrusted tenants |
| M9. A second deployment environment | The same application workflow works outside local Docker (G2, G3) | Operator follows installation and recovery procedures; actual host/storage/network failure tests validate the declared topology; app authors need no cluster credentials | A Kubernetes operator, automatic multi-region placement, organization-specific features in core |
| M10. Application growth | Existing apps can gain capabilities and be retired safely (G1, G3) | Resource addition preserves identities and data; export/retention/deletion are explicit; slot reuse cannot inherit data or authority; capacity refusal is observable; one real app completes a capability addition | Automatic scaling without measured limits, destructive schema rollback |
| M11. Background and collaborative applications | Supported app types expand with tested semantics (G1, G3) | Separate slices qualify queue/scheduled/workflow activation, retries, draining, and idempotency; another qualifies live sessions, reconnect, and reconciliation through updates/failure | Enabling every upstream binding together; claiming sockets survive process loss |
| M12. Broader portability | Supported apps move between targets (G4) | Repeatable preflight, documented code/config differences, logical export/import, offline managed-target builds, and non-Void Workers import where qualified | Emulation of every Cloudflare control-plane API; claiming hosted tests were run |

Milestone numbers continue the six completed prototype milestones. M7 is the next
proposed implementation slice; later milestones are capability groups to split
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

Before the next implementation, inventory a candidate app's dependencies and draft
the M7 contract against a representative supported fixture. App selection can refine
requirements; lack of an immediately supplied demo need not block documenting the
reusable contract. Do not invent a dashboard or force each app to use every binding.

Kubernetes is a candidate M9 target for the FilOz pilot; a two-host homelab remains
another. Select one second environment first based on operator access and readiness.
Private installation details stay in the operator's repository. Prefer ordinary
platform resources before designing a custom scheduler or Kubernetes operator.

## What the next spec needs to resolve

Define one supported Void UI/framework path, app authentication versus platform
identity, the intended deploy-status/log workflow, and the migration compatibility
rule. Bound setup/update effort through an observed baseline and record assistance.
Specify which tests run locally and which later require another installation.

HTTP route pauses do not drain in-flight requests or existing Durable Object alarms.
M7 uses a documented compatible migration contract; incompatible migrations and
background activation require a stronger lifecycle protocol. Code rollback is safe
only against a compatible resource/schema contract. Recovery work in M8 must cover
all writers and the state the runtime actually requires.

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
The [review record](reviews/roadmap-response.md) preserves disagreements and changes.


---

Snapshot: docs/product.md

# Product scenarios

**Discussion draft.** These scenarios test fogd's [vision](vision.md): make
infrastructure you control a complete platform for building, deploying, and running
applications, with an integrated developer experience and freedom to choose where
they live. Void's full-stack developer experience is part of the goal; runtime API
compatibility alone is insufficient.

FilOz team demos are a candidate first pilot. The user reports that developers
have demos without an easy persistent deployment home and that the team has
considered Coolify. This is evidence for a use case, not a definition of fogd's
purpose or audience. Homelab applications, independent products, and learning
remain useful validation contexts. No existing demo has been selected yet.
See [roadmap.md](roadmap.md) for proposed capability milestones.

Durable Objects add persistent state and coordination within the Workers runtime.
They expand the kinds of apps that fit the model without providing general Linux
processes. Void adds full-stack composition and typed resource APIs above that
runtime contract. Future integrations can extend the platform, with explicit
portability boundaries. Sources: [Void at the audited revision](https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/README.md),
[Durable Objects concepts](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/).

## People and responsibilities

| Person | Job they want to accomplish | What fogd should let them decide |
| --- | --- | --- |
| App developer | Build, diagnose, and update an application without becoming the cluster operator | Which code and declared resources to propose; inspect their own deployment status and logs |
| Deployment approver | Decide whether a specific change may run | Review code identity, resource changes, migrations, and impact; approve or reject without giving away infrastructure credentials |
| Operator | Keep applications available and recoverable within owned capacity | Provision hosts/storage, manage access, observe failures, back up/restore, and retire apps safely |
| App user | Use the application and trust that acknowledged work is retained | Sign in to the app when required, save work, reconnect, and understand temporary failures |

One person may fill several roles. Deployment permission is separate from an app
user's login. Trusted developers can build apps for public users; trusting the code
author does not remove the need for TLS, app authorization, request limits, or
credential protection. Hosting arbitrary strangers' code is a separate product.

## Candidate scenarios and acceptance conditions

The app names below illustrate workflows; they are not claimed user requirements.
Each scenario has a stable ID so a roadmap item and its tests can point to the same
user outcome. Current evidence is recorded in [report.md](report.md), not inferred
from a runtime accepting a configuration key.

### U0: A developer learns the model and keeps an exit path

A developer builds a small app locally, learns how records, files, durable state,
and background work fit together, and can explain what would need to move to a
managed provider. A working app and a migration rehearsal are more useful than
a growing list of accepted configuration keys.

Acceptance: follow a guided scenario; inspect behavior under an injected failure;
export and restore application-owned data in a documented logical format; generate
an offline Cloudflare-target build/configuration without changing supported app
logic. Identify unsupported assumptions and label hosted execution unverified.
The current prohibition on Cloudflare credentials/API calls remains in force.

Today: sample apps and local failure checks provide a starting point. A guided
curriculum, logical data migration, and managed-target handoff are not implemented.

### U1: A teammate launches a useful team application

A teammate has built a demo and wants it to remain usable after closing their
laptop. They deploy from a supported template, an approver reviews the change, and
colleagues receive a stable URL. Later updates retain saved records and attachments.
The author does not provision a database, write Kubernetes manifests, or obtain
cluster credentials. Start with an existing team demo rather than inventing a
dashboard to exercise the bindings.

Acceptance: a teammate starts from a supported template; preflight names unsupported
capabilities before upload; the exact proposed artifact is reviewed; no pending or
rejected artifact executes; approved pages, assets, login/session flows, records,
and attachments work from another machine. The app's authentication provider and
credential policy must be chosen before declaring this scenario supported.

Today: the API/D1/R2/DO path works in samples. A complete browser/login application,
remote access, asset behavior, and independent teammate onboarding remain unqualified.

### U2: An approver can understand and control a release

A developer fixes a bug and submits a change without being able to activate it.
The approver sees what changes, who submitted it, what resources it needs, whether
SQL runs, and the expected interruption. A rejected proposal remains inspectable.

Acceptance: two distinct identities demonstrate submit versus approve permissions;
revoking one developer does not revoke everyone; the developer can observe the final
result without administrator credentials; the audit record ties actor, artifact,
decision, and outcome together. A concurrent or stale approval cannot silently
replace a newer release. Credentials never appear in downloadable artifacts/logs.

Today: a shared team token and admin Basic auth enforce an initial separation;
per-person identity, scoped status access, and a durable actor audit are future work.

### U3: An existing application gains a new capability

The team adds attachments to an existing records app, or adds a settings store.
The developer should not need to create a new app and abandon the old data.

Acceptance: the proposal distinguishes adding, retaining, renaming, and deleting
resources; existing identities/data remain stable; approved additions initialize
safely; destructive changes require an explicit separate operation. A failed
activation leaves a diagnosable, recoverable resource/deployment state. Test the
transition from an app without storage to one with storage, retaining old records.

Today: resource declarations are frozen. This is a product blocker for normal app
iteration, independent of the number of bindings implemented by celld.

### U4: A failed update can be diagnosed and recovered

A developer ships broken SQL or code. Users receive a clear failure rather than
silently inconsistent behavior; the operator identifies the failed stage and
restores useful service without guessing which release or schema is active.

Acceptance: status/logs identify the request, stage, and active release; retrying
cannot forget applied SQL or replay ambiguous writes; code rollback is permitted
only when its resource/schema contract is compatible. Schema rollback is a separate,
explicit data operation. Inject a process crash at each externally visible stage.

Today: SQL failure, explicit retry/correction, version adoption, and interrupted
activation have coverage. Rollback tooling and incident-oriented diagnostics do not.

### U5: An operator deploys on team Kubernetes or a homelab

The operator deploys the same approved applications on an existing team Kubernetes
cluster or a two-node homelab. A teammate uses one stable endpoint without knowing
host placement. The application contract should stay the same while the operator's
installation and storage/network integration differ.

Acceptance: document placement, private connectivity, TLS, DNS, capacity, and storage
failure domains; reboot one host under acknowledged writes; reconnect clients;
verify recorded data and deployment identity after rejoin. Explicitly test controller
and bucket outage behavior. Two worker hosts alone are not a whole-stack HA claim.

Today: Docker container failures on one machine are tested. Kubernetes deployment,
two-host topology, and host/network failure are not. Availability targets need user agreement before
choosing bucket placement or an ingress/controller redundancy design.

### U6: The operator restores after data or host loss

A host disk fails or the installation is lost. The operator restores the application,
its data, and approval history using a documented backup, rather than just restarting
a process whose disk survived.

Acceptance: create a coordinated recovery point, restore to isolated fresh storage,
verify D1/R2/DO data plus app/resource/replica identities and migration history, and
measure recovery time and loss relative to the stated recovery point. Refuse a
mismatched or incomplete restore. Keep an independent copy outside the failed host.
First establish a tested stopped/quiesced backup procedure; do not assume copying
live volumes or only the bucket produces a consistent recovery point.

Today: replica restart/rejoin is tested; destruction and replacement of disks are
not. Stable replica identities and witness logs make this distinction material.

### U7: A user uploads something that takes time to process

A user uploads documents, receives confirmation, leaves the page, and later sees
completed imports or a useful failure message. An operator can inspect and retry
failed work without creating duplicate business records.

Acceptance: jobs survive worker failure; duplicates are handled by application-level
idempotency; retries and terminal failures are observable; approved consumers cannot
start before their required schema/resources exist. During upgrades, define which
release may receive queued work and how in-flight work drains. Disabling HTTP routing
alone is not a background-event deployment gate.

Today: the adapter rejects Queues and Workflows. Supporting this scenario requires
lifecycle and recovery work as well as binding/configuration translation.

### U8: Colleagues collaborate on live application state

Two users edit a shared board or watch progress without repeatedly refreshing.
A server restart should cause a recoverable reconnect, not unexplained lost edits.

Acceptance: define an acknowledged operation, preserve it across the supported
failure model, reconnect/resubscribe after a replica restart, and reconcile missed
updates without duplicates. Test WebSockets/SSE, close codes, idle behavior, and
routing across deployment. Do not promise that open sockets survive process loss.

Today: the Durable Object sample tests stored operations, not browser sessions,
streaming behavior, or reconnect handling.

### U9: An operator hosts more apps and retires one safely

A team adds a third project, observes capacity, then retires an old application
without giving its data to the next app that uses that capacity.

Acceptance: capacity refusal names the limit; adding capacity is documented;
credentials and resources are scoped to the intended app; retention/export/deletion
are explicit; slot reuse cannot inherit another app's data or authority. An approved
resource-intensive app cannot silently exhaust unrelated app capacity.

Today: two permanent slots and coarse limits exist. Automated placement, safe slot
reclamation, scoped storage credentials, and lifetime artifact quotas do not.

### U10: A developer brings an existing Workers application

A developer checks whether an existing application can run locally before committing
to a migration. Compatible code should retain its meaning; unsupported features
should produce a concrete explanation and migration path.

Acceptance: a preflight report maps every requested capability to tested support,
known semantic differences, or a rejection. Import is repeatable and covers code,
config, data boundaries, and release behavior. A local test suite reproduces the
promised profile; differences are versioned rather than silently adapted away.
Cloudflare credentials, provisioning API emulation, and live Cloudflare calls are
not required. Actual data export from an existing hosted account is outside the
current authorization and needs a separately supplied offline export.

Today: selected Void outputs work; arbitrary Wrangler/Workers projects are not a
supported product entrypoint. This scenario broadens the audience beyond Void.

### U11: An operator chooses additional storage destinations

An operator may want application files or offsite recovery stored independently of
the compute hosts. Filecoin is a future candidate, including encrypted storage and
access controls. Its related upstream work is in flight. This scenario reserves
the product goal without choosing APIs, providers, storage semantics, or delivery dates.

Future validation: demonstrate the specific promised operation and recovery outcome
against an agreed storage contract. File storage, backup, and live replication are
different promises. Keep the default local stack independent of optional services.

Today: no Filecoin integration exists. Detailed investigation and implementation
are deferred; this possibility is not a dependency of the near-term roadmap.

## Pilot and open product choices

Use pilots to validate the platform's promises. A team demo can test developer
onboarding and approval; a homelab installation can test operator portability; an
independent app can test code/data export. None alone defines fogd's north star.

For the candidate FilOz pilot, qualify an existing demo and identify its dependencies.
A general container app may fit Coolify better; measure any adaptation cost rather
than assuming generated code fits Void. Preserve administrator-controlled deployment.
Measure setup, update, diagnosis, and operator intervention. An approval is a policy
decision; manually provisioning each app is work fogd should remove.

Before a shared deployment, the implementation spec needs values for availability
and recovery targets, access visibility, capacity, and approval roles. Keep these
installation choices separate from the reusable platform contract. No application
or infrastructure deployment is part of this documentation effort.


---

Snapshot: docs/compatibility-policy.md

# Compatibility goals and evidence

**Discussion draft.** Aim for portable application behavior on owned infrastructure,
with explicit differences and tested lifecycle guarantees. “Full Cloudflare
compatibility” needs a bounded definition before it can guide engineering work.
The proposed target is the Workers application platform used by selected scenarios,
not every Cloudflare networking, security, media, or commercial product.

## Separate the promises

| Dimension | Proposed question to answer | Evidence needed |
| --- | --- | --- |
| Source and configuration | Can this project build and declare its resources without rewriting application logic? | Pinned fixture apps; config import/preflight tests; explicit rejected keys |
| API behavior | Do calls produce the promised results, errors, metadata, and streaming behavior? | Contract tests linked to official documentation and upstream source |
| Lifecycle and failure | Does acknowledged state survive the stated failure model, and what happens on deploy/retry/reconnect? | Fault injection, deployment/event admission tests, recovery drills |
| Developer workflow | Can a developer inspect, submit, debug, and migrate an app without operating infrastructure? | Scenario tests through the supported CLI and UI |
| Control plane | Which deploy/routing/identity/resource operations does fogd provide? | Tests of fogd's own contracts; do not imply Cloudflare REST API compatibility |
| Operations | What availability, capacity, backup, and recovery properties are actually demonstrated? | Measured drills on the declared topology and documented limits |

Passing configuration validation proves only the first step. A method with the same
name is insufficient if retry, ordering, persistence, isolation, or error behavior
changes the application's meaning. Keep a per-capability status for each dimension;
do not turn a percentage of recognized binding names into a compatibility score.

## Proposed application profiles

Profiles group useful application scenarios. A release can support one profile
while retaining gaps in another; the profile names are proposed, not current claims.

| Profile | User outcome | Principal scenarios | Boundary |
| --- | --- | --- | --- |
| Web application | Pages, assets, sessions, records, attachments, ordinary updates | U1–U4 | Qualify current D1/R2/DO path and app-auth choices first |
| Recoverable team hosting | Approvals, scoped access, incident diagnosis, verified restore, owned hosts | U2, U4–U6, U9 | Required before describing the stack as dependable hosting |
| Background application | Imports, scheduled tasks, durable long-running work | U7 | Event activation, retries, drains, and idempotency are release gates |
| Collaborative application | Live sessions and reconnectable shared state | U8 | Socket continuity is distinct from durable state preservation |
| Portable Workers application | Bring supported non-Void Workers projects and compose applications | U10 | Explicit loader/config adapter and service/RPC semantics required |

The upstream audit in [compat.md](compat.md) remains the inventory. The current
support table in [features.md](features.md) remains the product truth. Profiles and
the roadmap must never upgrade either table until implementation evidence exists.

## Routes to broader compatibility

| Work class | Examples to investigate | What completion means |
| --- | --- | --- |
| fogd adapter and lifecycle work | KV; admission of Queues/cron/Workflows; additive resources; project import | Native upstream behavior passes contract plus scenario tests through fogd |
| Upstream gaps or fixes | R2 multipart recovery; specific Node/RPC/session differences | A minimal reproduction, explicit limitation, and an upstream fix or clearly tracked patch |
| Additional self-hosted services | AI inference, connection pooling, analytics, mail delivery | Service operation plus a documented compatibility contract; no silent hosted fallback |
| Platform behavior we own | Approval, identity, previews, placement, audit, resource lifecycle | Useful fogd workflow; matching Cloudflare provisioning endpoints is a separate decision |
| Properties outside the hardware promise | Global edge footprint, provider-managed capacity and identical hosted quotas | Document the difference; do not label a two-host alternative equivalent |

These are investigation classes, not estimates that the work is easy. An AI client
shape does not reproduce model identifiers, model behavior, streaming, or provider
quotas. A database proxy does not establish Hyperdrive semantics. Dynamic worker
loading does not establish the Workers-for-Platforms namespace contract.

## Evidence without Cloudflare calls

Use official published contracts, pinned upstream source/tests, offline fixtures,
and fogd integration/failure tests. workerd or Miniflare may provide useful local
comparators, but only for behavior they actually implement; neither is automatically
an oracle for hosted D1, Queues, R2, or distributed failure semantics. Mark behavior
that cannot be verified offline as documented or unverified, not hosted-tested.

For example, Cloudflare Queues documents at-least-once delivery. A fogd scenario
must tolerate duplicate delivery and test its idempotency contract; it should not
invent an exactly-once guarantee. Workflows also has explicit retry/sleep behavior
that belongs in contract tests. Sources: [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
[Workflows retries and sleeps](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/).

Each capability needs a record containing the target version/date, supported
methods/options, semantic differences, failure expectations, isolation boundary,
contract/scenario test links, and unresolved upstream issues. Run the relevant
suite before runtime upgrades and keep upgrade results with the pinned revisions.
Cloudflare's [binding catalog](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
provides inventory input, not a promise that each item belongs in the first release.

## Admission rule

A new capability becomes supported only after the product scenario, resource/secret
ownership, activation behavior, failure/retry semantics, resource limits, and test
evidence are defined. Preflight should reject unsupported behavior before deployment
and distinguish an upstream gap from a fogd adapter restriction.

Background execution deserves a separate activation design before any parser
allowlist change. Preview environments must also isolate state, credentials, and
external effects, not only use another hostname. Neither mechanism is implemented
by merely pausing workerd's HTTP route.


---

Snapshot: docs/reviews/roadmap-response.md

# Product roadmap review response

**Discussion draft.** Claude and Gemini completed an initial roadmap review and a
product-direction follow-up. Both recommended proving a useful application before
expanding bindings. Their audience rankings differed. Later user input identifies
a concrete team need: developers have demos without an easy persistent deployment
home. That supports a team pilot, subject to application and operational validation.

## Review record

- Initial [brief](roadmap-brief.md), [Claude review](roadmap-claude.md), and
  [Gemini review](roadmap-gemini.md).
- Follow-up [brief](product-direction-brief.md), [Claude review](product-direction-claude.md),
  and [Gemini review](product-direction-gemini.md).

The reviews ran through the external CLIs with streaming output and a 15-minute
deadline; both produced completed responses in both rounds. They did not review the
subsequent team-demo clarification, the private infra repository, or the proposed
Filecoin storage track. Their original output is preserved as review evidence,
including claims corrected below.

## Accepted recommendations

Choose a product scenario before adding bindings. Distinguish app authors,
approvers, and operators. Keep existing approval control while validating a second
developer's workflow. Qualify full browser/asset/auth behavior rather than inferring
it from API smoke tests. Prove backup/restore before placing valuable data here.

Separate source/API behavior, lifecycle/failure behavior, data migration, and
operations. Offline workerd/Miniflare tests cannot establish hosted service
equivalence. Backward-compatible migrations remain necessary while HTTP pause
does not quiesce in-flight requests and Durable Object alarms.

## Corrections and deferred recommendations

| Finding | Disposition |
| --- | --- |
| Team demand is unvalidated | The user subsequently identified a persistent demo-hosting need; actual app fit and adoption still need a pilot |
| Build an integration/benchmark dashboard | Rejected by the user as unenticing; qualify an existing team demo instead |
| Self-hosting has zero marginal cost or no limits | Not adopted; hardware, capacity, electricity, operations, and recovery have costs |
| Kubernetes always requires many per-app backend products | Overstated; compare actual team workflows and Coolify rather than assuming a baseline |
| Rollback is a small controller change | Artifact retention does not establish schema/resource compatibility; design and test the contract |
| Pause HTTP and copy storage for backup | Insufficient; drain/quiesce or a supported checkpoint protocol must cover every writer and required state component |
| Delay event safety until adding new background bindings | Existing Durable Object alarms and in-flight requests already matter |
| Add a generic export command during discovery | Start with a fixture-specific logical export/restore where useful; a generic format needs a separate design |
| Add KV, multi-D1, route caching, slot reuse, and backup together | Too broad for one pilot; each needs an application or operations requirement and its own validation |
| Deploy manifests establish multi-host reliability | Placement, identity, persistent storage, network failures, and recovery need actual drills |
| Prior direct-deploy helper remains a supported workflow | The current default is approval; the separate low-level Compose topology is an operator diagnostic path |

## Proposed direction after user discussion

The first candidate is a team application platform on owned infrastructure, with
the homelab as another installation target. Workers compatibility provides a useful
application contract; migration to Cloudflare need not be the primary purpose.
Coolify is a valid alternative whose broader container support may fit some demos
better. The pilot should test whether a supported Void template and declared
resources remove enough author work to justify operating fogd.

Optional Filecoin application storage and encrypted offsite recovery extend the
ownership goal. They are later design work. The user requested this direction;
neither reviewer has evaluated its storage semantics or encryption/ACL design.

See [product scenarios](../product.md), [roadmap](../roadmap.md), and
[compatibility policy](../compatibility-policy.md). No runtime changes are included
in this planning work.

## Correction after the audience and vision discussion

The earlier synthesis incorrectly promoted a candidate team pilot into fogd's
north star. The user corrected that framing. The subsequent phrase "Workers
programming model" also omitted the full-stack developer experience provided by
Void. The updated [vision](../vision.md) states the broader goal and distinguishes
Void's developer experience, runtime capabilities, portability, and fogd operations.
FilOz is a potential first use case. Filecoin stays a future possibility without
integration design. The next review evaluates the revised vision and capability
roadmap; it does not re-rank audiences as a substitute for product purpose.
