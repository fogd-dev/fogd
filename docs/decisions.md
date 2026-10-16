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
