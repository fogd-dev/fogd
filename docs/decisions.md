# Decisions

These records explain choices that would otherwise need clarification. Later
records supersede earlier ones without rewriting their context.

## ADR 001: keep application bindings inside celld

**Context.** Void uses D1 sessions, R2 streams, and Durable Object RPC. workerd
provides binding clients but does not provide a distributed state backend.
celld implements both worker execution and those backends. The status quo is a CLI
stub with no runtime.

**Options.** Split every binding across workerd and celld; run celld alone; or keep
complete apps in celld with a workerd ingress. Splitting maximizes workerd API
fidelity but requires protocol adapters and conformance tests. celld alone minimizes
operations but omits the requested workerd component.

**Decision.** Use the complete-app celld model with workerd ingress, subject to the
milestone 1 review recorded under `docs/reviews/`.

**Consequences.** HTTP is the only cross-runtime boundary. Apps inherit celld's
compatibility gaps. workerd does useful routing work but does not execute the
application's stateless handlers. Maintainers avoid owning a second D1/R2/RPC
implementation. Apps requiring unsupported APIs fail deployment explicitly.

## ADR 002: isolate application fleets

**Context.** Upstream celld writes one fleet entrypoint pointer on every deploy.
Independent app deployments in the same prefix could switch another app's public
entrypoint. Named service bindings exist but still require a coordinated root router.

**Options.** Share a fleet with a generated root router; isolate fleets by app;
or leave the stub single-app. A shared fleet saves resources but couples publication,
class names, and resource IDs across otherwise independent deployments.

**Decision.** Start with a stable bucket prefix and two celld replicas per app.
Reassess the choice at the platform review gate. This means two containers for one
app and four for the requested two-app demonstration, on one local Compose stack.

**Consequences.** Each homelab machine can host one replica of every app. The cost
is additional processes and memory. Prefix isolation is a naming boundary; shared
bucket credentials are not a tenant security boundary. Network and credential
isolation must be addressed explicitly before hostile multi-tenancy.

## ADR 003: build MinIO from upstream source

**Context.** Pulling the published MinIO image failed at Docker Hub and Quay.
The upstream repository offers source builds. A clean checkout cannot rely on an
image already cached on the developer's machine.

**Options.** Use an unofficial image mirror; change to Garage and qualify its
conditional-write semantics; or build the pinned upstream release inside Docker.
Keeping the failed image references would block every clean deployment.

**Decision.** Build MinIO's source release in a multi-stage Dockerfile. No host Go
installation or global system change is needed.

**Consequences.** The first build is slower and needs dependency downloads. The
bucket remains a single local point of failure. celld's startup object-store
conditional-write probe must pass before accepting this backend.

## ADR 004: emit a single worker module for celld

**Context.** Loading the original Vite chunks failed with `no stub for specifier
./assets/env-*.js`. celld's `no_bundle` implementation collects one JavaScript
entry and Wasm siblings, not additional JavaScript modules. Claude correctly
warned against rebundling the Vite output, but its review did not catch this limit.

**Options.** Patch celld's module collector; rebundle with esbuild; or configure
Vite/Rolldown to emit one module. Leaving the default split output cannot load.

**Decision.** The build adapter sets `codeSplitting: false` for Void's worker
Vite environment, then uses upstream celld `no_bundle: true`.

**Consequences.** The complete worker loads in both replicas and retains Void's
binding behavior. Large apps lose worker-side lazy chunk loading. Client output
can still split normally. A multi-module collector is an upstream enhancement,
not an unlabeled fogd fork.

## ADR 005: retain replica identity with its log volume

**Context.** In the first sequential crash experiment, restarting replica A with
celld's default random node ID made it unable to answer a later recovery request
addressed to its old identity. Killing B then left B's old log without a reachable
true witness, even though A still had the replicated fragments on disk. The
restarted A rejected the seal request addressed to its old target identity. Retaining a volume alone
was insufficient for this experiment.

**Options.** Retain node IDs with the volumes; wait for and verify complete ensemble
replacement before allowing another outage; or select upstream bucket-only durable
acknowledgements. Random identities without an additional repair gate did not pass
the sequential failure test. Bucket mode reduces reliance on live followers but
changes write latency and does not repair an existing open fleet log.

**Decision.** Configure a stable `CELLD_NODE` for each replica. Keep the IDs unique
within their fleet and retain them with their volumes. Wait at least one lease
lifetime before starting a replacement process with that identity. Use upstream
configuration, without modifying celld.

**Consequences.** Both replica-loss reads pass in the repeated experiment. The
operator must not run two live processes with one identity or reuse an identity
with an unrelated disk. The local experiment recovered the original data by
restoring the original IDs; those machine-specific IDs remain only in ignored
`.env`. A clean checkout uses the documented per-replica defaults.

## ADR 006: Gate immutable deployments in a small controller

Context: Void Platform requires provisioning and dispatch services absent from this
stack. Two teammates' apps need independent routing and admin-controlled activation.

Options: adapt Void Platform; implement WfP dynamic dispatch; share one celld root
router; use an approval controller and pre-provisioned app fleets.

Choice: a Node controller stores pending artifacts, checks exact digests, and invokes
fixed celld commands only after Basic-authenticated approval. Two fixed slots have
two replicas each, private networks, and conditional ownership markers in the bucket.
workerd resolves hostnames through an authenticated route endpoint with static backend
bindings. No Docker socket, Postgres, or Cloudflare APIs are required.

Why: Claude and Gemini independently preferred this reversible option. It preserves
the tested runtime boundary and permits later replacement of the control plane.
Activation deliberately pauses routing before migrations; a failed activation stays
paused until explicit retry. Migration ledgers are reconciled after partial failures.
Local bucket credentials are shared; trusted, reviewed code is required. See the
[review response](reviews/platform-response.md) for accepted findings and tradeoffs.

## ADR 007: preserve native Void pages through build and asset translation

**Context.** The native React pages plugin contributes a client entry to root
Vite options. It reaches the worker environment alongside the worker entry, so
turning off worker splitting alone fails with multiple inputs. Its client output
also contains `.assetsignore`, which celld rejects. Leaving these unchanged
prevents native pages deployment.

**Options.** Patch the pinned upstream tools; rebundle generated code; or adapt
Vite environment options and materialize asset exclusions before staging.

**Decision.** Restore `virtual:cloudflare/worker-entry` as the native worker's
single input, preserving other output settings and normal client splitting.
Void uses the same entry-reset pattern for its Vinext integration. Apply
`.assetsignore` with the same `ignore` library used by Void, omit the control
file, and retain `_headers`/`_redirects` for celld's parser. Default dotenv and
OS metadata exclusions follow Void's packager. Hash the resulting staged tree.

**Consequences.** Native React pages deploy without an upstream fork or a second
bundler. This is an adapter for the pinned native Void build environment, not a
promise for all framework outputs. Changes to upstream entries or asset rules
require requalification. A celld multi-module collector remains the more general
upstream opportunity; fogd bears the adapter maintenance cost in the meantime.
Source references and the fixture are in [build-output.md](build-output.md).

## ADR 008: expose team deployment status through a bounded projection

**Context.** Submitters can create releases but need admin credentials to inspect
progress. Backend failure text can include SQL or credentials. The current deploy
token identifies the whole team, not an individual teammate.

**Options.** Keep status admin-only; introduce individual identities now; or expose
bounded status to the existing team credential.

**Decision.** Add `fogd status <deployment-id>` and a read-only endpoint authenticated
with the deploy token. Return only deployment identity, digest, status, timestamp,
step, and fixed failure guidance for releases owned by `team-token`. Keep raw
errors, artifact inspection, and mutation admin-only.

**Consequences.** Team members can check progress without admin credentials, but
any team-token holder can inspect another team submission if they know its ID.
This is not per-person ownership. Rotation does not create a new ownership
boundary. Detailed diagnostics still require an administrator; named identities
and scoped tokens remain M8 work. Unknown failure steps reveal no raw text.

## ADR 009: stage runtime modules and enforce secret-file exclusions

**Context.** Gemini's M7a review identified that Vite can emit local preview secrets
in `dist/ssr/.dev.vars`. Copying the complete build directory would upload them with
the artifact. Claude also identified unused generated config containing host paths.
Asset ignore rules alone do not protect the server bundle directory.

**Options.** Keep copying all output; maintain a growing worker-file denylist; or
stage only the worker entry and Wasm files that celld's prebuilt loader consumes.
For public assets, allow upstream ignore negations to override default secret-file
exclusions or make those exclusions mandatory.

**Decision.** Stage only the JavaScript entry and Wasm files as worker modules.
Keep the validated, translated config at the artifact root. Always omit dotenv,
`.dev.vars` variants, and OS metadata from public assets, even when `.assetsignore`
negates them. Preserve root `_headers` and `_redirects` for celld parsing. This
narrows the asset semantics recorded in ADR 007.

**Consequences.** Preview secrets, source maps, and unused generated worker metadata
stay out of uploads. Administrators lose uploaded worker source maps; a future
debug-artifact channel needs an explicit privacy policy. Asset ignore rules cannot
publish a file matching the mandatory exclusions, which is stricter than upstream
Void. Application code and deliberately embedded values still enter the bundle;
this does not make untrusted builds safe or implement secret injection.

## ADR 010: use fresh-agent onboarding as the reproducibility gate

**Context.** M7a's remaining acceptance condition required another developer to
follow the setup. That makes progress depend on human availability even when the
written workflow can be exercised independently by an agent.

**Options.** Wait for a human; reuse the implementation agent and its context; or
run a fresh agent from README with isolated checkout and application state.

**Decision.** Use a fresh, smaller agent without conversation history. Give it a
clean checkout, fresh Compose volumes and credentials, the user objective, and
only environment/safety constraints. It discovers the procedure through README
and linked user guides. Documented automation is allowed. It must report missing
instructions instead of reading implementation internals or repairing the product.
If documentation needs repair, repeat with a new agent and clean state.

**Consequences.** Reproducibility no longer waits for another person. Record the
model, revision, commands, failures, assistance, and isolation limits. Existing
host tools and dependency/image caches may be shared and must be disclosed.
Success qualifies agent execution of the documented workflow, not human usability
or a fresh operating-system installation. Human feedback remains optional. A
smaller model can still infer steps a human would miss, so successful automation
must not be described as proof of an intuitive manual workflow.

## ADR 011: reserve approved additive R2 declarations

**Context.** A deployed Void app needs to add attachments while keeping existing
messages. Freezing every declaration prevents that update. Publication can fail
or a controller can restart after an approval has started applying changes.

**Options.** Keep all declarations frozen; allow arbitrary changes and attempt
rollback; or permit only R2 additions with a persistent reservation floor.

**Decision.** Permit new R2 bindings while preserving every existing binding name
and bucket identity. D1, Durable Objects, and script identities remain unchanged.
Persist approved declarations before migration/publication. Validate later releases
against this floor, including after failure or rejection. Show additions relative
to the active release. Binding order does not change identity. Reject unsupported
nested storage settings and derived names exceeding celld's 64-character limit
before accepting the artifact. Applied SQL hashes remain immutable.

**Consequences.** Developers can add file storage without abandoning D1 records.
An approved failed addition cannot be removed by a replacement release. Operators
must retain it while correcting the failure. A stale request's approval is refused;
it stays pending until explicitly rejected or superseded. R2 reservation is fogd
metadata: celld creates the slot-scoped `r2/{bucket_name}/` namespace lazily on
writes. There is no bucket-provisioning transaction or automatic retirement.
This extends the approval controller described in ADR 006.

## ADR 012: qualify a bounded guestbook logical transfer

**Context.** M7b needs evidence that application data can move. General backups
require coordinating more writers and runtime metadata than the guestbook uses.
D1 and R2 do not share a transaction.

**Options.** Defer all transfer until M8; implement generic physical backup now;
or qualify one bounded logical profile with an explicit maintenance window.

**Decision.** Transfer messages and referenced attachment bytes through native
Void middleware, keeping schema knowledge with the fixture. Version the profile
as `fogd-guestbook-v1`; cap each table at 100 rows, each object at 64 KiB, total
objects at 1 MiB, and compact JSON at 2 MiB. Validate IDs, references, sizes,
canonical base64, and SHA-256 before writes. Destination SQL and R2 must be empty.
Claim a snapshot digest in SQL, put objects under stable UUID keys, then commit
all rows and completion together with D1 batch. A pending receipt permits only
an identical retry, checking any existing object's bytes before reuse.

Stop the local workerd service and gracefully stop/start both participating fleets.
Check both replicas' active versions and health before transfer. Require exclusive
operator access with no concurrent deployment approvals. This fixture has no
Durable Objects, schedules, queues, or external writers. Keep ingress stopped on
failure. The `/__fogd/` middleware requires a maintenance header that ingress strips
and uses a path ingress blocks. The operator reaches it through the private fleet.

**Consequences.** The transfer excludes unreferenced R2 objects and runtime logs.
It supports this versioned application schema, not arbitrary SQL or cross-version
migration. All apps on the stack lose public ingress during transfer. An operator
must inspect failures and explicitly resume ingress or retry. Content-addressed
keys were considered; stable UUID keys plus digest checks preserve attachment
identity without introducing deduplication. Filecoin and Cloudflare-hosted migration
remain outside this qualification. M8 still owns installation backup/recovery.

## ADR 013: pin private configuration to each approval

**Context.** Native Void apps need runtime secrets without embedding values in
reviewable build artifacts. A secret update during a failed deployment must not
silently change what a retry executes.

**Options.** Keep private configuration unsupported; embed values in builds; or
store immutable app-scoped revisions separately and select one during approval.
A dedicated encrypted vault would improve operator controls but would not encrypt
celld's plaintext deployment bindings without a separate runtime design.

**Decision.** Admit required names emitted by Void into digest-covered metadata.
Admin-only stdin/API input creates an opaque secret revision. Approval pins that
revision before backend effects. Materialize only declared values in a temporary
execution copy; remove it after execution and on controller startup. Preserve the
original artifact. Hide private deployment version hashes and raw backend errors
from API responses. A private app keeps diagnostic redaction on subsequent releases.

**Consequences.** Admins must manage secret sets and explicitly approve rotations.
Retries retain the original revision, so correcting a bad value requires a new
submission. The controller retains old revisions for retries; pruning is deferred.
Its private storage and celld's bucket require coordinated backup and access control.
The bucket still contains plaintext values. Trusted local operation is qualified;
public or hostile-tenant operation is not. Fixed failure stages give operators less
detail than raw backend errors. M8 must address recovery and shared-operation policy.

## ADR 014: qualify Void auth with a password primitive adapter

**Context.** The pinned celld Node crypto shim throws for scrypt and scryptSync,
which prevents Void's default password implementation from serving signup/login.
Native Void auth remains valuable even while this runtime primitive is missing.

**Options.** Defer auth; patch celld immediately; or supply an explicit app-level
password adapter. Patching celld is the preferred eventual runtime outcome but
requires upstream crypto API work and a separate qualification.

**Decision.** The accounts fixture uses pinned noble-hashes scrypt with Void's exact
cost parameters, normalization, salt encoding, and record format. Verify both
Node-to-adapter and adapter-to-Node password records. Keep native Void accounts,
sessions, cookies, API routes, and generated SQL migrations. The fixture explicitly
declares its signing secret through the non-optional Void environment schema.

**Consequences.** The adapter is visible compatibility code app authors must carry
until upstream support is qualified. It adds a dependency and performs scrypt in
JavaScript; this milestone does not establish password-service throughput. No cost
parameter is reduced. Ordinary offline Void builds pass, while hosted execution
remains untested. Internal auth-migration routes stay blocked; fogd applies the
checked-in generated SQL. Provider breadth and production auth operations remain
outside this milestone.

## ADR 015: recover a stopped installation as one unit

**Context.** A bucket-only copy can omit acknowledged writes held in celld replica
logs. Controller ownership, migration evidence, secret revisions, and node identities
also determine whether recovered data can be served safely.

**Options.** Defer recovery; copy the bucket alone; coordinate a live distributed
snapshot; or stop the installation and preserve every required component together.
Live snapshots would reduce downtime but need a runtime-level writer/checkpoint
protocol that fogd has not qualified.

**Decision.** Provide an explicit stopped backup and fresh-volume restore for the
local two-slot topology. Inventory actual container configuration and managed
volumes, stop every writer, archive all volumes and exact images, and complete the
manifest last. Verify corruption before restore effects and extracted contents
before writing the restore receipt. Restore keeps app, node, and credential identities
but assigns new physical volumes/networks. Image IDs prevent accidental upgrades.
The operator explicitly starts the recovered installation at the original origin.

**Consequences.** Operators accept whole-installation downtime and private snapshots
containing plaintext credentials. Recovery requires all replica logs, not merely
replaceable empty nodes. Snapshot and restore failures leave resources stopped;
partial targets cannot be reused automatically. Same-origin source/clone concurrency,
external storage, cross-version upgrades, scheduling, and retention are unqualified.
The approach is reversible and testable now; M8b still owns shared-operation policy.

## ADR 016: scoped credentials and conservative artifact admission

**Context.** The original shared token grants every teammate the same deployment
scope and status visibility. Unbounded retained artifacts and concurrent uploads
can also consume controller resources during otherwise ordinary development.

**Options.** Keep the shared token; adopt an external identity provider immediately;
or add revocable, app-scoped deployment credentials while retaining the existing
approval administrator. For storage, automatically delete old artifacts or refuse
admission at a declared limit.

**Decision.** Issue high-entropy credentials with immutable app scopes, stable IDs,
and stored SHA-256 hashes. Scope/revocation checks and credential mutations share
the controller's submission queue. Status is restricted to its submitting identity.
Keep credential storage separate from deployment state and omit hashes from every
inspection response. Bound retained logical artifact bytes, pending requests per
credential, and concurrent authenticated uploads. Validate all limits at startup.

**Consequences.** Teammates receive narrower authority without becoming cluster
operators. Admins must distribute tokens privately and revoke/reissue to change
scope. The initial administrator remains a single bootstrap identity. Restores carry
credential metadata and revocations in the controller volume. Capacity exhaustion
requires operator action; automatic pruning could discard migration/recovery evidence
and is deferred to M10. Logical byte limits do not bound app data or filesystem block
usage. M8b2 must add transport and shared-mode enforcement before shared-network use.

## ADR 017: native TLS and an explicit shared profile

**Context.** Scoped credentials need encrypted app and admin ingress. Void sessions
need the actual HTTPS origin, and recovery must retain transport configuration.

**Options.** Keep loopback HTTP only; add a reverse proxy that owns certificates and
forwarding; or use the existing workerd and Node HTTPS listeners. A reverse proxy
would offer mature renewal integrations but adds another deployment component.

**Decision.** Use native TLS, an operator-imported managed keypair, and an explicit
shared profile that requires TLS and disables legacy deploy access. Separate private
gateway routing from public admin ingress. The gateway replaces forwarding headers;
celld trusts them on private networks. Retain six-volume recovery compatibility and
include the optional TLS volume in new snapshots.

**Consequences.** Operators own certificate issuance, renewal and trust. The profile
validates declared bind settings, not firewall configuration. Private traffic stays
HTTP and workloads remain trusted. Certificate import rebuilds/recreates stopped
containers, so upgrades require backups and preserved identities. A proxy advocate
may prefer automated renewal; that can become a separate adapter once a deployment
target needs it. Local HTTP remains available for loopback development.

## ADR 018: qualify ordinary Kubernetes resources before a cluster operator

**Context.** The same app deployment/approval contract needs an installation target
beyond Compose. Local kind tools are available; authorized remote infrastructure and
physical-host failure evidence are not. A portable package needs explicit storage
ownership and recovery rather than a startup-only demonstration.

**Options.** Wait for remote hardware; build a bespoke Kubernetes operator; package
ordinary resources and qualify them locally first. An operator could automate
reconciliation later but would introduce another state machine before the resource
and recovery contract is established.

**Decision.** Render ordinary StatefulSets, Services, PVCs, and separate private
Secrets. Qualify them on isolated kind with repository-local kubeconfig. Bind celld
identities to ordinals/disks, keep controller and bucket single-writer, and use
OnDelete updates. M9a remains experimental until M9b stopped recovery and the
separate remote infrastructure gate pass.

**Consequences.** Operators can inspect resources without a custom controller, but
must plan updates and storage recovery. Kubernetes network isolation is weaker than
the Compose fleet networks on default kind; remote sharing requires enforced policy.
The node observation showed downtime when the singleton controller's node stopped,
even with surviving celld replicas. A multi-replica controller requires a separate
metadata/concurrency design. No global availability follows from this packaging.


## ADR 019: stopped recovery for the declared Kubernetes topology

**Context.** Kubernetes packaging needs a recovery procedure for controller metadata,
bucket objects, and every celld replica log and identity. Keeping only Docker recovery
would leave the second deployment target without a tested fresh-storage restore.

**Options.** Defer recovery; depend on CSI snapshots; or stop the installation and
archive its exact claim inventory. CSI snapshots can reduce downtime on supporting
storage, but the local-path fixture provides no coordinated snapshot primitive.

**Decision.** Add a separate Kubernetes adapter with an explicit context, generated
workload contract, image identity verification, and fresh-namespace restoration.
Stop every writer before read-only archive helpers run. Record observed terminal
outcomes separately from archive completion. Restore helpers bind empty claims to
selected nodes before stopped StatefulSets are created.

**Consequences.** Operators get a repeatable local recovery path with downtime and
private snapshot custody costs. An unreachable node prevents completion. Operators
must recover it and restart a partial source before another attempt. A CSI advocate
would reasonably object to copying every byte; a later storage adapter can supply
that optimization once it has equivalent coordination and fresh-volume evidence.
The current format does not promise remote-cluster or arbitrary-storage support.

## ADR 020: report admission capacity from controller observations

**Context.** An administrator needs to distinguish full app slots, pending limits,
and retained artifact bytes. Admission already uses controller assignments, observed
bucket ownership, pending statuses, and decoded artifact accounting. Rejection does
not delete historical artifacts or free an app slot.

**Options.** Keep opaque refusal messages; query bucket and filesystem state on each
admin request; or expose the accounting already used for admission. Live inventory
would be fresher but would couple the admin page to bucket availability and still
would not reserve future capacity.

**Decision.** Report the same in-memory predicates as admission. Retain cached
bucket-owner names separately from controller assignments so duplicate ownership
stays visible. Label that observation and the byte-accounting exclusions. Share the
pending-status filter between admission and reporting.

**Consequences.** Admins can explain current refusal without a storage round trip.
External bucket edits are not visible until restart or a claim. An operator seeking
live utilization still needs a later measurement slice; this report does not estimate
CPU, memory, app data, disk space, or cost. It does not free any retained resource.

## ADR 021: retire through an offline fresh-installation transform

**Context.** Reusing a fleet requires preventing old code, logs, object identities,
and deploy authority from reaching its replacement. Route pausing does not stop
background execution. Existing stopped recovery already copies a complete installation
onto fresh volumes and refuses partial-target reuse.

**Options.** Keep slots permanent; add online retirement plus an in-place journal;
or transform a stopped snapshot into a fresh installation. In-place retirement can
avoid copying the unaffected app, but needs crash-safe coordination across controller
metadata, configuration, and two replica volumes that the platform does not have.

**Decision.** Use the offline fresh-installation path for the first Docker adapter.
Retain data and history, replace the retired fleet's namespace and replica identities,
and keep a permanent app-name tombstone. Require an exact active digest and a runtime
that understands retirement. The source stays stopped; a partial target is never
reused. The [review response](reviews/m10b-response.md) defines the amended contract.

**Consequences.** Operators pay whole-installation downtime and temporary duplicate
storage, including a copy of the unaffected app. That cost is acceptable for the
current two-fleet fixture and must be measured during qualification. Operators who
need low-downtime retirement will need a later lifecycle protocol. This design does
not erase old data, reclaim artifact bytes, permit same-name reuse, or establish
hostile-tenant isolation.

## ADR 022: measure warm runtime overhead before expanding fleet count

**Context.** Two fixed fleets limit concurrent applications. Admission accounting
explains that limit but says nothing about memory or CPU. Each additional app
currently requires two celld processes and persistent replica volumes. Recovery
also assumes two fleets in several independent inventories.

**Options.** Enable a third fleet immediately; measure the current installation
first; or redesign shared-fleet tenancy before adding capacity. Immediate expansion
provides another app slot sooner but risks an incomplete backup inventory. Shared
fleets may reduce overhead but change resource isolation and ownership.

**Decision.** Capture repeatable warm idle and bounded stateful read observations,
then generalize recovery inventory while keeping two fleets, then qualify a third
fleet. Keep measurements as repository tools until the observation contract is
stable. Record observed usage separately from configured ceilings and describe
Docker Desktop results as exploratory VM evidence. The
[review response](reviews/m10c-response.md) records the amended sequence.

**Consequences.** Operators get inspectable measurements without installing a
monitoring service. Expansion takes longer and still needs cold-start, per-app
load comparison, full restore, and retirement qualification. A density-focused
operator may prefer shared fleets; this slice does not rule that design out.
Short read workloads do not estimate write-heavy demand, disk growth, monthly
cost, maximum safe density, or production availability.

## ADR 023: derive recovery inventories from one validated local layout

**Context.** Recovery previously maintained separate fixed lists of services,
volumes, archives, and retirement replicas. Expanding one list without the others
could omit state or make a captured installation impossible to restore.

**Options.** Extend each list independently; derive inventories from arbitrary
Compose services; or derive them from a validated fogd fleet layout. Arbitrary
Compose discovery would accept additional writers and storage relationships that
fogd has not qualified.

**Decision.** Derive all recovery inventories from matching controller/gateway
slot declarations, then check replica storage, volume mappings, and network
membership against that layout. Verify the configuration checksum before deriving
a bundle's archive inventory. Keep the existing bundle format and two-fleet gate
until three-fleet recovery and retirement qualification passes.

**Consequences.** Recovery fails early on inconsistent storage relationships and
has one place to extend fleet inventory. The qualified layout requires ordered
local service addresses, distinct node identities, and disjoint storage prefixes.
Custom addresses, additional services/networks, and crossed mounts are refused;
this is not a general Compose backup utility. Existing qualified snapshots remain
readable, including optional TLS storage. The three-fleet gate remains separate
from the inventory derivation.

## ADR 024: expand through fresh restore and derive templates with Compose

**Context.** More concurrent apps require additional replica pairs, private networks,
volumes, and routing bindings. A resize must preserve deployed apps and their state.
Recovered installations use private image-pinned configurations; fresh installations
need templates that continue to resolve environment settings.

**Options.** Add profile-dependent service and slot definitions; replace the YAML
with a JavaScript generator; or ask Compose for its unresolved source template and
add a fleet from that replica definition. For existing installations, mutate the
live project or reuse fresh stopped restoration with an expansion plan.

**Decision.** Keep `compose.yaml` as the source and use `--no-interpolate` output for
rendering. Clear Compose's derived resource names and require an explicit project
identity so separate installations do not share volumes/networks accidentally.
Expand a two-fleet stopped snapshot into a fresh three-fleet target. Copy existing
state unchanged, assign a new namespace and identities, and use only snapshot images.
The [review amendments](reviews/m10c-expansion-response.md) record this choice and
the discarded full-generator prototype.

**Consequences.** Operators can preserve two apps while adding capacity, with a
buildable template available for fresh installations. They pay downtime and duplicate
storage during expansion. There is no online resize, shrink, automatic scaling, or
automated image-upgrade path from a recovered configuration to a buildable template.
Operators seeking rolling expansion will need a later lifecycle protocol. Rendered
templates and resolved recovery files remain distinct artifacts with different
credential and image behavior.

## ADR 025: persistent queue pause with compatible handler overlap

Context: M11 needs queued work without allowing a new consumer to run before its
resources and schema exist. celld publishes consumer attachments independently of
HTTP routing. An empty fleet cannot accept queue pause, and a queue without stored
messages can still have `waitUntil` effects in progress. The [runtime probes](queue-qualification.md)
cover first publication, concurrent old/new handlers, timeout, and stopped recovery.

Options: add a runtime drain/activation patch; gate new deliveries with upstream
pause while supporting compatible old-handler overlap; or defer all queue support.
A live-lease diagnostic alone cannot establish a drain because acknowledged work
can continue through `waitUntil`.

Choice: implement toward persistent pause and compatible overlap, using upstream
runtime operations. A producer-only platform bootstrap establishes queue support
without running application code or attaching a consumer. Its queue set must equal
the approved consumed queue set. Persist bootstrap progress before any application
publication so retry cannot replace a partially published app with bootstrap code.
Pause and confirm before application publication; migrate and validate readiness
before resume. Probe whether the bootstrap can also support D1 migrations before
application publication, rather than assuming it can.

Before resume, instantiate the consumed queue through its operator status call and
verify resident queue cells belong to the current approved runtime generation.
Persist delivery intent separately from observation and HTTP routing. Failures keep
an activation hold until explicit repair/retry. Backup must establish and record
paused delivery before stopping writers; a restored installation must not silently
resume its queues. Retirement must preserve the old paused namespace while using a
fresh namespace for a replacement app.

M11a initially targets one same-app queue declared at first activation. Adding,
removing, renaming, or changing its policy after activation needs a separate tested
transition and is rejected in this slice. Keep logical names within the existing
per-app fleet namespace. Start administration with status, pause, and resume.
Queue support remains rejected until controller failure gates and a native Void
application pass; this ADR chooses the implementation direction, not feature status.

Why: the probes show old and new handlers genuinely overlap, while pause prevents
new delivery. The established additive migration contract can accommodate that
behavior if old handlers and their background work remain compatible with later
schemas and payloads. Empty backlog is not sufficient to authorize rollback:
old background work can still enqueue messages. Known older queue artifacts need
an explicit compatibility policy before reactivation is supported.

Costs and limits: the app must make business effects idempotent and retain durable
input/job records for retry or reconciliation. A terminal-error write alone cannot
cover a process killed before that write. Queue retention and retry exhaustion can
remove messages; an empty queue must never be reported as proof of job success.
No drain, exactly-once external effects, bounded `waitUntil` lifetime, or managed
Cloudflare execution is promised. Cron, Workflows, and broader queue transitions
remain later M11 work. See the [review response](reviews/m11a-response.md).

Implementation note for ADR 025: before resume, the backend materializes the named
queue with `info` and checks its exact cell identity on the approved runtime
version. Options were inferring identity from a single resident queue or deriving
the pinned upstream address. Choose the address: eviction between status and
inspection must not allow another resident queue to satisfy the gate. Follow
celld's `engine_api.rs` namespace/HMAC scheme without changing it; qualify the
recorded address and live cold/resident behavior when updating the runtime.
Mutation or confirmation failures report an unknown outcome, not a paused state.
See the [review response](reviews/m11a-generation-response.md).

## ADR 026: retain activation holds until confirmed delivery release

Context: queue resume can be refused before mutation or succeed with a lost response.
Clearing an activation hold before that call loses ownership even when resume is
refused. Migration corrections also need to replace a failed activation without
unpausing delivery.

Options: persist a separate releasing-activation record and restore holds only on
definite refusal, or retain the hold through confirmation and reconcile uncertainty
back to paused before explicitly completing activation again.

Choice: retain the hold until runtime confirmation is durably saved. Operator
intent remains separate. After interruption, explicit reconciliation pauses held
work; the activation coordinator rechecks readiness before releasing it. Permit an
explicit expected-owner hold transfer for a newly approved correction, preserving
operator intent and requiring a fresh confirmed pause.

Why: both pre-mutation refusal and uncertain mutation retain activation ownership.
Recovery does not need to infer whether an exception occurred before or after the
runtime effect. The cost is an extra pause/readiness cycle after an uncertain
activation resume. Existing handlers may still run; this does not create a drain.
No automatic runtime action occurs during journal reload. The implementation is
internal until controller approval, bootstrap, recovery, and retirement integrate it.

## ADR 027: stop controller mutations after uncertain metadata persistence

Context: `saveJson` can rename a state file before directory sync fails. Treating
that failure as an ordinary rejected submission can delete an artifact the saved
state references. Activation error recovery can also query or mutate the migration
ledger after its progress write failed. Delivery journals will share this controller
persistence boundary.

Options: retry or roll back in memory and continue, or stop controller mutations
until a fresh instance reloads disk. Choose the latter. A private failure flag blocks
queued mutations, further state writes, and activation error-path reconciliation.
Preserve artifacts and report unreferenced entries after reload rather than deleting
possibly referenced data. Retain the exception cause and emit one errno/syscall diagnostic without arbitrary
messages, paths, or metadata values. Return
503 to authenticated control-plane clients and pause
new routes while the instance cannot establish durable state.

Why: the process cannot infer whether the failed write committed. Continuing from
its in-memory view risks overwriting valid state or executing effects without a
persisted intent. Restart after restoring storage availability establishes the
actual saved state; interrupted activation still requires explicit retry. The cost
is controller-wide unavailability on a metadata write failure. Existing background
work is not stopped by this guard, and no drain is claimed.

## ADR 028: persist ownership reservations before bucket claims

Context: a first bucket claim could succeed before the controller saved its app
record, leaving an owner with no evidence permitting retry. Queue bootstrap also
needs a durable boundary before publishing any platform or app code.

Options: reconstruct ownership from bucket state after failure, or persist the exact
approved claim before its effect. Choose the latter. Reserve the app/slot with the
approval ID, digest, and prefix, claim only an unpublished namespace, then persist
confirmation before further effects. Startup verifies the reservation against the
original artifact and configuration; retry remains an explicit approval action.

Allow rejection to release a pristine reservation only after read-only checks find
no owner and no deployment objects, with no other configured fleet owning the app.
Persist local release and rejection together;
retain the artifact and never delete ownership objects. Existing owners or mismatched
configuration block release. This gives an administrator a way to abandon a claim
that never reached the bucket without opening a path to reassign claimed data.

Keep the state capability permanently recorded. This trades downgrade flexibility
for an explicit supported-state boundary. M10b-era and later controllers enforce
requirements; earlier binaries are not supported for this state. Full recovery uses
matching images. No runtime fork or distributed ownership lock is introduced; the
controller remains the sole publisher for its configured fleets.

## ADR 029: persist queue bootstrap progress independently of the active pointer

Context: a first activation can publish consumer code and then fail before recording
an active deployment. Using an absent active pointer as permission to bootstrap on
retry would replace that consumer with platform code. Queue pause can also be
uncertain after a lost response, making error-path migration reconciliation unsafe.

Options: keep queues unsupported without an integrated coordinator; infer bootstrap
progress from the active pointer; or record bootstrap progress before publication.
The first postpones the scenario, and the second cannot distinguish these failures.

Decision: integrate a coordinator while keeping public queue admission closed.
Persist pending, ready, and application phases on the app. Save the application
phase before attempting consumer publication. Confirm pause before queue migrations
or ledger reconciliation, including retries. Rehold interrupted activations and
confirm pause at startup; never resume automatically. Record a permanent capability
requirement so supported older controllers refuse this state.

Consequences: retry preserves app code and operator pause intent. Failed startup
pause leaves that app unavailable with an unknown observation; other apps remain
available. Running handlers are not drained. The initial coordinator permits only the held artifact to retry; operators
cannot yet substitute a migration fix or reject that held deployment. This narrow
restriction avoids an unreviewed hold transfer but must be resolved before public
admission. Tests use private artifacts and a persistent runtime stand-in. A combined Docker
probe also exercises the built coordinator with real celld, bypassing public admission.
Public approval and the remaining operator/recovery gates are still required.

## ADR 030: bind delivery resume to an inspected approval

Context: runtime version hashes may incorporate secrets, a queue status command can
instantiate cells, and the same artifact can be approved again with different secret
revisions. Administrators need controls that preserve activation holds and identify
what they authorize without exposing private runtime hashes.

Options: offer raw celld commands; automatically inspect the runtime on GET and
resume whatever is active; or expose serialized admin operations with an explicit
approval identity. Raw commands bypass the controller journal, and automatic resume
selection cannot distinguish an inspected approval from a newer secret revision.

Decision: GET reads recorded state. Explicit POST observes, pauses, or resumes under
the existing admin authentication and CSRF rules. Resume requires both deployment ID
and artifact digest, then verifies the private runtime generation internally. CLI
operators supply both identifiers; browser controls bind them when rendered. Strip
runtime hashes from app journals and bootstrap metadata in API views.

Consequences: administrators must distinguish recorded observations from current
runtime state and retain two identifiers for resume. Unknown outcomes remain visible
in the journal and return 502; storage uncertainty returns 503. An explicit observe
can materialize a queue cell, but never changes delivery intent or releases a hold.
It is not silently converted into pause: published consumers have already received
artifact approval, and pause remains the explicit way to establish that control.
Operator pause persists through successful activation. No drain or instantaneous
termination of already running work is promised.

## ADR 031: reconcile the original migration before transferring a queue hold

Context: ADR 029 initially allowed only the held artifact to retry. A permanently
invalid migration therefore prevented recovery through a corrected artifact.
Overwriting its uncertain pointer before reading the ledger would lose evidence
needed to decide which SQL can change.

Options: require manual metadata repair; let ordinary approval replace any hold;
or require explicit predecessor approval identity and a reconciled transfer. Manual
repair puts correctness on operators. Implicit replacement can authorize a different
predecessor after a stale page or concurrent action.

Decision: bind replacement to both artifacts' IDs and digests under the controller
lock. Validate candidate secret selection, establish the original hold's pause,
reconcile the original attempt, and enforce its applied migration hashes before
transfer. Persist the new hold owner and candidate approval/secret revision together
before the transfer pause command. Preserve operator intent, bootstrap phase, and
last completed runtime version. This supersedes ADR 029's original-artifact-only
retry restriction.

Retain the existing producer-only bootstrap path for an incomplete first bootstrap.
It excludes secret vars and cannot replay over app code once publication began.
Retain matching repair-tuple retries after transfer failure so an operator can retry
a lost response without guessing ownership. Completed approvals still require status
inspection rather than repeated mutation.

Consequences: administrators must review two artifact identities and preserve both
artifacts until reconciliation succeeds. Applied SQL cannot change; unapplied files
may be corrected under the pinned runtime's per-file transaction semantics. Old
artifacts remain retained after rejection. Conflicting hold/uncertain metadata fails
startup with identifying diagnostics; ordinary runtime availability failures remain
isolated to their app. No new state capability is needed: an older queue-capable
controller safely retries the atomically approved candidate under its existing hold,
while ignoring the predecessor audit field. Backup/retention and full public queue
admission remain separate gates.

## ADR 032: refuse unqualified queued installation recovery

Context: stopped installation recovery predates queue activation. It can copy and
restart privately staged queue state without preserving pause or checking message
age. celld's retention sweeps continue while paused. Metrics can omit expired
records, so a successful raw restore does not establish preservation.

Options: retain the existing commands with a warning; reject queued installation
recovery until its protocol is qualified; or implement a startup deadline and
pause coordination immediately. Warnings retain an easy experimental path but
leave operators with a misleading successful recovery. An immediate deadline
needs a release protocol so future healthy replica restarts do not fail forever.

Decision: refuse queued recovery from stopped controller metadata, including its
permanent queue capability. Apply the same boundary to Docker transformations and
Kubernetes restore. Refuse known queue history before stopping; recheck archived metadata after
stopping all writers and before issuing a success manifest. Require the canonical controller data path so the
check cannot read unrelated root metadata.

Consequences: private queue experiments temporarily lose the supported snapshot
workflow; even pending-only queue history triggers refusal. A queue submission racing the initial check can leave the installation stopped
with incomplete output, so operators must inspect a post-stop refusal before
restarting. Supported non-queue recovery continues. Full queue recovery
remains the next acceptance gate; this guard does not complete it or enable queue
admission. Direct runtime mutation remains outside the managed contract.

## ADR 033: detect queued recovery loss and require explicit acknowledgment

Context: ADR 032 closes recovery until delivery and retention are accounted for.
celld persists pause but retains wall-clock expiration; delaying restored startup
can expire work before the controller observes it. Operators need a usable recovery
path and an honest account of this limit.

Options: permanently block queued recovery; introduce per-replica startup deadlines
and a shared release protocol; or preserve operator pause, validate snapshot age,
and require acknowledgment of post-restore findings. The deadline option prevents
some startup effects but cannot make expired records deliverable and introduces a
second durable coordination protocol. An immutable bundle already preserves the
original storage for investigation.

Decision: qualify ordinary Docker backup/restore with exact-artifact preparation
receipts, stopped-state checks, recorded retention policy, and pending recovery
receipts. Check actual controller/replica image equality under the pinned Docker
build contract. Retain the first observation and cumulative findings. Require
recovery ID, review hash, deployment ID, digest, and explicit possible-loss acceptance before
restoring HTTP access; delivery needs a separate resume. Add a permanent state
capability so older controllers cannot ignore this gate.

Consequences: delayed startup can expire messages before detection. Backup failures
can leave delivery paused or the source stopped. Restored apps require an extra
administrator action even when no loss was observed. Historical acknowledged
receipts remain valid across runtime contract changes, but pending recovery actions
require their supported contract. Operators remain responsible for application-level
reconciliation and idempotency. This supersedes ADR 032 only for the qualified
ordinary Docker path; Kubernetes and transformations remain refused. Public queue
admission and retirement/isolation acceptance remain separate gates.


## ADR 034: retire queued apps into fresh fleet identities

Context: ordinary Docker recovery now accounts for queued work. Retirement must
prevent the removed app's queue from running again in its replacement fleet while
preserving recovery controls for surviving apps.

Options: retain the blanket refusal; purge queue records in place; or reuse the
stopped-installation retirement protocol with explicit queue audit and fresh fleet
identities. Purging would destroy recovery evidence and depend on queue internals.

Decision: require `--stop-queued-work`, the exact active artifact digest, and a
qualified unexpired stopped snapshot. Retain the target's delivery, preparation,
and acknowledged recovery history privately under its retirement record. Remove
operational queue fields and require a permanent queue-retirement capability.
The replacement receives a disjoint bucket prefix, new node identities, and empty
replica logs. Validate evidence against the source before transforming it; apply
pending recovery receipts only to surviving apps and write the final state once.
Admin inspection exposes an allowlisted audit summary. Backup accounts for valid
retired history without trying to pause it again.

Consequences: retirement intentionally stops pending target work in the replacement
installation; it does not erase the old bucket prefix or immutable snapshots.
Starting an older installation can still resurrect that work. Snapshot expiry is
checked before restore creation, not frozen during image loading or startup.
Surviving apps retain the ordinary recovery acknowledgment and separate resume.
Aged target snapshots, Kubernetes, and expansion remain outside this qualified
path. Public queue admission remains closed pending the full deployment acceptance.


## ADR 035: distinguish queue artifacts from approved runtime state

Context: public queue uploads would permanently disable backup under the previous
blanket capability guard, even if no administrator ever approved them. A rejected
failed claim also loses its app reservation, so rejection alone cannot prove safety.

Options: postpone the queue capability until approval, delete rejected artifacts,
or retain history and classify it through durable lifecycle evidence. Delaying the
capability weakens downgrade detection; deletion loses approval audit material.

Decision: keep the permanent capability. Treat a well-formed pending, rejected, or superseded
submission as artifact-only only before the approval step and secret-revision pin,
with no app referencing its approval ID. For rejected pristine claims, atomically record the exact
approval and released fleet after backend ownership/publication checks. Share this
rule between Docker backup and queue-free transformation/recovery guards. Unknown,
failed, held, or uncertain lifecycle state still refuses recovery.

Use a controller opt-in for the initial queue profile, off by default and absent
from Kubernetes rendering. Validate a single same-app producer/consumer pair and
four explicit policy values equal to 1. Canonical names preserve an existing app-
prefix or add it, so uploaded artifacts validate unchanged. Void's generated suffix
resolver preserves the logical handler name. Existing non-queue identities do not
acquire an empty queues field.

Consequences: ordinary pending uploads no longer remove recovery options. Legacy
rejections without release evidence remain refused. Turning off admission does not
pause already-approved work or prohibit exact retries of pinned failed approvals. Wider policies and default enablement require their
own evidence; the initial normal CLI checkpoint does not replace the remaining
update, recovery, retirement, and browser acceptance.


## ADR 036: keep qualified Docker queues as an operator opt-in

Context: the bounded queue profile now passes its application acceptance audit,
including canonical updates/recovery/retirement, populated-neighbor preservation,
and offline builds for both targets. Enabling it has installation-level consequences.

Options: enable admission by default, retain an indefinite experimental gate, or
qualify the profile while keeping a deliberate operator opt-in.

Choice: supported local Docker opt-in with FOGD_QUEUE_APPS=0 by default. Accept the
[Claude audit recommendation](reviews/m11a-acceptance-claude.md) after closing its two
missing checks. Kubernetes queues remain unsupported. This closes M11a, not all M11.

Why: activated or retired queue history prevents expansion and Kubernetes recovery;
turning admission off does not stop previously approved work. Retention continues
while paused, and updates permit compatible old-handler overlap. Operators should
choose those consequences explicitly. Default-off is policy rather than a claim
that the tested bounded profile remains unavailable.

Consequences: documentation must present the supported profile and its limits next
to the flag. Broader policies, topology changes, and managed execution require their
own evidence; the acceptance audit preserves the distinctions between private
runtime and ordinary CLI qualification. Continue the remaining M11/M12 work.

## ADR 037: native Void sessions with application-owned reconciliation

Context: U8 needs durable acknowledged edits and recovery of live browser state.
Void offers typed WebSocket rooms and separate SSE topic streams. The latter do
not retain application events; reconnect alone cannot recover missed state.

Options: create a fogd realtime abstraction, use only one transport as a substitute
for the other, or preserve native Void APIs with a bounded application protocol.

Choice: native `defineRoom` checklist with atomic SQLite state/receipts, durable
browser pending operations, terminal rejections, and snapshots. Test `void/live`
SSE independently as best-effort revision hints with catch-up from room storage.
Keep both in M11b acceptance. The [review response](reviews/m11b-design-response.md)
adds preserved-socket updates, explicit eviction, and owner/ingress failure tests.

Why: this advances the integrated developer experience without inventing a platform
protocol or confusing transport reconnection with durable acknowledgment. The basic
room builds, stages, deploys and exchanges messages through workerd without a shim.
That transport evidence is not proof of the proposed durable-session behavior.

Consequences: keep v1/v2 wire formats and socket attachments compatible; typed
rejections must settle pending operations. Explicitly show rollback after a lower
revision rather than silently ignoring the server. Internal SSE cleanup alarms do
not qualify general scheduled app effects. Implement and test the full reviewed
plan before changing feature support claims.
