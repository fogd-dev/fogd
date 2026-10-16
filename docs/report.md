# fogd implementation report

fogd is a local, self-hosted deployment platform for the supported subset of Void
apps. workerd handles hostname routing. Each complete app and its stateful bindings
run in a separate two-replica celld fleet. A teammate submits an immutable build;
an admin reviews and approves its exact digest. No Cloudflare account or API is used.

## What works

| Milestone | Result and reproduction |
| --- | --- |
| 1. Compatibility and architecture | Source-pinned [matrix](compat.md), [architecture](architecture.md), and independent reviews; see README milestone 1 |
| 2. Hello world | Actual `void init` D1 starter builds through Vite and serves `/api/posts` through workerd/celld/MinIO; see README quickstart |
| 3. Realistic app | Notebook uses D1, R2, a SQL-backed Durable Object, and two SQL migrations; recovery script checks both replica failures and workerd restart |
| 4. CLI | `fogd up` creates private local credentials and starts Docker; `fogd deploy` builds in a Void app and submits its artifact |
| 5. Platform design | Claude and Gemini independently reviewed the selected custom approval gate; original proposals and responses are preserved in `reviews/` |
| 6. Platform | Two apps, exact subdomain routing, Basic-authenticated admin UI/CLI, immutable-digest approval, rejection, failure/retry, and runtime resource limits |

The live Docker acceptance test passed for hello and notebook side by side. It
verified no route before approval, rejection, submitter/admin separation, wrong-digest
rejection, artifact-path rejection, D1/R2/DO writes, isolated SQL activation failure,
corrected resubmission, and controller/workerd restart persistence. Unit tests cover
interrupted activation, migration reconciliation, and controller metadata loss.

The initial direct runtime recovery test passed with both replicas force-stopped in
turn, a write between rejoining/failing replicas, and a workerd restart. The same recovery check passed on the platform fleet. A separate clean checkout
with fresh Docker volumes passed installation, startup, both CLI builds, and the
complete approval smoke test; details are recorded in [notes](notes.md).
Run `node scripts/platform-smoke.mjs` on a fresh stack and `node scripts/recovery.mjs`
after approving notebook second. The README contains all six reproduction sections.

## Runtime boundary and corrections to the initial assumptions

Splitting a worker's native bindings across workerd and celld would need an API
bridge with significant semantic gaps. Keep complete apps in celld and use native
HTTP external services in workerd. Both runtimes have dynamic worker loading, but
neither standalone runtime supplies Cloudflare Workers-for-Platforms dispatch
namespaces. celld explicitly rejects AI and dispatch bindings in its config parser.

celld has one live deployed entrypoint per fleet prefix, so two apps need two fleets.
Its single-entry `no_bundle` collector does not upload Vite JavaScript chunks: fogd
disables worker code splitting during the build. No upstream runtime patch was needed.

Bucket-backed state does not mean replica disks and names are disposable. A recovery
experiment failed when a restarted replica received a random new identity; witness
requests for the old log were rejected. Retaining the original node IDs, peer
addresses, and log volumes recovered the acknowledged data. Stable IDs plus a
conservative lease-expiry delay are now the default. See ADR 005 and its source review.

## Limits and open gaps

- This is for trusted, reviewed apps. celld's internal operator interfaces and shared
  local bucket credentials do not form a hostile tenant sandbox. Fleet networks help
  separate apps, but storage credentials must be scoped before crossing trust boundaries.
- Two static app slots are provisioned. There is no scheduler, autoscaling, automatic
  slot recycling, certificate/DNS provisioning, or public production deployment.
- MinIO and the controller are single points of failure. Routing returns 503 when
  the controller is unavailable. Preserve coordinated controller, bucket, and replica
  backups. Lost controller metadata quarantines occupied slots; restore it explicitly.
- Only the adapter's validated configuration subset is accepted: string variables,
  one D1 database per app, R2, local SQL-backed Durable Objects, and static assets.
  Resource declarations are frozen on first approval; adding bindings needs a future
  explicit resource-change operation.
  Unsupported AI, WfP, Hyperdrive, queues/workflows, cron, cross-app service bindings,
  auth-managed migrations, and other nonempty declarations fail rather than disappear.
- R2 multipart handles are process-local upstream. Examples exercise ordinary puts
  and gets. Streaming, WebSockets, asset-heavy applications, and remote two-host
  deployment have not been qualified by these tests.
- Approval pauses routing. Schema changes and deployment are not one transaction;
  there is no automatic rollback. Applied migration hashes are immutable. A failed,
  unapplied migration may be corrected after authoritative ledger reconciliation.
- Basic auth is appropriate for this loopback HTTP demo. Public use requires TLS,
  scoped teammate credentials, audit retention, and stronger identity management.
- CPU/memory/V8/request-size limits are coarse. There is no per-request CPU billing,
  hostile-code isolation, total artifact-storage quota, or automatic artifact pruning.
- The npm package remains unpublished. Use the workspace CLI or invoke its script
  with `FOGD_HOME` pointing at this checkout. Future package names use `@fogd/`.

## Decisions in one place

1. Keep complete apps and native stateful bindings in celld; use workerd for ingress.
2. Give each app a separate fleet/prefix and two persistent replicas.
3. Build pinned MinIO source in Docker because upstream images were unavailable.
4. Disable worker code splitting to match celld's single-entry artifact collector.
5. Keep node identity, advertised address, and log volume together across restarts.
6. Use a small approval controller with conditional bucket ownership fences and
   static workerd backend bindings. Pause before activation, verify both versions,
   reconcile migration ledgers, and require explicit retry after interruption.

The [feature table](features.md) compares the implemented platform with its runtimes,
Void, and hosted Cloudflare. Read [decisions.md](decisions.md) for context, alternatives, and reasons, and
[platform.md](platform.md) for the deployment state machine and operational scope.
