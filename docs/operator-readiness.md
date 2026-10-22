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
engine. This does not complete the separate-machine acceptance condition below.

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
Queue status labels in the frozen runtime, scoped logs, and broader live diagnosis
remain open; these commands implement part of this increment.

Provide scoped deployment diagnostics that connect a submitted release, approval
progress, runtime state, and the application's recorded failure. Correct unknown
progress labels for existing queue lifecycle steps when a new runtime family can be
built and qualified. Define a separate
logging interface before exposing raw process logs, which may mix applications or
contain private values.

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
Controller artifacts and quota are unchanged; the full quota-fill and reclamation
gate below remains open and needs a newly qualified server runtime.

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
retains raw errors and resource counters. It does not complete the broader app-count,
write-load or density acceptance below.

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

Existing shared installations with the development password were already outside
the shared guide's requirement to choose a private password before first use.
Refusing that configuration is intentional hardening. It does not claim a credential
migration is qualified, or silently turn an environment edit into a migration.
