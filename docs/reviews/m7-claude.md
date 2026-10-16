Review complete. Findings below, ordered by priority, then the verdict.

## Findings

**1. Medium, reproducibility and privacy: the approved digest embeds absolute host paths.**
`packages/runtime/src/artifact.mjs:122` copies the whole `dist/ssr` into `worker/`, including Void's raw `wrangler.json`. That file carries `configPath` and `userConfigPath`. I confirmed it in the latest staged release under `.fogd/releases/guestbook/`, where the value is `/Users/sgtpooki/code/.../.fogd/fullstack/v2-h8QKuQ/.void-wrangler.jsonc`. It is included in `artifactDigest`, so:
- The same source built by a second developer, or even a second smoke run on this machine, produces a different digest. Exact-artifact approval cannot be cross-checked against an independent build, which is the reproducibility acceptance row.
- The admin review manifest publishes local usernames and temp dir names.
`worker/.vite/manifest.json` and `worker/index.js.map` are also digested but are deterministic. The fix is small: skip `wrangler.json` when copying the bundle dir, or copy only `main` plus its referenced chunks and maps. This is pre-existing, but M7a is the milestone that claims reproducibility, and `docker/verify.Dockerfile` never compares digests so it will not catch it.

**2. Low to medium, test coverage: asset privacy is proven only at staging, not at the served edge.**
`packages/runtime/test/artifact.test.mjs` proves `stageAssets` drops `.assetsignore`, `.env*`, `wrangler.json` and honors negation. Nothing in `scripts/fullstack-smoke.mjs` asserts the deployed app returns 404 for `/.assetsignore` or `/wrangler.json`. One `appRequest` per path after the first approval would close the loop that the docs describe ("excluded files do not enter the approved artifact"). Note that `/.vite/manifest.json` is intentionally served, matching Wrangler.

**3. Low, build maintainability: `output` is clobbered rather than merged.**
`packages/cli/src/build.mjs:20-24` spreads the existing `rolldownOptions` (so the Cloudflare plugin's `platform: 'neutral'`, `preserveEntrySignatures: 'strict'`, and `resolve` survive) but replaces `output` wholesale. The previous code returned a partial that Vite deep-merged. Today no upstream plugin sets `output` on `void_worker`, so behavior is unchanged, but the upstream pattern you cite (`void:vinext-worker-entry`) only touches `input`. Use `output: { ...config.build.rolldownOptions?.output, codeSplitting: false }` to keep that property.

**4. Low, documented boundary: symlinks under ignored asset paths still fail staging.**
`artifact.mjs:125` runs `regularFiles` before `stageAssets`, so a symlink that `.assetsignore` would exclude throws. Void's packager allows excluded symlinks. Acceptable strictness, but `docs/build-output.md` says exclusions follow Void's packager without noting this difference.

**5. Low, verification fixture gaps.**
- `docker/verify.Dockerfile` builds both targets into the same `dist/`, so the second build overwrites the first. The acceptance row asks to "record configuration and bundle differences"; nothing captures them. Writing the ordinary build to a separate outDir or listing both before the second build would make the image produce that evidence.
- Offline execution depends on the operator passing `--network none`. The notes record it, but nothing in the repo enforces or checks it.

**6. Nits.**
- `packages/platform/test/platform.test.mjs:138-143` proves the status response hides the raw SQL error but does not assert the raw error remains visible in `/v1/admin`, so a future over-redaction would pass silently.
- `examples/guestbook/tsconfig.json` includes a `src` directory that does not exist.

## What checked out

- **Status authorization** in `packages/platform/src/http.mjs:18-32` is sound: constant-time token compare before any lookup, 401 without the team token, 404 for unknown ids and non-team submitters, `deployments` is a null-prototype object, and the `/artifact` subpath still falls through to admin auth. `deployment-status.mjs` never reads `request.error`, `resources`, or `version`.
- **Asset exclusion** mirrors Void's `createAssetsIgnoreFunction` pattern set exactly, keeps root `_headers`/`_redirects` for celld, and celld's own rejection only applies to the root `.assetsignore`, which is the only one removed. Consistent.
- **Worker entry override** matches upstream's `void:vinext-worker-entry` approach and the resolved config preserves the Cloudflare plugin's other rolldown settings.
- **Second release** adds `label NOT NULL DEFAULT 'visitor'`, so v1 inserts during the non-draining pause still succeed. The smoke asserts the old row carries the default and survives a controller/workerd restart.
- **Negative type assertions** in `type-tests/client.ts` are self-validating: an unused `@ts-expect-error` fails `tsc`, and the directory is in `tsconfig.include`, so the Docker typecheck exercises them.
- **Dependency plumbing**: `ignore` is declared in `packages/runtime/package.json`, and `docker/runtime.Dockerfile` installs runtime prod deps, so the controller's `receiveArtifact` import chain resolves.

## Verdict

**Approve with changes.** No blocking correctness or security defect in the new code. The one substantive hole is finding 1: host paths in `worker/wrangler.json` make the approved digest machine-specific, which undercuts the milestone's reproducibility claim and leaks local paths into the admin manifest. Fix that and add the two served-path 404 assertions (finding 2) before recording M7a as qualified. Findings 3 to 6 are small hardening and documentation items.
