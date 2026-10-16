# Architecture proposal for milestone 1

Run complete Void app workers on celld and use workerd for stateless HTTP ingress.

## Container context

Compose runs MinIO, a workerd ingress, and two celld replicas for the first app.
Both celld replicas use the same app-specific bucket prefix and separate local
volumes. workerd forwards HTTP to healthy replicas. Do not retry ambiguous writes:
a transport error after submission cannot prove that an operation did not commit.
Clients use idempotency keys for retryable writes. No binding objects cross runtimes.

Void's Vite build produces worker modules, generated Wrangler configuration, and
client assets. A fogd adapter validates this artifact, converts only supported
configuration to celld input, packages SQL migrations, and invokes upstream
`celld deploy` from a container with esbuild. No `void deploy`, Cloudflare API,
or Cloudflare credential is used. Unsupported bindings fail before deployment.

D1, R2, Durable Objects, KV, queues, and workflows remain inside celld. workerd
serves a small gateway worker configured with capnp external HTTP services.
Plain HTTP can carry request/response streams; it does not preserve JavaScript
RPC capabilities, Durable Object stubs, transaction scope, or binding identities.
WebSocket proxy behavior requires testing; do not claim it until verified.

## Deployment and persistence boundaries

Keep app state under a stable app prefix. Never use a release ID as a state prefix.
Bucket access is admin access. Only the deploy controller holds bucket credentials;
teammates submit immutable bundles for approval, not arbitrary Docker commands.
Container limits apply per replica; celld heap/resident-cell limits apply inside it.
The bucket and controller metadata volumes are durable local infrastructure.
Two celld replicas do not make a single MinIO container highly available.

For platform v0, prefer one fleet per app, two replicas per fleet. This expands to
four celld containers for two apps on the same Compose stack. It costs memory but
avoids changing celld's single fleet entrypoint or coupling app state namespaces.
The two eventual homelab machines each host one replica of every app. A shared-fleet
router with service bindings is an alternative to reconsider at milestone 5.

Migrations run under admin authorization with serialized deployments. A migration
failure prevents routing a new app. Existing-app schema changes need backward
compatibility; runtime deployment and SQL migrations are not one atomic transaction.
Test starter D1, realistic D1/R2/DO, acknowledged write persistence after one node
is killed, replica recovery, gateway restart, and two approved hostname routes.

## Alternatives

1. Split app execution onto workerd and bridge each binding to celld: better
   workerd fidelity but bespoke protocols and semantic gaps for RPC/streams.
2. Use celld alone: least machinery, but omits the requested workerd integration.
3. Keep complete apps on celld and workerd at ingress: chosen reversible baseline.

This is a proposal until peer-review findings are recorded and resolved.
