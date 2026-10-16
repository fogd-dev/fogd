# Gemini roadmap review

# fogd Product and Compatibility Roadmap Review

This review evaluates `fogd` v0 based on the repository’s current implementation and pinned upstream audits ([report.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/report.md), [features.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/features.md), [compat.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/compat.md), [platform.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/platform.md)).

---

## 1. Product Promise, Users, and Assumptions to Validate

**Product Promise:** `fogd` is a self-hosted, zero-Cloudflare-account deployment platform for stateful Void applications on owned hardware (from local Docker to a two-node homelab). It guarantees that an audited, immutable build artifact runs with replicated durable state (`celld` + S3-compatible bucket) behind a stateless HTTP ingress (`workerd`), failing closed at build/deploy time whenever an application requests capabilities outside the verified runtime subset ([`translateConfig`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L26-L80)).

### Distinct User Personas
* **Application Developer (Submitter):** Builds Void apps locally and runs [`fogd deploy`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/cli/src/platform.mjs#L30-L36). Expects standard Void SDK primitives (SSR, D1/Drizzle, R2, Durable Objects) to work without needing runtime credentials, S3 keys, or production network access ([`buildArtifact`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/cli/src/local.mjs#L30-L42)).
* **Deployment Approver (Admin):** Reviews pending submissions via the admin UI or [`fogd admin`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/cli/src/platform.mjs#L37-L49), verifying exact SHA-256 digests, binding declarations, and SQL migrations before authorizing activation ([http.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/http.mjs#L53-L57)).
* **Platform Operator (Hardware Owner):** Provisions Docker/homelab hosts, network topology, TLS, and MinIO ([compose.yaml](file:///Users/sgtpooki/code/sgtpooki/fogd/compose.yaml)); allocates fleet slots; maintains coordinated backups across controller metadata, S3 prefixes, and replica volumes; and resolves quarantined slots ([`Controller.init`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L20-L50)).
* **End User:** Interacts with `<app>.<base-domain>` through `workerd` ([gateway.js](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/gateway.js)), expecting durable writes across replica restarts and clean error semantics.

### Assumptions Needing User Validation
1. **Approval ceremony vs. velocity:** Does every code change on every app require a two-step submit-then-approve flow, or should an admin be able to mark trusted apps/tokens for auto-activation after initial slot assignment?
2. **Expected app count vs. RAM budget:** Dedicated two-replica fleets cost two `celld` processes per app ([compose.yaml](file:///Users/sgtpooki/code/sgtpooki/fogd/compose.yaml#L52-L87)). Is the target 2–6 high-value apps on the two-node homelab, or 15–30 small utilities?
3. **Maintenance-window tolerance:** Existing-app activation intentionally pauses routing (`503 App activation paused` in [gateway.js](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/gateway.js#L13)) while applying SQL and reloading replicas ([`Controller.mutate`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L118-L135)). Is brief deploy-time downtime acceptable for target workloads?

---

## 2. Prioritized User Scenarios

Ordered by product value, focusing on user outcomes rather than binding names:

1. **[P1] Launch a Full-Stack Stateful App from Zero (Verified in v0):** A developer initializes a Void app with relational data, file blobs, and coordinated state (`examples/notebook`), runs `fogd deploy`, and an admin approves it.
   * *Success:* Controller claims a free slot via conditional S3 write (`IfNoneMatch: '*'` in [`Backend.claim`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/backend.mjs#L14-L25)), applies migrations, verifies replica versions, and serves `<app>.<domain>`.
   * *Failure:* Unsupported configs or path escapes fail immediately during local staging ([`stageArtifact`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L109-L151)).
2. **[P2] Evolve an Existing App’s Storage and Schema Over Time (Current v0 Blocker):** A live app adds a new feature requiring a new SQL migration *and* a newly declared storage resource (e.g., adding object storage or a second database to an existing app).
   * *Success:* Admin reviews the resource diff alongside the SQL migration; existing data remains intact and new bindings become active.
   * *Failure:* Currently fails in v0 because [`Controller.compatible`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L60) rejects any change where `!isDeepStrictEqual(app.resources, release.resources)`.
3. **[P3] Survive Single-Host Reboot or Replica Crash Without Data Loss (Verified Locally):** One homelab node reboots while users are reading and writing entries.
   * *Success:* `workerd` routes around the unhealthy replica ([gateway.js](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/gateway.js#L28-L37)); `celld-supervisor` enforces the lease-expiry wait ([celld-supervisor.sh](file:///Users/sgtpooki/code/sgtpooki/fogd/docker/celld-supervisor.sh#L9-L23)) before rejoining with the same `CELLD_NODE` and volume; acknowledged writes persist ([recovery.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/scripts/recovery.mjs#L49-L70)).
   * *Failure:* An in-flight write to a dying replica returns `502` without silent retry ([gateway.js](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/gateway.js#L34-L36)).
4. **[P4] Recover Cleanly from a Broken Migration or Bad Release (Verified for Unapplied SQL):** An approved release fails mid-migration or fails replica health checks.
   * *Success:* Route stays `paused` (503) so mixed versions never serve; [`Controller.reconcile`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L79-L94) inspects `d1_migrations` via [`Backend.applied`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/backend.mjs#L63-L74); sibling apps stay `200 OK`; a corrected artifact unblocks the app ([platform-smoke.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/scripts/platform-smoke.mjs#L60-L71)).
   * *Failure:* If valid SQL applied destructive schema changes before code failed, operator restores a coordinated pre-deploy snapshot.
5. **[P5] Manage Secrets and Scoped Teammate Identity (Proposed):** An operator injects runtime API keys (e.g., SMTP/webhook secrets) without checking them into `wrangler.json` `vars`, and issues revocable per-teammate deploy tokens.
   * *Success:* Submissions record the individual teammate identity rather than hardcoded `'team-token'` ([http.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/http.mjs#L33)); secrets are injected at activation time without appearing in developer build artifacts.
   * *Failure:* Revoked tokens get `401`; missing required secrets block activation.
6. **[P6] Backup, Restore, and Decommission App Slots (Proposed):** An operator backs up the stack before hardware maintenance, restores onto a replacement disk, or retires an old app to free `slot-1` for a third app.
   * *Success:* Coordinated snapshot captures controller state, S3 prefix, and replica logs atomically; slot release archives state and removes `fogd-owner.json` safely.
   * *Failure:* Mismatched restore triggers quarantine (`app.quarantined = true` in [`Controller.init`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L35-L47)) rather than silently corrupting another app’s prefix.
7. **[P7] Sustain Real-Time Collaborative Sessions and Large Uploads (Proposed):** Users collaborate over WebSockets/SSE or upload multi-megabyte media files.
   * *Success:* `workerd` streams upgrades/bodies without buffering truncation; uploads succeed regardless of which replica handles each request.
   * *Failure:* If R2 multipart handles remain process-local in `celld` ([compat.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/compat.md#L23)), round-robin ingress across replicas breaks multi-part resumption unless routed sticky or patched upstream.
8. **[P8] Execute Scheduled Maintenance and Queued Background Jobs (Proposed):** An app runs nightly cleanup jobs (Cron) or asynchronous post-request tasks (Queues/Workflows).
   * *Success:* Background handlers execute on the active release and pause/drain before schema migrations begin.
   * *Failure:* Background workers firing old code while [`Controller.mutate`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L131-L134) runs migrations.

---

## 3. Practical Compatibility Tiers

| Tier | Scope | Verified / Practical Target | Work Classification |
| :--- | :--- | :--- | :--- |
| **1. Source & Config Acceptance** | `wrangler.json` / Void config keys, flags, module format | Admit KV, multi-D1, Queues, Cron, Workflows; lift single-file JS restriction (`codeSplitting: false` in [build.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/cli/src/build.mjs#L15)) | **Adapter:** [`translateConfig`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L26-L80), [`receiveArtifact`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/manifest.mjs#L15-L54). **Upstream `celld` patch:** multi-file ESM collector in `deploy.rs`. |
| **2. Observable API Semantics** | Runtime behavior of D1, R2, DO, KV, Cache, Node compat | Primary-only D1 sessions; SQLite DOs + alarms; KV; streaming. Cache API is always-miss (`cache.js`); R2 multipart is process-local (`r2_ops.rs`, [compat.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/compat.md#L23-L32)) | **Upstream `celld` patch:** bucket-backed R2 multipart state. **Adapter/Docs:** document primary-only D1 bookmark and Cache no-op. |
| **3. Lifecycle & Failure Semantics** | Deploys, replica crashes, leases, background draining | Stable `CELLD_NODE` + lease wait ([celld-supervisor.sh](file:///Users/sgtpooki/code/sgtpooki/fogd/docker/celld-supervisor.sh)); HTTP pause during migration; WebSocket reconnect on failover | **Upstream `celld` patch or Adapter:** admin endpoint to pause/drain Cron, Queues, and DO Alarms during deploy. |
| **4. Platform & Control Plane** | Provisioning, WfP dispatch, OAuth, secrets, logs, Hyperdrive | Custom approval controller replaces Void Platform’s WfP/Cloudflare API control plane ([platform.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/platform.md#L10-L20)) | **Dedicated `fogd` service:** secret store, log tailing, slot lifecycle, TLS/Caddy ingress sidecar. |
| **5. Irreducible Hosted Properties** | Global edge anycast, DDoS scrubbing, multi-region quorum, hostile isolation | **Out of scope.** Two owned hosts cannot replicate global CDN POPs, instant elastic scale, or hostile multi-tenant V8 sandboxing | **Non-goal:** state explicitly in [features.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/features.md) so users never confuse `fogd` with an untrusted public PaaS. |

---

## 4. Sequenced Roadmap Comparison

| Strategy | Pros | Cons / Risks | Verdict |
| :--- | :--- | :--- | :--- |
| **A. Operational Reliability, Lifecycle & Resource Evolution First** | Unblocks day-2 app updates (`Resource identities changed`), prevents data loss via coordinated backups, decouples `workerd` routing from controller uptime. | Delays new bindings (Queues/Cron) by one milestone. | **Phase 1 (Recommended Next)** |
| **B. Homelab Two-Node Deployment First** | Validates real network latency, TLS, and cross-host failure early. | Deploying to real hardware *before* backup/restore tooling, scoped S3 credentials, and binding evolution risks stranded slots and data loss. | **Phase 2** |
| **C. Broader Bindings First (KV, Queues, Cron, Workflows)** | Expands the set of Void apps that compile and run. | Adding bindings to existing apps is currently impossible ([`Controller.compatible`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L60)), and background bindings violate the HTTP deploy pause gate. | **Phase 3** |
| **D. Larger Architectural Changes (Shared Fleet / Dynamic Dispatch)** | Reduces container count for many small apps. | High complexity; couples app deployments or requires building a custom WfP layer ([platform.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/platform.md#L10-L17)). | **Phase 4 (Only if slot count > ~10)** |

### Proposed Roadmap & Exit Criteria
1. **Milestone 7 — Day-2 App Lifecycle & Operational Safety:** Resource evolution, multi-D1 + KV admission, secret injection, slot release/decommission, `workerd` route caching, and coordinated backup/restore. *Exit criteria:* Automated smoke tests pass for binding upgrades on a live app, full backup/restore from quarantine, and slot recycling.
2. **Milestone 8 — Two-Node Homelab & Security Hardening:** Split Compose/deployment across two hosts over encrypted peer networking, TLS termination, per-slot S3 credentials, and WebSocket/streaming qualification. *Exit criteria:* `platform-smoke` and `recovery` pass across two physical nodes with one host powered off.
3. **Milestone 9 — Background Execution & Upstream `celld` Enhancements:** Admit Cron, Queues, and Workflows with deploy-time pause/drain hooks; upstream patches for multi-module ESM collection and distributed R2 multipart state. *Exit criteria:* Background tasks drain cleanly before SQL migrations and resume after activation.

---

## 5. Recommended Next Milestone: Day-2 App Lifecycle & Operational Safety

**Measurable User Outcome:** A developer can add new bindings (KV, additional D1 databases, R2, DO classes) and runtime secrets to an already-deployed app without wiping its state, and an operator can snapshot, restore, or recycle app slots with a single CLI command.

### Scope
* **Included:**
  1. **Additive Resource Evolution:** Update [`Controller.compatible`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L57-L64) to allow adding new bindings (`d1_databases`, `r2_buckets`, `durable_objects`, `kv_namespaces`) while surfacing a clear resource diff in `/v1/admin` and preventing accidental deletion/renaming of existing bindings.
  2. **KV & Multi-D1 Admission:** Lift the single-D1 limit in [`artifact.mjs:127`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L127) and [`manifest.mjs:38`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/manifest.mjs#L38), and admit `kv_namespaces` in [`translateConfig`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L26-L80).
  3. **Coordinated Backup, Restore, and Slot Decommission:** Add `fogd backup`, `fogd restore`, and `fogd slot release` commands that pause routing, snapshot/restore controller state + bucket prefix + replica state, and safely clear `fogd-owner.json`.
  4. **Ingress Route Caching & Scoped Tokens:** Cache active routes briefly in [`gateway.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/gateway.js#L7-L16) (invalidated on controller pause) so a controller restart does not cause immediate 503s, and support named submitter tokens + secret bindings.
* **Excluded:** Queues/Cron/Workflows, two-host network provisioning, upstream `celld` Rust changes, and dynamic container orchestration.

### Acceptance Scenarios
1. **Live Binding Upgrade:** Approve `notebook` v1, write D1/R2/DO entries, then deploy `notebook` v2 adding a `kv_namespaces` binding and a second D1 database. Verify the admin UI flags the added resources, approval succeeds, v1 data remains intact, and v2 reads/writes KV and the second D1 database.
2. **Quarantine Disaster Recovery:** Take a `fogd backup`, delete the controller’s `state.json` and restart `controller` (verifying the slot enters `quarantined` state per [`Controller.init`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L35)), run `fogd restore`, and verify the app returns to `200 OK` with all data preserved.
3. **Slot Recycling:** Decommission `hello` from `slot-1` after archiving, then submit and approve a third app (`wiki`) into `slot-1`.

### Decisions Needed from the User
1. Should additive resource changes require an explicit `--allow-resource-change` confirmation flag on `fogd admin approve`, or is displaying the diff in the admin view sufficient?
2. Should `fogd slot release <app>` require exporting a local archive tarball before deleting the S3 prefix and `fogd-owner.json`?
3. Should runtime secrets be managed via `fogd secret set <app> <key>` on the controller and merged into the `celld` deployment config at activation time?

**Opportunity Cost & Reversal Evidence:** Choosing this milestone defers physical two-node homelab setup and background bindings (Queues/Cron). If you already have a target Void app blocked *today* on Cron/Queues, or if your immediate priority is getting the current static sample apps running on the two homelab machines with TLS, we should swap Phase 1 and Phase 2.

---

## 6. Architectural Traps to Guard Against

1. **Frozen Resource Declarations:** [`Controller.compatible`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L60) enforces `isDeepStrictEqual(app.resources, release.resources)`. Any real app that adds a binding or new DO migration tag after its initial launch is permanently blocked from deploying.
2. **Replica Identity + Volume + Address Coupling:** `celld` ties replication witness logs to `CELLD_NODE` and `--advertise` ([compose.yaml](file:///Users/sgtpooki/code/sgtpooki/fogd/compose.yaml#L57-L58), [decisions.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/decisions.md#L80-L105)). Renaming a node, swapping disks between `a` and `b`, or restarting faster than `CELLD_TTL_MS` ([celld-supervisor.sh](file:///Users/sgtpooki/code/sgtpooki/fogd/docker/celld-supervisor.sh#L9)) causes witness rejection or split-brain.
3. **Background Events Bypassing HTTP Pause:** [`gateway.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/gateway.js#L13) only gates external HTTP requests when `target.state !== 'active'`. Once Cron, Queues, Workflows, or DO Alarms are enabled in `celld`, they execute inside the replicas while [`Controller.mutate`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L131-L134) is running D1 migrations, creating schema/code race conditions unless `celld` drains background triggers before migration.
4. **Non-Atomic Schema + Code Rollback:** Migrations run against the live D1 database *before* `backend.publish` updates the worker ([controller.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L132-L134)). Destructive SQL (renaming/dropping columns) cannot be rolled back by redeploying the previous worker artifact; coordinated pre-deploy snapshots are mandatory.
5. **Load-Balanced Ingress vs. Process-Local Runtime State:** [`gateway.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/gateway.js#L27) alternates requests between replicas (`next++ % 2`). Because `celld` keeps R2 multipart upload handles in process memory (`r2_ops.rs`, [compat.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/compat.md#L23)), multi-request multipart uploads will fail across replicas until `celld` persists upload state or `workerd` pins sessions.
6. **Cross-App Service Boundaries:** `celld` JS RPC stubs and `AbortSignal` cannot cross isolates or nodes ([compat.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/compat.md#L26)). Cross-app communication across separate fleets must be restricted to standard HTTP fetches routed via `workerd`.
7. **Shared Bucket Credentials & Internal Operator Port Exposure:** Every replica container currently receives root MinIO credentials for the entire `fogd` bucket ([compose.yaml](file:///Users/sgtpooki/code/sgtpooki/fogd/compose.yaml#L2-L7)) and listens on `0.0.0.0:8081` (`--internal-listen`, [compose.yaml](file:///Users/sgtpooki/code/sgtpooki/fogd/compose.yaml#L58)). Any SSRF inside an app can trigger `http://127.0.0.1:8081/reload` or read another slot’s S3 prefix (including plaintext `vars`). Homelab deployment must scope S3 IAM policies per prefix.
8. **Controller & Bucket Single Points of Failure:** `workerd` fetches `http://controller/internal/route` on *every* incoming request ([gateway.js](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/gateway.js#L9)). If the controller restarts, all live apps immediately return `503 Routing unavailable`.
9. **Conformance Testing Without Cloudflare APIs:** Passing tests against local `celld`/`workerd` proves self-consistency, not hosted Cloudflare equivalence. Without calling Cloudflare APIs, `fogd` should build a standalone behavioral conformance suite testing documented edge cases (D1 batch atomicity, DO storage ordering, R2 conditional headers, asset precedence) and record intentional divergences in [compat.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/compat.md).

---

## 7. Product-Focused Alternative (If User Assumptions Differ)

If the actual target user is a **solo homelab developer** deploying 10+ personal Void tools rather than a multi-person team requiring formal submit/approve separation:
* **Drop mandatory approval gates by default:** Make `fogd deploy` build, upload, migrate, and activate in one command using an admin token, keeping two-step approval as an opt-in flag (`--stage-only`).
* **Support single-replica "light" slots:** Allow operators to configure 1-replica slots for low-criticality personal apps alongside 2-replica HA slots, halving container and memory overhead on a two-node homelab.
* **Prioritize developer ergonomics first:** Build `fogd logs <app>`, `fogd d1 execute <app>`, and automatic local/homelab HTTPS via Caddy before investing in multi-role governance.
