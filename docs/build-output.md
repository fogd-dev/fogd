# Void build artifacts

fogd consumes a local Vite production build of a Void app. It never invokes the
Cloudflare provisioning path in `void deploy`.

## Starter provenance

The hello example was initialized with `npx --no-install void init` against the
workspace's pinned Void package. Selected D1, demo code, and skip deployment setup.
The initializer generated the schema, `/api/posts` route, and initial Drizzle SQL
migration. It also generated Vite and Void configuration. Builds run with
`VOID_REMOTE=0` and telemetry disabled.

## Artifact mapping

| Void output | celld input | workerd input |
| --- | --- | --- |
| `dist/ssr/index.js` and imported modules | Single Worker entry, loaded with `no_bundle: true` | None: the app executes in celld |
| `dist/ssr/wrangler.json` | Validated configuration subset with stable local resource identities | None |
| Client assets, when present | `assets.directory` referencing staged files | HTTP responses from celld |
| `db/migrations/*.sql` | Staged `migrations_dir`, applied with `celld d1 migrations apply` | None |
| App hostname and healthy replicas | Native public HTTP listeners | capnp external services consumed by gateway worker |

The generated Wrangler config contains tool metadata and empty declarations for
many Cloudflare features. The adapter must distinguish harmless generated defaults
from unsupported nonempty bindings. It must not silently discard a requested AI,
Hyperdrive, dispatch, or analytics binding.

The observed generated D1 migration path does not point to Void's generated
`db/migrations` directory from the staged bundle. fogd must resolve migrations from
the project explicitly and preserve their order. The build embeds Void's internal
migration/proxy routes; ingress must block `/__void/` and strip privileged headers.

No native binding crosses HTTP. There is no workerd D1 shim, R2 protocol emulator,
or Durable Object stub serialization in this architecture. A successful bundle is
not sufficient proof of compatibility: deployment must pass runtime smoke checks.

## Single-module constraint

The build adapter disables code splitting for the `void_worker` environment.
celld 0.6.2's `no_bundle` collector includes one JavaScript entry and Wasm siblings,
but does not upload Vite's JavaScript chunks. The default split output fails at
runtime. Client-side splitting is unaffected. See ADR 004 in [decisions.md](decisions.md).
