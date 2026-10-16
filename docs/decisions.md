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
