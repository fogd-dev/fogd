Tests pass (18/18 in the platform suite), so the review below is grounded in the current code paths rather than a hypothetical baseline.

## Verdict

The M8b1 spec is sound and implementable with small diffs on top of the existing `exclusive()` queue. Four points need tightening before implementation, and there is one pre-existing bug the spec's startup validation should absorb.

## Spec gaps and traps in the existing code

1. **Admin state spread will leak hashes by default.** `adminState` in `packages/platform/src/admin-view.mjs:9` returns `{ ...controller.state, ... }`. If credentials live in `state.json` (recommended, see below), the first `GET /v1/admin` exposes every token hash unless that spread is replaced with an explicit projection. The spec says "do not expose token hashes" but the acceptance test only checks status and artifact responses. Add the admin listing to acceptance.

2. **`FOGD_MAX_PENDING=abc` silently disables the limit today.** `main.mjs:11` does `Number(process.env.FOGD_MAX_PENDING || 20)`; NaN makes the `>=` comparison in `controller.mjs:71` always false. The spec's "reject malformed numeric limits at startup" should explicitly cover the existing limit, not just the two new ones. One `Number.isSafeInteger(n) && n > 0` helper for all three.

3. **Orphan artifact directories on crash.** `submit` writes files, then `save()`, then responds. A process crash between the write and `save()` leaves a directory under `artifacts/` with no state entry. "Reconstruct actual retained size on restart" will count it forever, and nothing prunes before M10. Since the 201 is only sent after `save()`, any artifact dir whose id is not in `state.deployments` was never admitted and is safe to delete at `init()`. Spec should say so; otherwise "quota refusal leaves disk unchanged" is true but disk can still drift.

4. **"Before writing files" is achievable, but define the byte count.** The body is fully buffered in memory before `submit` (http.mjs `body()`), so `Buffer.byteLength(file.data, 'base64')` summed over `body.files` gives the exact decoded size with no writes. State in the spec that the quota is logical bytes, not block usage. A 2000-file artifact of tiny files costs far more disk than its byte sum. Operators sizing a volume need to know.

5. **"Scope before staging" is cheap because `body.app` is authoritative.** `receiveArtifact` already calls `appName(body.app)` at manifest.mjs:17 and `translateConfig(config, body.app)` pins the config to it. Check `credential.apps.includes(body.app)` before calling `receiveArtifact`, inside `exclusive`. No parsing of wrangler.json needed.

6. **Per-credential limit should count the same statuses as the global one.** The global limit counts `pending` and `failed` (controller.mjs:71). If the per-credential limit counts only `pending`, a teammate's failed retries accumulate against the shared pool with no per-identity cap. Define both as pending plus failed.

7. **Revocation must go through `exclusive()`.** The spec's "check again inside the serialized mutation" only works if revoke itself is ordered on the same queue. Otherwise a revoke that lands between the HTTP auth check and the queued submit's re-check is still fine, but a revoke that lands after the re-check and before `save()` would persist the wrong order. Say it explicitly.

## Simpler, reversible choices

- **Credentials in `state.json`, no new store.** It is already the recovery unit; backup and restore evidence comes free. Strip hashes in the admin projection (point 1).
- **Immutable scope.** The spec's "including after app scope changes" implies an edit endpoint. Revoke and reissue instead. Deletes the endpoint, the test case, and the ambiguity.
- **Plain SHA-256 of a 32-byte random token.** No bcrypt or scrypt; KDFs exist for low-entropy secrets. Lookup by hex hash in a null-prototype object, same pattern as `secrets.index`. Timing leaks on the hash are not useful to an attacker.
- **Make `FOGD_DEPLOY_TOKEN` optional rather than adding a mode flag in M8b1.** Legacy path exists iff the variable is set. `main.mjs` `required()` and the `:?` in `compose.yaml:97` both need relaxing. Introduce a "shared mode" flag only in M8b2 when a second condition (plaintext bind) exists.
- **Quota as one running integer.** Walk `artifacts/` at init, add on admitted submit. No per-status bookkeeping; nothing deletes artifacts today except the failed-submit `rm`, so every deployment is retained.
- **Submitter stays a string.** Keep `submit(body, submitter)`; pass the credential id. Cross-identity status keeps returning 404, as the existing test asserts, which avoids enumeration.
- Skip an issuance form on the admin HTML page. CLI plus JSON endpoint is enough.

## Constraints worth preserving for M8b2

- **One listener serves admin, deploy, and `/internal/route`.** Binding publicly exposes the gateway routing endpoint behind a single bearer. "Keep runtime/control internals private" needs either a second listener or a documented requirement that only the gateway port is public.
- **`checkMutation` already accepts an https Origin** (admin-secrets.mjs:6), so TLS termination at the gateway does not break CSRF. Keep the host-derived comparison rather than hardcoding a scheme.
- **CLI trust: `NODE_EXTRA_CA_CERTS` is the explicit trust configuration.** Node's fetch honours it; zero code. Document it in the deploy and status commands. The spec's ban on a global verification bypass already rules out `NODE_TLS_REJECT_UNAUTHORIZED`.
- **Void secure sessions need the app to observe https.** The gateway must terminate TLS itself or forward the proto header, or cookies silently stop being `Secure`.
- CSRF token is per-process random (http.mjs:33). Restart invalidates browser sessions. Fine, but the HTTPS login test should expect it.

## Gaps to record rather than fix

- Memory, not disk, is the unbounded resource under concurrent uploads. Each request buffers up to 45 MB before reaching the queue, with no in-flight cap. A one-line counter at the HTTP layer would bound it, or record it next to the D1/R2 growth note.
- The `execution/` copy during secret activation adds up to one artifact of transient disk outside the quota.
- N scoped credentials can still collectively exhaust the global pending limit. Not a hostile-tenant claim, consistent with the spec, but name it.
