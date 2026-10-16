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
