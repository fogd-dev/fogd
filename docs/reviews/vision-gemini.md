# Gemini vision and roadmap review

### 1. Vision & Void DX vs. Container Host

The revised north star in [vision.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/vision.md) successfully separates **product purpose** from both pilot context (FilOz demos) and implementation dependencies (`celld`, `workerd`).

* **Distinction from a container host:** Against Coolify, `fogd`'s core promise is **application-defined, zero-provisioning stateful infrastructure**. On a container host, adding a database, object bucket, or stateful coordinator requires provisioning separate services and wiring credentials. In `fogd`, an application declares its needs in code and receives isolated, lifecycle-managed resources automatically via [`translateConfig`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L26-L80).
* **Where Void's actual DX is still underspecified:** Inspecting Void's implementation in [index.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/node_modules/void/dist/index.mjs) shows that Void's value is not merely "server routes + Drizzle + UI," but four tightly coupled build/runtime mechanisms:
  1. **Source-inferred bindings ([`mergeWorkerBindings`](file:///Users/sgtpooki/code/sgtpooki/fogd/node_modules/void/dist/index.mjs#L4703-L4915)):** Void scans imports (`void/db`, `void/storage`, `void/auth`, `durable-objects/`, WebSockets) and synthesizes `wrangler.json` bindings and migration tags automatically.
  2. **End-to-end typed client ([`compileBrowserClient`](file:///Users/sgtpooki/code/sgtpooki/fogd/node_modules/void/dist/index.mjs#L2878-L2882), [`compileWorkerClient`](file:///Users/sgtpooki/code/sgtpooki/fogd/node_modules/void/dist/index.mjs#L2897-L2962)):** Generates `.void/routes.d.ts` and typed `void/client` fetch/stream/auth helpers.
  3. **Validated environment schemas ([`envSchemaPlugin`](file:///Users/sgtpooki/code/sgtpooki/fogd/node_modules/void/dist/index.mjs#L1456-L1620)):** Generates `.void/env.d.ts`, validates `env.ts` at build and runtime, and separates public client variables from required server secrets.
  4. **SSR/Pages asset manifest wiring ([`createClientAssetTags`](file:///Users/sgtpooki/code/sgtpooki/fogd/node_modules/void/dist/routing-assets-VkrKIbxE.mjs#L85-L137)):** Loads `/.vite/manifest.json` through `env.ASSETS.fetch()` at runtime to inject CSS and module preloads.

To preserve Void's actual DX, `fogd` must treat Void's build-time outputs for these four mechanisms as first-class contracts rather than unexpected config keys.

---

### 2. Concreteness of G1–G5, Decision Filter, and Product Signals

**Assessment of G1–G5:**
G2, G3, and G5 are well-bounded, but **G1** is currently too broad ("needed assets and app authentication work" leaves ambiguous whether Void's built-in `void/auth` and all UI framework adapters are in scope), and **G4** ("Retain freedom to move code and data") could easily balloon into building universal schema/storage translators unless bounded to logical export/import of supported primitives.

**Proposed 3-Gate Decision Filter (to reject unrelated work):**
1. **Layer Ownership Gate:** Does this belong in `fogd`'s deployment/operations plane, or does it reimplement an upstream runtime (`celld`/`workerd`) or SDK (`Void`) responsibility? *(Rejects custom DB proxies, custom bundlers, or standalone app-generation tools.)*
2. **Complete-App Lifecycle Gate:** Does this close a blocker in the end-to-end loop (`build -> preflight -> approve -> migrate -> serve -> backup/export`) for an already-selected profile, rather than adding an isolated binding name? *(Rejects adding new bindings before UI assets, secrets, additive resources, and backups work.)*
3. **Single-Operator Recoverability Gate:** Can one operator on a two-node homelab or standard Kubernetes cluster back up, restore onto fresh disks, and diagnose this feature without external cloud APIs?

**Measurable Product Signals (no invented performance targets):**
* **Zero-provisioning delta (G1):** Number of infrastructure manifests or manual DB/bucket provisioning commands an app author must run when adding a supported capability (`0` beyond app source and SQL files).
* **Preflight attribution rate (G1, G4):** 100% of unsupported Void/Wrangler config keys fail locally during [`stageArtifact`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L109-L151) with explicit attribution (`fogd` adapter policy vs. `celld` runtime limitation), never silently succeeding or failing halfway through activation.
* **Clean-slate recovery fidelity (G2, G3):** After destroying all Docker volumes in [compose.yaml](file:///Users/sgtpooki/code/sgtpooki/fogd/compose.yaml#L123-L130), following the documented restore procedure recovers 100% of acknowledged D1 rows, R2 objects, DO SQLite state, migration ledgers, and slot ownership markers without manual S3/JSON editing or `no complete true witness` errors ([recovery.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/scripts/recovery.mjs#L68-L69)).
* **Zero-fork portability diff (G4):** Line diff in application source (`src/`, `routes/`, `pages/`, `db/`, `void.config.ts`) between a `fogd deploy` build and an offline Cloudflare-target Vite build (`0` lines modified;hosted execution explicitly labeled unverified).

---

### 3. Stress-Test of M7–M12, Code-Grounded Blockers, and Next Spec

**Claims the current runtime split and build output prevent us from honestly making today:**
1. **`void/env` server secrets and `void/auth` cannot pass `fogd`'s current build/artifact validator:**
   * When an app uses `env.ts` (`void/env`) with required server keys or `void/auth`, Void's [`mergeWorkerBindings`](file:///Users/sgtpooki/code/sgtpooki/fogd/node_modules/void/dist/index.mjs#L4709-L4723) forbids placing server keys in plaintext `worker.vars` during `vite build` and emits `secrets: { required: [...] }` into `dist/ssr/wrangler.json`.
   * [`translateConfig`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L5-L6) omits `secrets` from `supported` and `generated`, immediately throwing `Unsupported binding/config: secrets` ([artifact.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L28-L30)). Furthermore, because `celld` only receives environment bindings via `vars` ([compat.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/compat.md#L34)), `fogd` currently has no way to inject required server secrets at activation time without exposing them in the submitted artifact.
2. **Void's built-in `void/auth` (Better Auth) does not use `db/migrations/*.sql`:**
   * Void compiles Better Auth schemas into `.void/better-auth-schema.ts` and runs auth migrations through internal Worker HTTP endpoints `/__void/migrate` and `/__void/migrate/auth` ([index.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/node_modules/void/dist/index.mjs#L2464-L2499)).
   * `fogd` only executes `celld d1 migrations apply` against `db/migrations/*.sql` ([backend.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/backend.mjs#L60-L62)), throws `ENOENT` in [`stageArtifact`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L129-L132) if a D1-bound auth app has no `db/migrations` folder, and blocks `/__void/*` at ingress ([gateway.js](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/gateway.js#L20)).
3. **Single-module worker bundling only targets native `void_worker`, not Void framework adapters:**
   * [build.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/cli/src/build.mjs#L14-L16) sets `codeSplitting: false` only when `name === 'void_worker'`. Void's Class A framework adapters (`react-router`, `tanstack-start`, `vinext`) name their worker Vite environment `"ssr"` or `"rsc"` ([index.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/node_modules/void/dist/index.mjs#L5227-L5230)), emitting split chunks that fail [`stageArtifact`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L113-L115).
4. **Submitters cannot inspect deployment status without admin credentials:**
   * M7 and U1/U2 state that a developer can inspect deployment status and diagnose failures without admin credentials. In [http.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/http.mjs#L31-L39), `FOGD_DEPLOY_TOKEN` is accepted *only* on `POST /v1/deployments`; every GET route requires `FOGD_ADMIN_PASSWORD`.

**Milestone sequence and sizing critique (M7–M12):**
* **M7 is too large** as a single slice if it combines UI qualification, auth, secrets, schema updates, and multi-user identity.
* **M10 (Application growth) is sequenced too late relative to M9:** Currently, [`Controller.compatible`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L60) rejects any deployment where `resources` is not `isDeepStrictEqual` to the first deployment. Freezing an app's bindings after v1 will immediately break real pilot iteration in M7–M9. **Pull additive resource changes (adding R2/DO/D1 to an existing app) ahead of M9**, leaving slot retirement/reclamation in M10.
* **M8 (Recoverable installation)** must explicitly step from a **quiesced/stopped cold backup** first; live hot backup across controller JSON, MinIO, and dual `celld` SQLite/witness volumes is a distributed consensus problem, not a simple script.
* **M11** should split into two independent gates: background event lifecycles (Queues/Cron/Workflows drain & idempotency) vs. live collaborative WebSockets.

**Recommended smallest coherent next spec (M7a):**
Prove **one complete full-stack Void starter** locally through build, approval, update, and status inspection:
1. Qualify **native Void `pages/` + `routes/` + `void/client`** (keeping `void_worker` single-module output) and verify `env.ASSETS` serves `dist/client` and `/.vite/manifest.json` through `celld`.
2. Add **operator-scoped secret injection** and `secrets.required` validation in [`translateConfig`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L26-L80) so `void/env` server secrets are supplied by the controller at `celld deploy` time without appearing in uploaded or downloadable artifacts.
3. Support **one explicit app-auth path** (either Drizzle session tables in `db/migrations/` or controller-invoked `/__void/migrate/auth` during activation).
4. Add a deploy-token-readable `GET /v1/deployments/:id` status endpoint in [http.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/http.mjs) so submitters can watch activation steps and errors without admin credentials.

---

### 4. Platform Capability vs. Pilot Policy & Tensions

* **Platform capability vs. pilot policy:** Immutable artifact digests, preflight validation, migration ledger reconciliation, secret injection, and backup/export are universal platform capabilities. Mandatory two-person approval on every release, static 2-slot ceilings, and shared team bearer tokens are pilot/installation policies.
* **Promises in tension:**
  1. **Mandatory Approval (G3) vs. Integrated Solo/Homelab DX (G1/G2):** Requiring `fogd deploy` followed by `fogd admin approve <id> <digest>` ([platform.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/cli/src/platform.mjs#L30-L49)) adds ceremony for a solo operator. *Resolution:* Preserve the immutable `pending -> activating -> active` state machine in [`Controller.mutate`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L95-L147), but allow an installation policy or admin-scoped deploy token to auto-trigger approval upon submission.
  2. **Void-Native Ergonomics (G1) vs. Non-Void Workers Import (G4/U10):** Void relies on `.void/` virtual modules and `/__void/*` routes; raw Workers projects do not. Keep `fogd`'s core contract anchored on the staged Worker bundle + canonical `wrangler.json` subset ([artifact.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs)), with Void's Vite builder as the primary frontend.
  3. **`celld` Replicated Storage (G2) vs. Data Portability (G4):** `celld` couples D1/DO state to fleet prefixes and node-ID witness logs ([decisions.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/decisions.md#L80-L104)). Physical volume backups (M8) cannot satisfy G4; G4 requires logical SQL/object export/import.

---

### 5. Opportunities Brainstorm & Critique of Existing List

**Critique of existing list ([roadmap.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/roadmap.md)):**
* **Keep (strictly deferred):** *Optional Filecoin storage* (keep under G5 as a deferred storage/recovery target; do not design or investigate while upstream is in flight) and *Better generated-app guidance* (scope strictly to deterministic CLI preflight diagnostics).
* **Defer indefinitely / drop from near-term framing:** *Hosting customer extensions* (contradicts `celld`'s trusted-code boundary in [report.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/report.md#L55)), *Native compute or AI services* (erases the boundary with Coolify), and *App catalog/templates* (premature maintenance burden). *Isolated preview environments* must wait until static slots ([compose.yaml](file:///Users/sgtpooki/code/sgtpooki/fogd/compose.yaml#L8-L9)) are replaced by dynamic fleet lifecycles.

**Three opportunities that strengthen the vision:**
1. **Deterministic Preflight & Portability Report (`fogd preflight` — Target: M7):**
   * *Why:* Strengthens G1 and G4 (and serves coding agents) by inspecting Void's generated `wrangler.json`, `env.ts`, and SQL migrations locally before upload—reporting supported bindings, required operator secrets, rejected bindings, and known semantic gaps (e.g., process-local R2 multipart in [compat.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/compat.md#L23)).
2. **Logical Application State Bundle (`fogd data export / import` — Target: M8/M10):**
   * *Why:* Resolves the tension between G2 (`celld`-specific witness logs) and G4 (portability) by exporting D1 tables as SQL, R2 objects/metadata, and DO SQLite state into a target-agnostic archive that can seed local dev or migrate across installations.
3. **Policy-Driven Auto-Approval for Single-Player Installations (Target: M7/M8; Defer full OAuth RBAC):**
   * *Why:* Preserves one-command `fogd deploy` ergonomics for solo/homelab users (G1/G2) while running the exact same digest verification and migration reconciliation gates used in team-approval mode (G3).

---

### 6. Contradictions, Premature Architecture, Hidden Costs, and Recommendations

* **Contradictions & Overclaims:**
  * *Credential exposure in artifacts:* [product.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/product.md) (U2) states *"Credentials never appear in downloadable artifacts/logs,"* yet `celld` currently receives all env vars via `wrangler.json` `vars`, and `GET /v1/deployments/:id/artifact` ([http.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/http.mjs#L41-L45)) returns the entire `wrangler.json` in plaintext.
* **Premature Architecture Decisions:**
  * *Static container-pair slots wired into `workerd` startup:* [serve.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/serve.mjs#L9-L29) bakes `FOGD_SLOTS` into `gateway.capnp` at process start, and each app consumes two dedicated `celld` containers and volumes ([compose.yaml](file:///Users/sgtpooki/code/sgtpooki/fogd/compose.yaml#L52-L87)). Carrying static slot definitions into M9 (Kubernetes/homelab) will force gateway restarts and manual container provisioning for every new app.
* **Hidden Operating Costs:**
  * *Per-request health-check amplification:* [`gateway.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/gateway.js#L29-L36) performs a synchronous `GET /.well-known/celld/health` before forwarding *every* incoming HTTP request, doubling internal request load for asset-heavy UI pages.
  * *Unbounded artifact storage:* [`receiveArtifact`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/manifest.mjs#L7-L32) allows 32 MB per submission with no pruning of rejected or superseded artifacts in `/var/lib/fogd/artifacts` or `.fogd/releases/`.
  * *Node-ID/volume coupling:* Losing or mismatching a replica's `CELLD_NODE` identity and disk log during a host migration wedges recovery ([decisions.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/decisions.md#L80-L104)).

**Recommendation:** Adopt the revised vision with the 3-gate decision filter, pull **additive resource evolution** ahead of M9, and scope the next spec to **M7a** (native Void `pages/` + D1/R2/DO + operator secret injection + submitter status endpoint) followed immediately by **M8 cold backup/restore** before any shared M9 deployment.

**Unresolved decisions to settle before drafting the M7 spec:**
1. **UI & Auth path for M7:** Will M7 standardize on **native Void `pages/`** (compatible with `void_worker` single-module bundling today) or a **Class A framework** (requiring `"ssr"`/`"rsc"` bundling updates in [build.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/cli/src/build.mjs)), and will it wire Void's internal `/__void/migrate/auth` endpoint or use user-space D1 session migrations?
2. **Secret injection contract:** How should operators supply required server secrets (`void/env` `secrets.required`) so the controller injects them into `celld` during activation without mutating the immutable submission digest or exposing them in `/v1/deployments/:id/artifact`?
3. **Single-operator approval policy:** Will `fogd` support an explicit auto-approve mode for admin-authenticated or local deployments so solo operators do not have to run a separate approval command on every deploy?
