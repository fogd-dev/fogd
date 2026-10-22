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
| `dist/ssr/index.js` and Wasm siblings | Single Worker entry, loaded with `no_bundle: true` | None: the app executes in celld |
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

## Native React pages and client assets

`examples/guestbook` derives from the pinned Void `createPagesStarterTemplate`
with React pages and SQLite, then adds a typed API read and compile-time negative
client checks. It uses Void-generated Drizzle migration metadata. The template's
React compiler dependency is aligned with the installed React plugin's peer range.

The [build adapter](../packages/cli/src/build.mjs) restores the worker entry before
disabling splitting. The [asset staging helper](../packages/runtime/src/assets.mjs)
applies `.assetsignore` patterns before celld sees the tree. Excluded files and the
ignore file do not enter the approved artifact; `_headers` and `_redirects` remain
available to celld as metadata. The original app and normal `vite build` output are
not rewritten. Unsupported multi-output worker configurations fail explicitly.

Pinned source evidence:

- [Void React pages input](https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/packages/react/src/plugin-pages.ts)
  contributes the client entry through root build options.
- [Void's environment entry reset](https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/packages/void/src/index.ts)
  provides the upstream pattern for selecting the Cloudflare virtual worker entry.
- [Void asset packaging](https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/packages/void/src/cli/package.ts)
  applies gitignore-style exclusions.
- [celld deploy](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/deploy.rs)
  rejects `.assetsignore` and collects the single prebuilt worker module.

The [verification image](../docker/verify.Dockerfile) installs dependencies during
image construction, then builds the unchanged guestbook source twice with network
access disabled: ordinary Vite output targeting Cloudflare, then fogd's single
worker output targeting celld. Both retain the split client assets. This proves
local compilation, not Cloudflare-hosted execution or data portability.

Staging rejects all symlinks before applying asset exclusions, including symlinks
under ignored paths. This is stricter than Void packaging. The worker directory contains only the JavaScript entry and Wasm files. Preview
secrets, source maps, and raw generated config stay out of the upload. The translated
config lives at the artifact root. Dotenv and `.dev.vars` variants are mandatory
asset exclusions that user ignore negations cannot override. This is not a guarantee of byte-identical builds across
machines or toolchains. The offline verifier retains both target outputs in the
container and prints their file sizes and supported configuration for comparison.

## Required private environment names

Void's generated `secrets.required` becomes `fogd-deployment.json`, covered by the
artifact digest. The canonical celld config contains no secret declaration or values.
Only the approved execution copy receives values as celld vars. The accounts fixture
uses a non-optional `env.ts` declaration; optional/defaulted schema entries do not
request injection. Required names cannot conflict with other bindings or ordinary
variables. Unsupported secret directives fail explicitly.

Generated `build.watch_dir` is accepted as inert build metadata and stripped;
submitted build commands are refused. Local builds filter inherited managed Void
deployment flags as well as platform credentials. No Cloudflare deployment mode or
internal auth proxy token is injected. The offline verifier covers accounts and its
required-secret metadata alongside the base and attachment guestbook fixtures.

## Native asset size limits

Artifact admission bounds total decoded bytes; native publication can impose a
smaller per-file asset limit. The qualified `celld-cron-v2-linux-arm64` family
refuses an individual asset above 25 MiB. The [serving measurement](serving-measurement.md)
observed this refusal with a single oversized padding file, then published the
same total 32 MiB using smaller files. The current adapter does not preflight that
per-file native limit; a total-size-admitted artifact can fail during publication.
