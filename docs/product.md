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

Today: sample apps and local failure checks provide a starting point. M7b covers
a bounded logical message/attachment transfer. A guided curriculum, general data
migration, and managed-target handoff remain open.

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

Today: the guestbook covers browser forms, assets, D1/R2/DO and updates; the
accounts fixture covers a bounded native password flow. An actual team pilot,
remote access and independent teammate onboarding remain unqualified. See the
[implemented capability report](report.md).

### U2: An approver can understand and control a release

A developer fixes a bug and submits a change without being able to activate it.
The approver sees what changes, who submitted it, what resources it needs, whether
SQL runs, and the expected interruption. A rejected proposal remains inspectable.

Acceptance: two distinct identities demonstrate submit versus approve permissions;
revoking one developer does not revoke everyone; the developer can observe the final
result without administrator credentials; the audit record ties actor, artifact,
decision, and outcome together. A concurrent or stale approval cannot silently
replace a newer release. Credentials never appear in downloadable artifacts/logs.

Today: [scoped deploy credentials and app-scoped status](deploy-access.md) separate
submission from admin Basic-auth approval. Per-person identity and a durable actor
audit remain future work.

### U3: An existing application gains a new capability

The team adds attachments to an existing records app, or adds a settings store.
The developer should not need to create a new app and abandon the old data.

Acceptance: the proposal distinguishes adding, retaining, renaming, and deleting
resources; existing identities/data remain stable; approved additions initialize
safely; destructive changes require an explicit separate operation. A failed
activation leaves a diagnosable, recoverable resource/deployment state. Test the
transition from an app without storage to one with storage, retaining old records.

Today: M7b qualifies adding R2 attachments to the deployed guestbook while
retaining D1 records. Existing resource identities remain fixed; approved additions
stay reserved after failures. D1/DO additions, renames and resource deletions remain
unsupported. [App retirement](retirement.md) has a separate stopped recovery path. See the [growth and transfer guide](../examples/guestbook/TRANSFER.md).

### U4: A failed update can be diagnosed and recovered

A developer ships broken SQL or code. Users receive a clear failure rather than
silently inconsistent behavior; the operator identifies the failed stage and
restores useful service without guessing which release or schema is active.

Acceptance: status/logs identify the request, stage, and active release; retrying
cannot forget applied SQL or replay ambiguous writes; code rollback is permitted
only when its resource/schema contract is compatible. Schema rollback is a separate,
explicit data operation. Inject a process crash at each externally visible stage.

Today: SQL failure, explicit retry/correction, version adoption and interrupted
activation have coverage. Owners can [inspect recorded release/control state](application-inspection.md).
Rollback tooling, scoped logs and live health/outcome observation remain open.

### U5: An operator deploys on team Kubernetes or a homelab

The operator deploys the same approved applications on an existing team Kubernetes
cluster or a two-node homelab. A teammate uses one stable endpoint without knowing
host placement. The application contract should stay the same while the operator's
installation and storage/network integration differ.

Acceptance: document placement, private connectivity, TLS, DNS, capacity, and storage
failure domains; reboot one host under acknowledged writes; reconnect clients;
verify recorded data and deployment identity after rejoin. Explicitly test controller
and bucket outage behavior. Two worker hosts alone are not a whole-stack HA claim.

Today: Docker container failures and experimental Kubernetes deployment/recovery
on local kind are tested. Actual two-host topology and host/network failure remain
unqualified. Availability requirements must precede bucket placement or an
ingress/controller redundancy design.

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

Today: stopped Docker snapshots restore onto fresh volumes, and experimental local
Kubernetes snapshots restore onto fresh claims. Replica restart/rejoin is also
tested. Actual host/disk loss and independent offsite recovery remain unqualified.
Stable replica identities and witness logs must travel with the bucket snapshot.

### U7: A user uploads something that takes time to process

A user uploads documents, receives confirmation, leaves the page, and later sees
completed imports or a useful failure message. An operator can inspect and retry
failed work without creating duplicate business records.

Acceptance: jobs survive worker failure; duplicates are handled by application-level
idempotency; retries and terminal failures are observable; approved consumers cannot
start before their required schema/resources exist. During upgrades, define which
release may receive queued work and how in-flight work drains. Disabling HTTP routing
alone is not a background-event deployment gate.

Today: bounded Docker queue applications have a [supported opt-in](queue-admission.md),
including activation, duplicate handling, operator recovery, stopped restore and
retirement evidence. Scheduled work has a separate [qualified opt-in lifecycle](m11c-acceptance.md)
on the frozen local two-fleet family. Workflows remain unsupported.

### U8: Colleagues collaborate on live application state

Two users edit a shared board or watch progress without repeatedly refreshing.
A server restart should cause a recoverable reconnect, not unexplained lost edits.

Acceptance: define an acknowledged operation, preserve it across the supported
failure model, reconnect/resubscribe after a replica restart, and reconcile missed
updates without duplicates. Test WebSockets/SSE, close codes, idle behavior, and
routing across deployment. Do not promise that open sockets survive process loss.

Today: the [checklist acceptance](m11b-acceptance.md) qualifies native WebSocket
reconciliation and SSE observers locally, with pinned Void patches and the opt-in
celld candidate. Remote infrastructure and broader collaborative semantics remain
outside that evidence.

### U9: An operator hosts more apps and retires one safely

A team adds a third project, observes capacity, then retires an old application
without giving its data to the next app that uses that capacity.

Acceptance: capacity refusal names the limit; adding capacity is documented;
credentials and resources are scoped to the intended app; retention/export/deletion
are explicit; slot reuse cannot inherit another app's data or authority. An approved
resource-intensive app cannot silently exhaust unrelated app capacity.

Today: the default has two slots; [Docker expansion](expansion.md) qualifies three
fleets through stopped recovery. Scoped deploy credentials, admission limits and an
admin capacity report exist. Retained artifact quotas include historical releases.
[Retirement](retirement.md) releases a fleet through a stopped snapshot and fresh
installation, retaining old data and permanently retiring the name. Bounded
[read measurements](capacity-measurement.md) exist; automated placement, scoped
runtime storage credentials and maximum app density remain open.

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
