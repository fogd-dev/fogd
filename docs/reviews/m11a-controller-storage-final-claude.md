# Claude follow-up: controller persistence failure

No blockers. One important gap is left: the docs promise the original error is kept "for operator diagnosis", but nothing ever shows it to an operator. I ran `packages/platform/test/platform.test.mjs` and all 30 tests pass. I didn't run the full 118-test suite or the build.

## Prior findings, now resolved

**Shared callback.** `Credentials` and `Secrets` now get `persistMetadata`, which goes through `#saveMetadata`. A grep shows no direct `saveJson` calls left in the controller path; the only other write is `materialize`'s `writeFile` into the execution directory, which isn't metadata. The latch check happens before the write, and a failed write trips the latch before memory changes (`this.records = next` and `this.index = next` never run). The standalone defaults still use `saveJson`.

**Stale credential after an ambiguous revoke.** Memory still has the credential as valid, but `deployment-http.mjs:15` calls `assertStorage()` after authentication and before both the submit and status branches, so the holder gets a 503 instead of access. After reload the credential is revoked; the test checks both `authenticate` and `submit`. The only side effect is that a revoked holder sees 503 instead of 401 until restart, which is harmless.

**Unreferenced artifact report.**
- `quota.init` now runs after `state.json` loads.
- The check uses `Object.hasOwn` against the deployments, which have a null prototype, so names like `__proto__` are safe.
- Bytes still count toward `used`, so `admit` stays conservative.
- `retirement.mjs` keeps deployment records rather than deleting them, so retired apps don't show up as false positives.

**Failure paths in `prepareActivation` and `activate`.**
- Every catch checks the latch first.
- If cleanup fails while the latch is set, it throws a new coded error with the same cause, which the test checks.
- If the latch isn't set, a cleanup failure behaves as before.
- If the save inside error-path `reconcile` latches, the error is swallowed into the message and the following `save()` throws the coded error.

**First claim.** Both cases match the docs:
- If the app record write committed, the app can be retried after restart.
- If it didn't, the slot is quarantined after restart.

**HTTP.** The response only includes `error.message`, and the test checks that the private diagnostic text is withheld.

## Important

1. **The cause is kept but never surfaced** (`controller.mjs:78`, ADR 027, `recovery.md`).
   - `#storageCause` is only attached to thrown errors, and the HTTP catch drops it.
   - There are no `console.*` or log calls anywhere in `platform/src` apart from the startup line in `main.mjs`.
   - So an ENOSPC or EIO lands in an object nobody reads. The operator sees "restart", the restart may fail the same way, and there's still no errno.
   - "Retain the exception cause for operator diagnosis" overstates this. The tests only prove the cause is attached (`e.cause === cause`).
   - Cheapest fix: log `error.code`, `syscall` and `path` once from `#saveMetadata`'s catch when the latch first trips. Otherwise change the docs to say the cause is attached for in-process callers only.

## Minor

- **Unreferenced secret revisions aren't reported.** In `Secrets.replace`, if `${revision}.json` commits but `index.json` doesn't, a file holding secret values stays on disk with nothing referencing it. `saveJson` also leaves a `*.tmp` file containing those values when the write itself fails (this was true before the change). Both are mode 0600 in a 0700 directory, so this is a hygiene problem, not exposure. The recovery doc only covers unreferenced artifacts; one sentence for secrets would close it.
- **A credential issue that commits and then throws leaves a live record nobody has the token for.** After reload it appears as an active credential. It can't be used, because only the hash is stored, but an admin will be confused by it. One line in the docs: "revoke unrecognized credentials after reload".
- **The quarantine guidance has no concrete step.** For the uncommitted first claim, `recovery.md` says "Restore matching controller and bucket state", but there's no matching controller state for that app to restore. Say what the operator should actually do, or point to the stopped-recovery section by name.
- **The admin page always shows the unreferenced-artifact sentence**, including "0 unreferenced artifact directories…". It could appear only when the count is above zero. The `?.length || 0` guard is unnecessary because `describe()` always returns an array.
- **Small coverage gaps:**
  - Unreferenced directories with no files aren't reported. They hold no bytes, so this is fine.
  - The list is a startup snapshot, and the wording says so.
  - No HTTP test sends a stale revoked token through the bearer path. The code order covers it, and test 4 covers the team token.
- **The test summary in `recovery.md` is out of date.** It lists only the first two scenarios. The secret, credential, cleanup and first-claim tests exist but aren't described.

## Claims match the code

- The docs don't claim real disk-full or power-loss behaviour, and they don't claim a drain.
- The tests use the real `saveJson` with failures injected before or after the write.
- "Queue admission still rejected; bootstrap integration next" is consistent with what changed: nothing in this diff touches queue admission.
