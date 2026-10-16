# Claude platform review

Review complete. Findings below are ordered by severity, each with the minimal fix.

**Verdict: feasible as scoped.** The controller is one Node process that reuses the runtime image (which already ships the celld binary), spawns fixed argv for `celld deploy` and `celld d1 migrations apply` with per-slot `CELLD_BUCKET`, and triggers adoption with the existing `/reload` check from `waitReplicas`. Nothing needs Docker socket access. Four issues need design changes before implementation.

## High

1. **Slot ownership must live in the bucket, not only in controller metadata.** Since the controller cannot create containers, the celld prefix is necessarily slot-keyed (for example `apps/slot-1`) and the app-to-slot map is controller state. Losing that file lets a fresh controller approve a new app into a prefix holding another app's D1/R2/DO data, which the design names as the failure to avoid but gives no mechanism for. Fix: on first approval write `apps/slot-N/fogd-owner.json` with a conditional create (MinIO conditional writes are already qualified by the celld probe), verify the marker equals the app on every activation, and rebuild the slot map from markers at startup.

2. **Digest-excluded files are unverified content.** `artifactDigest` in `packages/runtime/src/artifact.mjs:76` skips `fogd-release.json`. If the upload manifest accepts that name, a client can ship bytes the approved digest never covered. Fix: reject any uploaded `fogd-release.json`, regenerate release metadata server-side from the staged `wrangler.json` by re-running `translateConfig` and asserting deep equality except `main`, and check `main` resolves inside `worker/`.

3. **Failed activation needs a retry action, not a resubmission.** After `celld deploy` wrote the fleet entrypoint or migrations applied, the only recovery offered is a new submission. The controller's migration-hash check compares against the last *active* release, so migrations applied by a failed activation are invisible and a teammate could edit one. Fix: write durable step checkpoints (migrations attempted, version deployed, replicas adopted) before each side effect, treat attempted migrations as the comparison baseline, and add an admin "retry activation" that re-runs the sequence for the same digest. The restart reconciliation then becomes "failed at step X, retryable".

4. **Do not keep the route paused when failure happens before publish.** For an existing app the order is migrate, then pause, then deploy. A migration failure leaves old code intact with a backward-compatible partial schema, which is safe to serve. Fix: restore the previous active route if failure occurs before `celld deploy`; stay paused only after it. The acceptance list should test both cases.

## Medium

5. **Per-request routing lookups make the controller a hot-path dependency.** The gateway already does a health probe per request; adding a controller call doubles it and any controller restart becomes a full outage. Either accept it for loopback v0 and state so, or cache the route in the gateway for 2 to 3 seconds and have the controller sleep longer than the TTL after pausing and before invoking `celld deploy`. Pick one; the pause ordering guarantee depends on it.

6. **Reject slot exhaustion and resource-identity changes at submission, then again at approval.** The identity check from `packages/cli/src/local.mjs:66` should run on submit so teammates get the error immediately, and run again on approve because state can change in between. Record the submitting token's label on the request so the admin page shows who submitted for which app name.

## Low

7. **CSRF token is more than needed.** Browsers send `Sec-Fetch-Site`; requiring `same-origin` or `none` plus a JSON content type on mutations covers the Basic-auth auto-send case without a token flow. Keep the token only if non-browser admin clients must mimic the page.

8. **MinIO policy gives real cross-fleet isolation for a few lines.** The shared root credentials mean any replica can read the other slot's prefix. Creating one MinIO user per slot with a prefix-scoped policy in bucket-init would make the private networks mean something. Optional for trusted teammates, but cheap.

9. **Shared replica wait code.** Lift the inline script in `waitReplicas` into a plain fetch loop in the controller, since the controller is on the fleet networks. Avoids two divergent adoption checks.

Add to acceptance checks: owner marker mismatch refuses activation, uploaded `fogd-release.json` rejected, restart mid-activation then retry of the same digest succeeds, migration failure before publish leaves the old route serving.