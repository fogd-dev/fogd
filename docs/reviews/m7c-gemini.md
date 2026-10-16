Here is a prioritized review of the **M7c specification** ([docs/m7c.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/m7c.md)) and current `fogd` implementation against pinned Void (`.upstream/void`) and pinned `celld` (`.upstream/celld`).

---

### Prioritized Actionable Findings

#### 1. [High] Spec Contradiction on Void’s Default Password Implementation vs. `celld` `node:crypto.scryptSync`
- **Locations**:
  - [docs/m7c.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/m7c.md#L44-L46)
  - [better-auth.ts](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/void/packages/void/src/runtime/better-auth.ts#L48-L62)
  - [node_crypto.js](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/node_crypto.js#L1632-L1633)
  - [auth.ts](file:///Users/sgtpooki/code/sgtpooki/fogd/examples/accounts/auth.ts#L1-L4), [password.ts](file:///Users/sgtpooki/code/sgtpooki/fogd/examples/accounts/src/password.ts#L1-L18)
- **Issue**:
  - [docs/m7c.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/m7c.md#L44-L45) states: *"Use Void email/password authentication with its default password implementation, `void/auth` server state, and native auth client."*
  - In pinned Void, [`DEFAULT_PASSWORD_IMPLEMENTATION`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/void/packages/void/src/runtime/better-auth.ts#L48-L62) uses `scryptSync` from `node:crypto`.
  - In pinned `celld`, [`node_crypto.js`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/celld/crates/celld/js/node_crypto.js#L1632-L1633) stubs both `scrypt` and `scryptSync` with `notImplemented("scryptSync")`, which throws at runtime under `celld`.
  - Consequently, [`examples/accounts/auth.ts`](file:///Users/sgtpooki/code/sgtpooki/fogd/examples/accounts/auth.ts#L1-L4) does **not** use Void’s default implementation; it injects a custom `@noble/hashes/scrypt.js` adapter ([`examples/accounts/src/password.ts`](file:///Users/sgtpooki/code/sgtpooki/fogd/examples/accounts/src/password.ts#L1-L18)) matching Void’s parameters (`N: 16384, r: 16, p: 1, dkLen: 64`, NFKC normalization, `${salt}:${key}` hex format).
- **Action**:
  - Update [docs/m7c.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/m7c.md#L44-L50) to document `celld`’s `node:crypto.scryptSync` limitation and specify the byte-compatible scrypt adapter rather than claiming Void’s default `node:crypto` implementation is used unmodified.

---

#### 2. [High] Late Pinning of `secretRevision` and `privateConfiguration` After Pre-Activation Side Effects & Error Leakage in `Controller.mutate()`
- **Locations**:
  - [controller.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L84-L90)
  - [controller.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L123-L155)
  - [http.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/http.mjs#L62-L67), [http.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/http.mjs#L74)
- **Issue**:
  - The spec requires:
    1. *"Approval pins both the artifact digest and the selected secret revision. Missing required names or a stale selection fails before claiming a slot, pausing routing, or performing runtime effects. Retries use the same pinned revision."* ([docs/m7c.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/m7c.md#L22-L25))
    2. *"Treat backend failures as sensitive and expose fixed diagnostics for secret-bearing releases, including administrator status and mutation responses."* ([docs/m7c.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/m7c.md#L31-L32))
  - In [`Controller.mutate()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L123-L133), `this.secrets.select(request, secretRevision)` validates the selection at line 123, **but `request.secretRevision` and `app.privateConfiguration` are not set until [`Controller.activate()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L138-L139) and not persisted until line 155 (`await step('approved')`)**.
  - Between line 124 and line 132—before `activate()` is entered—`mutate()` executes:
    - `await this.backend.claim(slot, request.app)` (line 124, mutating S3 slot ownership)
    - `this.state.apps[request.app] = app; await this.save()` (lines 127–128, persisting `route: 'paused'` and resource reservations without `request.secretRevision` or `app.privateConfiguration`)
    - `await this.reconcile(app, slot)` (line 130, invoking `celld d1 execute` on the slot)
    - `request.resourceChanges = this.compatible(request, app)` (line 131)
  - **Consequences**:
    1. **Broken revision pinning across pre-`activate` failure or crash**: If `reconcile(app, slot)` (line 130) or `compatible(request, app)` (line 131) throws, or if the controller crashes after line 128 before line 155, the slot is already claimed and `app` is already persisted as `paused`, but `request.status` remains `'pending'` and `request.secretRevision` remains `undefined`. If secrets are rotated before retry, `Secrets.select()` will reject the originally approved revision and instead accept the newly rotated revision on the same deployment.
    2. **Backend error leakage on upgrade to a secret-bearing release**: [`Controller.reconcile()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/controller.mjs#L84-L90) only redacts errors when `app.privateConfiguration` is truthy. When an existing non-secret app with `app.uncertain` set is approved for a secret-bearing release, `app.privateConfiguration` is still falsy at line 130 (`await this.reconcile(app, slot)`). If `reconcileLedger` fails there, raw `celld d1 execute` stderr is thrown out of `mutate()` and returned in the HTTP 400 admin mutation response ([`http.mjs:74`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/http.mjs#L74)).
    3. **Backend error leakage on `backend.claim()`**: If `this.backend.claim(slot, request.app)` at line 124 throws an S3 error on a secret-bearing release, it is outside `activate()`’s redaction block and leaks raw error details in the HTTP 400 response.
- **Action**:
  - Pin `request.secretRevision = selected.revision` and taint `app.privateConfiguration ||= Boolean(selected.revision)` immediately upon entering the approval transition (before `save()` and `reconcile()`), and wrap `claim()` / pre-activation `reconcile()` in the fixed-diagnostic error boundary whenever `app.privateConfiguration || Boolean(selected.revision)` holds.

---

#### 3. [Medium] Offline Build Verification (`verify-builds.mjs` / `verify.Dockerfile`) Omits `examples/accounts` and Copies Host `.void/` State
- **Locations**:
  - [verify-builds.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/scripts/verify-builds.mjs#L24-L37)
  - [verify.Dockerfile](file:///Users/sgtpooki/code/sgtpooki/fogd/docker/verify.Dockerfile#L6-L11)
  - [examples/accounts/package.json](file:///Users/sgtpooki/code/sgtpooki/fogd/examples/accounts/package.json#L5-L9)
  - [better-auth-db.ts](file:///Users/sgtpooki/code/sgtpooki/fogd/examples/accounts/.void/better-auth-db.ts#L1-L5)
- **Issue**:
  - The Acceptance section ([docs/m7c.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/m7c.md#L63-L64)) requires: *"Normal Void and fogd builds remain possible with networking disabled."*
  - [`scripts/verify-builds.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/scripts/verify-builds.mjs#L35-L37) only tests `examples/guestbook` and `grown`; it does not build or stage `examples/accounts` offline.
  - [`examples/accounts/package.json`](file:///Users/sgtpooki/code/sgtpooki/fogd/examples/accounts/package.json#L5-L9) is missing `"typecheck": "void prepare && tsc --noEmit"` (which [`verifyApp()`](file:///Users/sgtpooki/code/sgtpooki/fogd/scripts/verify-builds.mjs#L25) runs first).
  - There is no `.dockerignore` in the repository, so `COPY examples examples` in [`docker/verify.Dockerfile`](file:///Users/sgtpooki/code/sgtpooki/fogd/docker/verify.Dockerfile#L8) copies host-generated `examples/*/.void/` and `dist/` directories (including [`examples/accounts/.void/better-auth-db.ts`](file:///Users/sgtpooki/code/sgtpooki/fogd/examples/accounts/.void/better-auth-db.ts#L2-L4), which embeds host-specific `/Users/...` absolute paths) into the verification image.
- **Action**:
  - Add `"typecheck": "void prepare && tsc --noEmit"` to [`examples/accounts/package.json`](file:///Users/sgtpooki/code/sgtpooki/fogd/examples/accounts/package.json#L5-L9).
  - Add `await verifyApp(join(stackRoot, 'examples/accounts'), 'accounts')` to [`scripts/verify-builds.mjs`](file:///Users/sgtpooki/code/sgtpooki/fogd/scripts/verify-builds.mjs#L35-L37) and assert that the staged release has `requiredSecrets: ['BETTER_AUTH_SECRET']`.
  - Add a `.dockerignore` excluding `node_modules`, `dist`, `.void`, `.wrangler`, `.fogd`, and `.env*` so offline builds run from clean source.

---

#### 4. [Medium] Non-Secret Releases Display/Submit `secretRevision` in Admin UI and `Secrets.select()` Silently Ignores Unexpected `selected` Revisions
- **Locations**:
  - [http.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/http.mjs#L70)
  - [secrets.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/secrets.mjs#L29-L33)
  - [manifest.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/manifest.mjs#L35)
- **Issue**:
  1. In [`http.mjs:70`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/http.mjs#L70), both the `<pre>` resource summary and the `<button data-secret-revision="...">` attribute evaluate `d.secretRevision || controller.secrets.index[d.app]?.revision || null` without checking `d.requiredSecrets?.length`. If an app has staged secrets in `controller.secrets.index[d.app]`, a deployment with `requiredSecrets: []` still displays a `secretRevision` in the admin UI and sends it in the POST body.
  2. In [`Secrets.select()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/secrets.mjs#L30-L31), `if (!names.length) return { revision: null, values: {} };` returns immediately without checking whether `selected` was non-null. If an admin passes a `secretRevision` on `fogd admin approve ID SHA REV` for a release with `requiredSecrets: []`, `select()` silently drops `selected` instead of rejecting the mismatched expectation.
  3. In [`receiveArtifact()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/manifest.mjs#L35), a submitted manifest containing a non-canonical `fogd-deployment.json` (e.g., `{"requiredSecrets": []}` or unsorted `requiredSecrets`) is accepted, whereas [`stageArtifact()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/artifact.mjs#L165) omits `fogd-deployment.json` when `requiredSecrets` is empty and sorts names.
- **Action**:
  - In [`http.mjs:70`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/http.mjs#L70), only populate `secretRevision` and `data-secret-revision` when `(d.requiredSecrets || []).length > 0`.
  - In [`Secrets.select()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/secrets.mjs#L30-L31), reject non-null `selected` when `!names.length`.
  - In [`receiveArtifact()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/manifest.mjs#L35), require `fogd-deployment.json` (when present) to have `metadata.requiredSecrets.length > 0` and match canonical form via `isDeepStrictEqual`.

---

#### 5. [Medium] Case-Sensitive Reserved Prefix Check in `secretNames()` and Unfiltered `VOID_*` Build Env Vars in `local.mjs`
- **Locations**:
  - [deployment.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/deployment.mjs#L2-L8)
  - [local.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/cli/src/local.mjs#L35)
  - [index.ts](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/void/packages/void/src/index.ts#L422), [plugin-routing.ts](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/void/packages/void/src/plugin-routing.ts#L476), [plugin-worker-bindings.ts](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/void/packages/void/src/plugin-worker-bindings.ts#L493)
- **Issue**:
  1. [`secretNames()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/deployment.mjs#L3-L5) deduplicates names and checks binding collisions case-insensitively (`toLowerCase()`), but tests reserved/public prefixes case-sensitively (`/^(?:__|VITE_|FOGD_)/`), allowing lowercase `vite_*` or `fogd_*` secret names.
  2. [`buildArtifact()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/cli/src/local.mjs#L35) strips `CLOUDFLARE_`, `CF_`, `AWS_`, `MINIO_`, and `FOGD_.*(TOKEN|PASSWORD|SECRET)` from `process.env`, but leaves `VOID_DEPLOY_PROJECT_ID`, `VOID_CLOUDFLARE_DEPLOY_BUILD`, and `VOID_MANAGED`. In pinned Void, `VOID_DEPLOY_PROJECT_ID` enables `managedDispatch = true` ([`index.ts:422`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/void/packages/void/src/index.ts#L422), [`plugin-routing.ts:476`](file:///Users/sgtpooki/code/sgtpooki/fogd/.upstream/void/packages/void/src/plugin-routing.ts#L476)), which strips edge routing rules from the compiled worker.
- **Action**:
  - Change the prefix regex in [`deployment.mjs:5`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/runtime/src/deployment.mjs#L5) to `/^(?:__|VITE_|FOGD_)/i`.
  - Filter `VOID_DEPLOY_PROJECT_ID`, `VOID_CLOUDFLARE_DEPLOY_BUILD`, and `VOID_MANAGED` out of `buildEnv` in [`local.mjs:35`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/cli/src/local.mjs#L35).

---

#### 6. [Low] Secret File Permissions and CSRF Constant-Time Comparison Regression
- **Locations**:
  - [secrets.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/secrets.mjs#L11-L26)
  - [store.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/store.mjs#L15-L19)
  - [admin-secrets.mjs](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/admin-secrets.mjs#L1-L5)
- **Issue**:
  1. [docs/m7c.md](file:///Users/sgtpooki/code/sgtpooki/fogd/docs/m7c.md#L25-L26) specifies: *"Store values privately with owner-only file permissions."* While [`Secrets.materialize()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/secrets.mjs#L46) writes `wrangler.json` with `{ mode: 0o600 }`, [`Secrets.replace()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/secrets.mjs#L23-L25) calls [`saveJson()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/store.mjs#L17), which calls `writeFile(temp, ...)` without `{ mode: 0o600 }` (relying on default `umask` and the parent directory mode). Additionally, `mkdir(this.dir, { recursive: true, mode: 0o700 })` in [`Secrets.init()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/secrets.mjs#L11) does not enforce `0o700` if `this.dir` already existed with looser permissions.
  2. Extracting [`checkMutation()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/admin-secrets.mjs#L2) replaced `http.mjs`’s constant-time `equal(request.headers['x-fogd-csrf'], csrf)` check with `!==`.
- **Action**:
  - Pass `{ mode: 0o600 }` in [`saveJson()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/store.mjs#L17) (and `chmod(this.dir, 0o700)` in `Secrets.init()`).
  - Use constant-time comparison in [`checkMutation()`](file:///Users/sgtpooki/code/sgtpooki/fogd/packages/platform/src/admin-secrets.mjs#L2).
