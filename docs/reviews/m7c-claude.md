## M7c spec review

**Verdict:** the design is sound, but four places where the spec's words don't match pinned Void/celld behavior need fixing before implementation, and two leak paths in the current controller would violate the non-disclosure promise as written.

### High priority

1. **`BETTER_AUTH_SECRET` is not emitted the way the spec assumes.** Void only auto-adds it to `secrets.required` when `VOID_CLOUDFLARE_DEPLOY_BUILD=1` (`.upstream/void/packages/void/src/plugin-worker-bindings.ts:128-150`). fogd's `packages/cli/src/build.mjs` never sets that flag. Declaring it in `env.ts` does work, but only if the schema rejects `undefined` (`plugin-env-schema.ts:153-159`); an optional or defaulted schema entry silently drops it from `required`, and the worker then falls through to the dev fallback only in dev mode and throws at request time in production (`runtime/better-auth-shared.ts:80-93`). Spec should say: the fixture's `env.ts` entry must be non-optional, and fogd's build should assert `BETTER_AUTH_SECRET` is present in `secrets.required` whenever auth is enabled, failing the build otherwise. Also decide and document whether fogd sets the deploy-build flag; it changes version-metadata binding handling (`plugin-worker-bindings.ts:493`), so it isn't a free switch.

2. **celld rejects `secrets` in `wrangler.json`.** It is not in `SUPPORTED_KEYS` (`.upstream/celld/crates/celld/deploy.rs:42-63`) and unknown keys bail at `deploy.rs:1296-1305`. fogd's `translateConfig` also throws `Unsupported binding/config: secrets` today (`packages/runtime/src/artifact.mjs:7-38`). The spec says "preserve names in fogd-deployment.json" but never says the canonical `wrangler.json` must have `secrets` stripped. State it explicitly, and add `fogd-deployment.json` to the `receiveArtifact` path allowlist (`packages/runtime/src/manifest.mjs:22`) and to the canonical-equality check so a submitter can't smuggle a divergent copy.

3. **Secret values can echo through the generic error path.** `http.mjs:72` returns `error.message` for any throw, and `body()` uses `JSON.parse` directly (`http.mjs:16`). Node 26 includes the raw input in parse errors (verified: `Unexpected token 'h', "hunter2-plain-value" is not valid JSON`). An admin who pipes a bare value instead of a JSON object gets the value reflected in the HTTP response and `fogd admin` output. The secrets endpoint needs its own bounded body reader with a fixed parse error, plus a much smaller size cap than the artifact's ~45 MB.

4. **"Fixed diagnostics for administrators" removes the only debugging path.** Today raw celld stderr lands in `request.error` (`controller.mjs:145`, `backend.mjs:34`) and is shown in `/v1/admin` and the HTML page. The spec redacts this for secret-bearing releases but says nothing about where the raw text goes. Specify that the controller logs the raw error to its own stdout/stderr (docker logs) with the deployment id, and status carries the fixed string. Otherwise a failed secret-bearing activation is undiagnosable.

### Medium priority

5. **Revision selection is underspecified.** Approval currently carries only `{digest}` (`http.mjs:63-64`, `cli/src/platform.mjs:53`). "Stale selection fails" implies the approve request names a revision id. Say so: the admin view exposes the current revision id per app, approve takes `{digest, secretRevision}`, and a mismatch with the app's current revision is refused unless it is a retry of the same pinned attempt. Also say how a retry after rotation surfaces that it will run with the old revision; silently using stale secrets on retry is a trap.

6. **Name-only validation leaves a boot-time failure mode.** Void validates values at worker boot and throws (`runtime/env-public.ts:163-174`). fogd's readiness check is celld-level health only (`backend.mjs:43-59`), so an invalid value (wrong length, bad format) activates cleanly and the app 500s on every request with route `active`. Either add an app-level probe after readiness or record this as an explicit limitation in the acceptance section.

7. **Rotation invalidates every session.** Better Auth signs cookies with the secret; the "prove rotation requires explicit approval" test should also assert that existing sessions are logged out after rotation, since that is the user-visible effect and a natural regression check.

8. **Upstream generates the auth secret itself.** Direct Cloudflare deploys provision `BETTER_AUTH_SECRET` automatically (`cli/deploy-cloudflare-publish.ts:99-138`). On fogd the admin supplies it. State that divergence and the minimum length fogd enforces, so "matching upstream" is not read as auto-generation.

### Low priority / confirmations

- **Migrate endpoint is already unreachable.** `/__void/migrate/*` is gated on `__VOID_PROXY_TOKEN` (`runtime/migration-handler.ts:57`), which fogd refuses as a var (`artifact.mjs:44`), and the gateway blocks `/__void` paths and strips `x-void-*` headers (`gateway.js:20-26`). Spec claim holds. Add a test that a direct node request with a guessed header still gets 401.
- **Checked-in auth SQL via `void db generate` is real** (`cli/db.ts:392-397`). Fine.
- **Better Auth origin binding works through the gateway** because the request URL is forwarded unchanged (`gateway.js:35`), so `baseURL`/`trustedOrigins` match the browser origin. Worth one assertion in the browser test.
- **celld deploy output lists var names only** (`deploy.rs:550`), never values. Confirmed.
- **Container runs as root** (no `USER` in `docker/runtime.Dockerfile`), so "owner-only permissions" on the controller volume is root-only. Acceptable locally; note it.
- **Binding-name conflicts:** celld refuses a var sharing a name with another binding (`deploy.rs:1927-1960`), and Wrangler counts `secrets.required` as binding names (`cli/wrangler.ts:2164-2180`). The spec's conflict validation should mirror both, case-insensitively like `artifact.mjs:53`.
