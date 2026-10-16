Review complete. I read the full diff, the four new modules, both new tests, the platform test additions, the smoke script, and the surrounding code they depend on (artifact receipt, store, backup, CLI env loading).

**Verdict: no blockers.** The claimed scope holds against the code. Specific checks that passed:

- **Revocation vs queued upload.** Issue, revoke, and submit all run through the same `exclusive` queue, and `submit` re-runs `requireScope` inside the queue before any write. The HTTP-layer `authenticate` is only a pre-filter. The test submits after queuing a revoke and asserts refusal with zero bytes counted.
- **Scope cannot be bypassed via artifact contents.** Scope is checked against `body.app`, and `receiveArtifact` derives the release app from the same field and canonicalizes the config name to it. No second source of app identity.
- **Quota refusal leaves disk unchanged.** `admit` runs before `receiveArtifact`. Any later failure deletes the staged dir and the in-memory record. `used` increments only after the state save succeeds. Restart recount uses `stat().size` of regular files, which equals decoded bytes, so runtime and restart accounting agree. The execution copy lives in a sibling `execution/` dir, not under `artifacts/`, so it is not double counted.
- **Hash and token exposure.** `describe()` strips the hash. The admin state spreads `controller.state`, which never contains credentials. `deploymentStatus` returns a fixed field set. CLI prints the token only from the issuance response. The smoke `run` helper captures stdout rather than inheriting it, so the token does not land in logs.
- **Admin guards.** Credential routes sit behind Basic auth plus the same CSRF and Origin check as secrets. A scoped bearer gets 401 on admin, artifact, and credential endpoints, covered by both the unit test and the smoke.
- **Legacy token optional.** Empty compose default becomes `null` in main, and the handler short-circuits on a null token, so no `Bearer ` match is possible.
- **Config limits.** All four limits go through `positiveLimit`, which rejects empty strings, floats, NaN, Infinity, zero, and unsafe integers.
- **Backup/restore.** Backup tars the whole controller volume, so `credentials.json` travels with `state.json`.

Non-blocking items, in priority order:

1. **Legacy token now gets the per-credential pending cap.** The team token previously allowed up to the global limit of pending or failed releases. It now stops at the per-credential default of five. That is a silent behavior change for existing workflows. Either exempt `team-token` or note it in `.env.example`.
2. **Memory headroom with two concurrent max uploads.** Each admitted upload holds the raw body, the parsed JSON, and the decoded buffers at once, roughly 170 MB for a 32 MB artifact. Two concurrent uploads approach the 512 MB container limit. Worth one qualification run with two concurrent max-size submissions to confirm the controller is not OOM-killed mid-write.
3. **Authenticated slow uploads can pin both upload slots** for the 300 second request timeout. Acceptable for a trusted team, but it means one misbehaving teammate blocks all deploys for five minutes.
4. **Quota scan fails startup on any non-regular file** under `artifacts/`, with a symlink error that does not mention the quota or recovery path. Fail-closed is the right default, but the message should name the directory and tell the operator to remove or inspect the entry.
5. **Credential init hides the underlying error.** A permissions or JSON error on `credentials.json` becomes a generic "restore controller storage" message. Append the original error code.
6. **Nits.** Non-object JSON on the credentials endpoint produces a raw TypeError message in the 400 body. The help text for `fogd status` still says "team deploy token". Scope and revocation refusals return 400 rather than 403, which the smoke asserts, so changing it later means touching the smoke.

Nothing here requires code changes before committing M8b1. Items one and two are the ones I would resolve or document before calling the slice qualified.
