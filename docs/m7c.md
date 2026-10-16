# M7c: private configuration and native Void accounts

**Implementation specification.** Preserve Void's required server environment
names and qualify a local email/password app using native Void/Better Auth. App
accounts never grant fogd deploy or administration rights. No external provider,
Cloudflare API, or public production deployment is included.

## Secret contract

Read Void's generated `secrets.required` declaration. Preserve names, not values,
in a digest-covered `fogd-deployment.json` beside the canonical runtime artifact.
Validate names, duplicates, reserved/public prefixes, and conflicts with ordinary
vars or bindings. Existing artifacts without metadata remain supported.

An administrator uses `fogd admin secrets APP` with a JSON object on standard
input. Store immutable per-app secret revisions outside artifacts and controller
status. The update replaces the app's whole secret set; only declared names are
injected. Return opaque revision IDs and names, never values or value hashes.
Use the existing admin authentication, CSRF/origin protection, mutation queue, and
bounded request handling. Values do not appear in arguments or CLI output.

Approval pins both the artifact digest and the selected secret revision. Missing
required names or a stale selection fails before claiming a slot, pausing routing,
or performing runtime effects. Retries use the same pinned revision. New secret
revisions do not change running code or failed attempts. A new submission and
approval apply rotation. Store values privately with owner-only file permissions.

Materialize a separate private execution directory only after approval, combine
its canonical vars with exactly the declared values, and pass it to celld. Never
modify the submitted artifact. Clean the temporary directory after success/failure
and on controller restart. Retain immutable secret revisions for explicit retries.
Treat backend failures as sensitive and expose fixed diagnostics for secret-bearing
releases, including administrator status and mutation responses.

celld serializes vars as plaintext bindings into its deployment bucket; this is
operator-private configuration, not encryption at rest or a dedicated runtime vault.
Operators with storage/runtime access and approved app code can read these values.
Existing local trusted-code assumptions remain. Backups and retention must include
secret revisions; encrypted storage, garbage collection, and remote TLS/identity
belong to later milestones. App code deliberately logging secrets is outside the
artifact/status non-disclosure guarantee.

## Native authentication fixture

Use Void email/password authentication with its default password implementation,
`void/auth` server state, and native auth client. Declare BETTER_AUTH_SECRET through
`env.ts` so the build emits its required name. Use `void db generate` to include
Better Auth tables in checked-in SQL migrations, matching upstream's direct
Cloudflare deployment strategy. Do not invoke or expose `/__void/migrate/*` and do
not weaken reserved-path or privileged-header protection.

Test sign-up, wrong-password refusal, sign-in, authenticated page/API access,
sign-out, and persistence across controller/workerd and celld restart. Anonymous
requests cannot access private application data; app sessions cannot call fogd
admin/deploy APIs. Keep secrets stable through ordinary app updates and prove
rotation requires explicit approval. The fixture is a local account demonstration,
not an invitation system, password recovery service, or production identity rollout.

## Acceptance

Unit tests cover declaration rejection, missing values before effects, stale
revision approval, pinned retries after rotation, app isolation, backend-error
redaction, and artifact immutability. HTTP tests cover submitter/admin separation
and CSRF. Docker/browser tests exercise the account workflow, restarts, and secret
non-disclosure in submitted/downloaded manifests and status. Normal Void and fogd
builds remain possible with networking disabled. Record exact limitations and
review findings before marking the milestone complete.
