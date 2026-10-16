# Gemini platform review

### Review Summary

The **Custom deploy gate and isolated fleets** option is the right architectural choice for Milestone 5: it preserves the validated Milestone 2–4 runtime boundary, avoids Docker-socket privilege in the controller, and requires no Cloudflare APIs, OAuth, or external databases.

Before implementation, several concrete gaps across **slot-to-prefix binding**, **state transitions & recovery after partial migration/deploy failure**, **server-side artifact canonicalization (`artifact.mjs`)**, and **approval/routing isolation** need tightening so the state machine cannot wedge an app or violate approval guarantees.

---

### Prioritized Findings & Minimal Fixes

#### 1. [High — Feasibility & Recovery] Pre-provisioned `celld` fleets require slot-scoped `CELLD_BUCKET` prefixes and an in-bucket ownership fence
* **Ground truth:** In [`compose.yaml`](file:///Users/sgtpooki/code/sgtpooki/fogd/compose.yaml#L8-L58), `CELLD_BUCKET` is passed via container environment at process start (`s3://${FOGD_BUCKET}/apps/${FOGD_APP}`). Because the v0 controller has no Docker socket to recreate containers with a new `CELLD_BUCKET` on first approval, pre-provisioned replicas in `slot-1` and `slot-2` must start with fixed **slot-scoped** prefixes (e.g., `s3://fogd/slots/slot-1` and `s3://fogd/slots/slot-2`), while D1/R2 binding names inside `wrangler.json` remain `<app>-<binding>`.
* **Failure mode:** The design notes that *"losing the slot assignment must not silently assign an existing prefix to a different app,"* but leaves this to coordinated backup discipline. If the controller volume is reset while MinIO and replica volumes retain state, a restarted controller will see `slot-1` as free and assign a different app to `s3://fogd/slots/slot-1`, overwriting `deploy/current.json` and mixing replica WAL volumes.
* **Minimal fix:**
  1. Set each pre-provisioned fleet's `CELLD_BUCKET` to a fixed slot prefix (`s3://${FOGD_BUCKET}/slots/slot-1`, `slot-2`) and pass that slot's `CELLD_BUCKET` when the controller spawns `celld deploy` and `celld d1 migrations apply`.
  2. Enforce an in-bucket ownership fence at `slots/<slot-id>/fogd-owner.json` (`{ app, assignedAt }`). On first slot assignment, write `fogd-owner.json` with S3 conditional create (`If-None-Match: "*"`) and verify `slots/<slot-id>/deploy/current.json` does not belong to another app. On every activation and controller startup reconciliation, verify the bucket marker matches the controller's slot table before mutating the slot.

---

#### 2. [High — State Transitions & Migration Recovery] Failed first activation or partial multi-file migration wedges recovery resubmission
* **Ground truth:** [`local.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/cli/src/local.mjs#L62-L89) currently persists app state (`resources`, `migrations`, `version`) only at the very end of `deployLocal()`. Look at how the design handles new vs. existing apps and failures:
  * New app: `celld deploy` (private) $\rightarrow$ `waitReplicas` $\rightarrow$ `celld d1 migrations apply` $\rightarrow$ enable route.
  * Existing app: verify resource identities & prior migration digests $\rightarrow$ `celld d1 migrations apply` $\rightarrow$ `celld deploy` $\rightarrow$ `waitReplicas`.
* **Failure modes:**
  1. **First-deploy failure after slot assignment:** Suppose a new app is approved, gets `slot-1`, passes `celld deploy`, and fails in `celld d1 migrations apply` (e.g., syntax error in `0001_init.sql`). The slot assignment is persisted and the request enters `failed`/`paused`. When the teammate submits a fixed `0001_init.sql`:
     * If the controller recorded `0001_init.sql`'s bad digest before running `migrate`, resubmission is blocked forever by the immutable migration check.
     * Conversely, if the controller treats any app with an assigned slot as an "existing app" on retry, it will run `migrations apply` *before* `celld deploy` even if the initial worker deployment never finished adopting on both replicas.
  2. **Multi-migration partial failure on existing app:** If a release adds `0002_ok.sql` and `0003_bad.sql`, `celld d1 migrations apply` commits `0002_ok.sql` to D1 before failing on `0003_bad.sql`. If the controller only persists the migration ledger when activation fully succeeds, a subsequent submission could modify `0002_ok.sql` and pass controller validation while diverging from D1's applied ledger.
* **Minimal fix:**
  1. Separate **slot assignment state** (`slotId`), **applied migration ledger** (`appliedMigrations`), and **active release state** (`activeRelease`: last fully verified deployment).
  2. Branch between new-app vs. existing-app activation sequences on whether `activeRelease !== null` (not whether `slotId !== null`), reusing the already-assigned `slotId` on retry.
  3. Apply new SQL migrations one file at a time (or stage up to each new migration prefix) and append each migration's `{ database, name, digest }` to the controller's durable `appliedMigrations` ledger immediately after it succeeds, or query/reconcile `d1_migrations` on failure before allowing a changed SQL digest.

---

#### 3. [High — State Transitions] Route pause (`503`) must be persisted *before* migrations and `celld deploy` on existing apps
* **Ground truth:** `celld` replicas watch `CELLD_WATCH` and can also pick up bucket changes on restart.
* **Failure mode:** The design states: *"For an existing app, preserve resource identities and existing migration hashes, then run backward-compatible migrations against the current deployment... During an existing-app activation, pause the route (HTTP 503) to avoid serving mixed versions."* If the controller only pauses the route during or after `celld deploy`, one replica can adopt the new `deploy/current.json` before the other while `workerd` is still routing live requests. Conversely, if `workerd` caches routes or the controller pauses only in memory, a crash mid-command leaves the state ambiguous.
* **Minimal fix:**
  * Define the exact durable transition before spawning any `celld` subprocess:
    1. Acquire the controller's global/per-app activation lock.
    2. Re-validate `pending` deployment against current `activeRelease.resources` and `appliedMigrations` **inside the lock** (since an earlier pending deployment may have been approved between submission and this approval).
    3. Persist `deployment.status = 'activating'` and `app.routeState = 'paused'` (`fsync` + atomic rename) **before** invoking `celld d1 migrations apply` or `celld deploy`.
    4. Only transition `app.routeState = 'active'` and `deployment.status = 'active'` after both replicas return `200` on `/.well-known/celld/health` **and** `POST :8081/reload` returns `{ version: deployment.version }`.

---

#### 4. [High — Deploy-Approval Security] Server-side config canonicalization and path/identifier gaps in [`artifact.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs)
* **Ground truth:** Look at [`translateConfig()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L19-L56) and [`stageArtifact()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L85-L127):
  1. `translateConfig()` hardcodes `main: 'worker/index.js'` (line 36), whereas `stageArtifact()` overwrites `config.main = ...` *after* calling `translateConfig()` (line 95).
  2. `translateConfig()` interpolates `binding.binding` directly into `migrations_dir: migrations/${binding.binding}` (line 47) and `database_name` / `bucket_name` (lines 45–49) without validating `binding.binding` against path traversal (`../`) or non-identifier characters.
  3. Line 54 (`{ ...input.assets, directory: 'assets' }`) and lines 41–42 (`durable_objects`, `migrations`) pass through arbitrary nested client properties into the generated `wrangler.json`.
  4. [`artifactDigest()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L76-L84) hashes `wrangler.json` on disk (and skips `fogd-release.json`). If the controller rewrites `wrangler.json` on ingest, the stored directory digest will change unless `wrangler.json` is already canonical.
* **Minimal fix:**
  1. In [`translateConfig()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L19-L56), validate every `binding.binding` against `/^[A-Za-z_][A-Za-z0-9_]*$/`, validate `input.main` stays within `worker/` via `inside()`, and allowlist nested keys on `assets`, `durable_objects.bindings[]`, and DO `migrations[]`.
  2. On `POST /v1/deployments`, validate manifest paths strictly (POSIX relative paths only; reject `\`, `..`, leading `/`, NUL, symlinks, duplicate paths, and files outside `wrangler.json`, `worker/**`, `assets/**`, `migrations/**`).
  3. Re-run `translateConfig(uploadedWrangler, app)` on the controller and require the canonicalized JSON to match the uploaded `wrangler.json` (or include canonical `wrangler.json` in the client staging step) so the client-submitted SHA-256 digest matches the exact bytes verified before `celld deploy`. Ignore any client-supplied `fogd-release.json` and compute `resources` and `migrations` metadata purely server-side.

---

#### 5. [Medium — Deploy-Approval Security] Cryptographic binding on approval (`digest` + unified CSRF/CLI protection)
* **Failure mode:** The design allows both the browser admin UI and a CLI admin command to call the mutation endpoint with HTTP Basic auth, using *"same-origin checks when an Origin is supplied, and a CSRF token obtained from the authenticated admin page."* If the server ever relaxes CSRF token verification when `Origin` is absent to accommodate the CLI, browser requests that strip `Origin` (e.g., `Referrer-Policy: no-referrer` redirects) could bypass CSRF protection. Additionally, approving by deployment ID alone does not enforce the acceptance check for **exact-digest approval** at the wire level.
* **Minimal fix:**
  1. Require **every** mutation request (`POST /v1/deployments/:id/approve` and `/reject`, whether from browser or CLI) to send `Content-Type: application/json`, a valid `X-Fogd-CSRF` token fetched from an authenticated `GET` endpoint, and `{ "digest": "<expected-sha256>" }` in the JSON body.
  2. Compare Basic credentials, bearer deploy token, gateway token, CSRF token, and digests using `crypto.timingSafeEqual` (after hashing/length checks).

---

#### 6. [Medium — Routing & Container Network Isolation] Keep `workerd` backends statically bound by slot ID and prevent app replicas from reaching the controller API
* **Ground truth:** [`serve.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/serve.mjs#L9-L26) generates `gateway.capnp` with static `external` service bindings (`node-a`, `node-b`).
* **Failure modes:**
  1. If `workerd` dynamically `fetch()`es raw `http://host:port` strings returned by the controller, `workerd` requires open outbound network permissions rather than closed capnp service bindings.
  2. If the `controller` container joins `slot1-net` and `slot2-net` to reach `slot{1,2}-celld-{a,b}:8080/8081`, Docker allows containers on `slot1-net` (i.e. application worker code inside `celld`) to make TCP/HTTP connections back to `controller` over `slot1-net`.
* **Minimal fix:**
  1. Pre-declare all four replica backends (`SLOT_1_A`, `SLOT_1_B`, `SLOT_2_A`, `SLOT_2_B`) and `CONTROLLER` as explicit `external` services in `gateway.capnp`. Have the controller's routing endpoint return `{ state: "active" | "paused" | "unknown", slot: "slot-1" | "slot-2" }` (never raw host/port URLs), and normalize `url.hostname.toLowerCase()` before lookup.
  2. Bind the controller's HTTP server only to its control/ingress network interface (or reject any request whose source IP is in the `slot1-net` / `slot2-net` CIDRs) so app code inside `celld` cannot reach the controller API over the fleet networks.

