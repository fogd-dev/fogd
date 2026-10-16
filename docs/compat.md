# Compatibility matrix

This is a source audit, not an end-to-end compatibility certification. The matrix covers the SDK-generated bindings and the checked-in Void Platform workers at the pinned revisions below. Arbitrary Cloudflare configuration passed through `cloudflare` is outside this finite inventory; fogd must reject unsupported capabilities.

**Yes** means the standalone runtime implements the capability. **Partial** means it needs a backend, has a material subset, or lacks distributed operation. **No** means it does not implement the feature. A workerd client binding is not a self-hosted backend.

| Upstream | Audited revision |
| --- | --- |
| void | `6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f` |
| celld | `90b43017241f81189453d326d05948f388b34652` |
| workerd | `e0bf62429359aa01de6f02887fbbf6e889601156` |

## SDK and platform inventory

| Feature used or exposed by Void | workerd | celld | Source and qualification |
| --- | --- | --- | --- |
| Fetch workers, Vite SSR, file routes, typed client | Yes | Yes | SDK; [V-bindings], [W-config], [C-runtime]. Framework adapters still require app-specific validation. |
| D1 / Drizzle, sessions, SQL batches | Partial | Yes | [V-db], [W-d1], [C-runtime] (`D1Database`, `__D1DatabaseCell`). celld sessions are primary-only with a fixed bookmark. workerd provides the client, not a D1 database server. |
| SQL migration runner | Partial | Yes | [V-migrations], [C-deploy]. fogd must package SQL and invoke celld migrations; Void deployment orchestration is not portable as-is. |
| R2 storage, metadata, streams, multipart | Partial | Partial | [V-storage], [W-config] (`r2Bucket`), [C-r2]. workerd requires a protocol backend; celld stores objects in the fleet bucket. Multipart handles are process-local and cannot resume across nodes or restarts. |
| KV namespaces | Partial | Yes | [V-bindings], [V-api], [W-config], [C-kv]. workerd exposes a client binding, not a distributed store. |
| Durable Objects, SQLite, alarms | Partial | Yes | [V-durable], [V-api], [W-config] (`durableObjectStorage`), [C-storage], [C-runtime]. workerd has local durable storage, without fleet ownership/replication. |
| Durable Object RPC and service RPC | Yes | Partial | [V-durable], [W-config], [C-runtime]. celld RPC stubs cannot cross isolates; AbortSignal cannot cross nodes. Cross-runtime RPC is not assumed compatible. |
| WebSockets, live queries, SSE | Yes | Partial | [V-durable], [V-bindings], [C-runtime]. celld has WebSockets and streaming; failover requires reconnect and inactive streams expire. |
| Queue producers and consumers | Partial | Yes | [V-bindings], [V-api], [W-config] (`queue`), [C-runtime] (`Queue`, `__QueueCell`), [C-deploy]. workerd has no queue broker. |
| Cron handlers / fleet scheduling | Partial | Yes | [V-bindings], [V-api], [C-runtime] (`CelldCronSchedule`), [C-deploy]. workerd needs an external trigger scheduler. |
| Workflows (explicit Cloudflare config) | Partial | Yes | [V-config] allows passthrough; [W-workflows] is a client; [C-runtime] (`Workflow`, `WorkflowInstance`) supplies execution. |
| Static assets / ASSETS binding | Partial | Yes | [V-config], [V-dispatch], [W-config], [C-deploy]. workerd needs an asset-serving worker or disk service; celld packages asset indexes. |
| Cache API / ISR caching | Partial | Partial | [V-dispatch], [W-config], [C-cache]. No distributed CDN cache in either standalone runtime; celld cache is always-miss. Platform ISR also uses KV. |
| Node compatibility / async context | Yes | Partial | [V-config], [W-config], [C-modules], [C-runtime]. celld implements a subset; accepting nodejs_compat does not imply full parity. |
| Vars and secret text bindings | Yes | Yes | [V-config], [V-api], [W-config], [C-deploy]. celld vars are stored in deployment objects; bucket access is administrative access, not an encrypted secrets service. |
| Workers AI and AI Gateway | Partial | No | [V-bindings], [V-proxy], [W-ai], [C-deploy]. workerd contains a binding client, not model inference. celld allowlist has no ai; no implicit external fallback. |
| Hyperdrive / Postgres / MySQL | Partial | No | [V-config], [V-api], [W-config] (`hyperdrive`), [C-deploy]. celld has TCP sockets but no Hyperdrive binding; direct DB adapters would need separate verification. |
| Send email / inbound email | Partial | No | [V-config], [V-proxy], [W-config], [C-deploy]. Runtime APIs alone do not supply delivery, DNS, or sender verification. |
| Sandbox / containers / remote build workers | Partial | Partial | [V-bindings], [V-api], [W-config], [C-runtime], [C-deploy]. celld container support is experimental and needs a host executor; excluded from fogd v0. |
| Workers-for-Platforms dispatch namespaces | No | No | [V-dispatch], [V-api], [V-proxy], [W-config] TODO dispatch, [C-deploy] allowlist rejects dispatch_namespaces. Dynamic loading is a separate API. |
| Dynamic worker loading | Yes | Yes | [W-config] `workerLoader`; [C-deploy] `worker_loaders` and [C-runtime]. Neither supplies the Void Platform control plane or WfP namespace contract. |
| Analytics Engine / platform usage queries | Partial | No | [V-dispatch], [V-tail], [W-config] `analyticsEngine`, [C-deploy]. workerd forwards events but provides no analytics storage/query service. |
| Tail workers / managed logs | Partial | Partial | [V-tail], [V-api], [W-config], [C-runtime]. celld supports dynamic-worker tails, not the platform tail-handler deployment and analytics pipeline. |
| Version metadata binding | Partial | No | [V-api], [W-config], [C-deploy]. fogd can track release IDs itself; celld rejects version_metadata config. |
| OAuth login / platform roles / deploy authorization | No | No | [V-api]. Application/control-plane behavior, not a runtime feature. Void Platform also requires Postgres and external login configuration. |
| Cloudflare API provisioning, DNS, domains, TLS, Access | No | No | [V-build], [V-api], [V-config], [C-deploy]. workerd can terminate TLS with supplied certificates; managed provisioning must be replaced by fogd routing/deployment; no Cloudflare API use is allowed. |

## Source findings that change the initial hypothesis

celld embeds its own V8 runtime and supplies the stateful binding backends. Keeping an app and its bindings together avoids reimplementing D1 sessions, R2 streams, and Durable Object RPC across an HTTP bridge. workerd can serve as the stateless ingress.

The celld deploy parser has an explicit `SUPPORTED_KEYS` allowlist and rejects unknown keys. That list includes `worker_loaders`, but excludes `dispatch_namespaces`, `ai`, `hyperdrive`, and `analytics_engine_datasets`. This confirms the dispatch/AI gap from code, independently of documentation. workerd explicitly defines `workerLoader` and separately retains a dispatch TODO.

A celld bucket prefix is a fleet. Its deploy code writes named script pointers and one fleet-wide `deploy/current.json` entrypoint. Deploying unrelated apps into that prefix can switch the shared entrypoint. fogd needs an explicit multi-app design; a bucket per app or prefix per app preserves upstream deployment behavior.

## Source references

[V-bindings]: https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/packages/void/src/plugin-worker-bindings.ts
[V-config]: https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/packages/void/src/config.ts
[V-db]: https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/packages/void/src/runtime/db.ts
[V-durable]: https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/packages/void/src/runtime/durable.ts
[V-storage]: https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/packages/void/src/runtime/storage.ts
[V-api]: https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/platform/packages/api/src/env.ts
[V-dispatch]: https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/platform/packages/dispatch/src/env.ts
[V-proxy]: https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/platform/packages/proxy/wrangler.jsonc
[V-tail]: https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/platform/packages/tail/wrangler.jsonc
[V-build]: https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/packages/void/src/cli/deploy-cloudflare-build.ts
[V-migrations]: https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/packages/void/src/runtime/migration-handler.ts
[C-deploy]: https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/deploy.rs
[C-runtime]: https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/js/harness.js
[C-r2]: https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/js/r2_ops.rs
[C-kv]: https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/js/services/kv.js
[C-cache]: https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/js/cache.js
[C-modules]: https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/js/modules.rs
[C-protocol]: https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/protocol.rs
[C-storage]: https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/js/storage_ops.rs
[W-config]: https://github.com/cloudflare/workerd/blob/e0bf62429359aa01de6f02887fbbf6e889601156/src/workerd/server/workerd.capnp
[W-d1]: https://github.com/cloudflare/workerd/blob/e0bf62429359aa01de6f02887fbbf6e889601156/src/cloudflare/internal/d1-api.ts
[W-ai]: https://github.com/cloudflare/workerd/blob/e0bf62429359aa01de6f02887fbbf6e889601156/src/cloudflare/internal/ai-api.ts
[W-workflows]: https://github.com/cloudflare/workerd/blob/e0bf62429359aa01de6f02887fbbf6e889601156/src/cloudflare/internal/workflows-api.ts
