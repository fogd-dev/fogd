# Feature comparison

fogd combines runtimes into a deployment platform. celld and workerd are runtimes;
Void supplies an SDK, CLI, and Platform; hosted Cloudflare supplies managed services.
A capability in a runtime does not mean fogd's deployment adapter exposes it.

Last verified: **2026-10-16**. Upstream revisions and file-level evidence are in
[compat.md](compat.md). fogd status refers to this repository's v0 implementation,
not planned features. Hosted Cloudflare status comes from current official docs;
this project has not deployed there or called its APIs.

**Yes** means implemented at the stated layer. **Partial** means the qualification
matters. **No** means unavailable in that component or deliberately rejected by
fogd. **Not audited** means this comparison makes no claim. Void's SDK/config cells
mean it exposes a capability supplied by the target runtime, not that Void implements
a database or broker itself.

## Application capabilities

Runtime evidence for celld/workerd and Void's declarations is the pinned
[source inventory](compat.md#sdk-and-platform-inventory). Hosted binding availability
is documented in Cloudflare's [binding catalog](https://developers.cloudflare.com/workers/runtime-apis/bindings/),
with separate [D1](https://developers.cloudflare.com/d1/),
[R2](https://developers.cloudflare.com/r2/), and
[Durable Objects](https://developers.cloudflare.com/durable-objects/) references.

| Feature | fogd v0 | celld standalone | workerd standalone | Void SDK / Platform | Cloudflare hosted |
| --- | --- | --- | --- | --- | --- |
| HTTP Workers / Void server routes | Yes; hello, notebook, and guestbook tested | Yes | Yes | SDK + Vite build | Yes |
| D1 database backend | Partial; one DB/app, primary sessions | Yes; primary-only sessions | Partial; client, no DB server | SDK / Drizzle | Yes |
| SQL-backed Durable Objects | Yes; notebook tested | Yes | Yes; local storage | SDK | Yes |
| R2 object storage | Partial; approved additions and browser put/get tested, multipart not portable | Partial; multipart handles process-local | Partial; client needs backend | Storage SDK | Yes |
| KV | No; adapter rejects it | Yes | Partial; client needs backend | SDK/config | Yes |
| Queues | No; adapter rejects them | Yes | Partial; needs broker | SDK/config | Yes |
| Workflows | No; adapter rejects them | Yes | Partial; needs execution backend | Config passthrough | Yes |
| Cron scheduling | No; adapter rejects it | Yes; fleet scheduler | Partial; external scheduler | SDK/config | Yes |
| Static assets | Partial; native React pages, CSS and split client JS tested | Yes | Partial; configure asset service | Vite / Platform routing | Yes |
| Cross-app service bindings / RPC | No; adapter rejects them | Partial; RPC boundary restrictions | Yes | Config passthrough | Yes |
| Workers AI | No | No | Partial; client, no inference backend | SDK/config | Yes |
| Hyperdrive | No | No | Partial; client, no managed pool | Config / Platform | Yes |
| Workers-for-Platforms dispatch namespaces | No | No | No | Platform depends on it | Yes |
| Dynamic worker loading | No; not exposed to apps | Yes | Yes | Not required by fogd's Void adapter | Yes |
| Analytics Engine | No | No | Partial; needs analytics backend | Platform usage pipeline | Yes |

The [accounts fixture](../examples/accounts/README.md) qualifies native Void email/password
auth with an explicit scrypt adapter, generated SQL, and admin-supplied private
configuration. Other providers and production auth operations remain unqualified.

The [native Void guestbook](../examples/guestbook/README.md) also qualifies typed
forms, page loaders, and client calls across local development and fogd deployment.
These SDK capabilities come from Void. They do not establish full SDK or framework
adapter support.

Cloudflare's dispatch product has its own
[Workers-for-Platforms contract](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/).
Dynamic loading in a standalone runtime does not implement that contract. The
[fogd adapter](../packages/runtime/src/artifact.mjs) is the authority for admitted
configuration; unsupported nonempty declarations fail explicitly.

The [guestbook transfer profile](../examples/guestbook/TRANSFER.md) qualifies bounded
logical export/restore of messages and referenced attachment bytes. It requires a
local maintenance window; installation recovery is covered separately by the [stopped backup guide](recovery.md); hosted migration remains unqualified.

## Deployment and operations

fogd evidence comes from the [controller](../packages/platform/src/controller.mjs),
[Compose stack](../compose.yaml), [acceptance script](../scripts/platform-smoke.mjs),
[full-stack qualification](../scripts/fullstack-smoke.mjs), and
[recovery script](../scripts/recovery.mjs). Runtime configuration and Void
Platform dependencies remain source-linked in [compat.md](compat.md).

| Feature | fogd v0 | celld standalone | workerd standalone | Void SDK / Platform | Cloudflare hosted |
| --- | --- | --- | --- | --- | --- |
| Run apps on your hardware without Cloudflare APIs | Yes; Docker | Yes; bucket required | Yes; supply services | SDK apps portable; Platform targets Cloudflare | No; managed service |
| Build/deploy a Void project | Yes; `fogd deploy` | Partial; consumes prepared bundle | Partial; needs generated config/services | Yes; `void deploy` | Runtime target; use a deployment tool |
| Multiple apps and hostname routing | Yes; two reserved fleets | Partial; one live entrypoint/fleet | Multiple workers; supply routing/control plane | Platform dispatch | Yes; Workers/WfP |
| Submitter deployment status | Yes; team token, bounded diagnostics | No control plane | No control plane | Platform deploy tracking | Not audited for this exact workflow |
| Exact-artifact approval before publication | Yes; separate submit/admin credentials | No control plane | No control plane | OAuth publish approval exists; scope differs | Not audited for this exact workflow |
| Private app configuration | Partial; admin revisions pinned to approval, plaintext runtime bucket | Text bindings in deployment objects | Text bindings in config | Environment schema / Platform secrets | Not audited here |
| User/project roles and OAuth login | Partial; scoped/revocable deploy credentials + bootstrap admin Basic auth | No control plane | No control plane | Yes; Platform roles/OAuth | Not audited here |
| Replicated durable state and replica-failure recovery | Yes; tested, retain node IDs and disks | Yes; fleet protocol | No distributed storage | Runtime responsibility | Managed durable storage; no fogd recovery test |
| Installation backup/restore | Partial; stopped local stack, exact images, fresh-volume recovery tested | Requires bucket and all node logs/identities | External orchestration required | Operator responsibility | Not audited here |
| Whole-stack high availability | No; bucket/controller single points of failure | Depends on bucket/fleet topology | External orchestration required | Depends on hosting/services | Managed platform; outside this test scope |
| Resource limits | Partial; containers, heap, cells, body size, retained artifacts, pending requests, concurrent uploads | Runtime limits | Runtime/embedder controls | Target-platform limits | Yes; plan/runtime limits |
| Automatic schema rollback | No | No fogd rollback mechanism | No deployment migration runner | Not audited | Not audited |

Void already implements roles and artifact-scoped OAuth publish approval. This is
not evidence of a universal “teammate submits, separate admin approves every release”
policy: project collaborators can have direct deploy capability. See its pinned
[project capabilities](https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/platform/packages/api/src/project-access.ts),
[OAuth approval validation](https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/platform/packages/api/src/auth/oauth.ts),
and [approval routes](https://github.com/voidzero-dev/void/blob/6ef71cfe1b3364e04fd0ec261f7f00bef6aeb99f/platform/packages/api/src/routes/oauth.ts).

Hosted limits differ by service and plan. The comparison intentionally does not
translate fogd's container limits into equivalent hosted quotas; see the official
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

## Keeping the table useful

Update the fogd column whenever the adapter, controller, or acceptance tests change.
A newly admitted binding should name its remaining limitations and link a meaningful
runtime test before it is described as tested. Update upstream columns when changing
the pinned versions, using source evidence in `compat.md`; recheck hosted documentation
and this page's date at the same time. Do not turn an unaudited feature into “No.”

This table is the capability overview. [compat.md](compat.md) owns detailed source
qualifications, [report.md](report.md) owns implementation evidence and open gaps,
and [decisions.md](decisions.md) owns the reasons for the architecture.
