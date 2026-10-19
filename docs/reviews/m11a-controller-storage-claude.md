# Claude review: controller persistence failure

No blockers. On the `state.json` path the latch does what you described: every save and catch path I traced in `controller.mjs` either fails closed through the latch or was already safe. You have three important gaps and three minor ones. Your logs show 113/113 tests passing, the build completing and the quality gate passing. I didn't run anything myself.

## Catch and effect paths I checked (all OK)
- **`submit` catch (L116):** if the save committed and then threw, the latch fires first, so the artifact and the in-memory record are kept. Errors before the save (`receiveArtifact`, `available`, `compatible`) still clean up.
- **`prepareActivation`:** a failed save at L174 throws before any backend effect. Failures at L181 (new app record) or inside `reconcileLedger` (L141) reach the catch, and `assertStorage` stops it before the failed-status save.
- **`activate` catch (L229):**
  - Any failed `step()` save, including `complete` after `app.active` and `route` were set in memory, trips the latch before the error-path `reconcile`.
  - So `backend.applied` isn't called. Test 2 covers this (`applied === 1`, `migrated === 0`).
  - If `reconcile`'s own save fails inside the L231 catch, the error is appended to the message and the next `save()` throws the coded error.
- **Private-config wrapper in `reconcile` (L123):** it drops `error.code`, but every caller checks `assertStorage` again before acting, so this doesn't leak.
- **`exclusive`:** it checks the latch before each task, so queued tasks and later credential and secret mutations are rejected.
- **`route()` returns `paused` for every app:** this is consistent with the gateway, which already returns 503 (`gateway.js:16`) when the controller is unreachable. Latched behaves the same as down.

## Important

1. **The original persist error is thrown away.** `catch { this.#storageFailed = true; ... }` (L84) keeps no `cause` and logs nothing.
   - The operator sees "restart". If the cause is ENOSPC or EIO, the restart's `init()` save fails again, and nothing says why.
   - Fix: log it on the server side (`console.error` with the errno code and path), or attach it as `cause` and strip it at the HTTP layer. The HTTP layer already sends only `error.message`.
   - This keeps the private details out of responses while leaving them diagnosable.

2. **A submission whose save fails before the durable write leaves an orphaned artifact.**
   - Because the `submit` catch now skips `rm` whenever the latch is set, it also keeps the artifact when the write never committed.
   - After restart, `state.json` has no record for it, but `quota.init` counts every file under `artifacts/`.
   - Admins can't see it, and nothing frees those bytes for good. That hurts most in exactly the disk-full case.
   - Once `state.json` has been reloaded it is the source of truth, so `init()` can safely spot artifact directories with no deployment record and report or remove them.
   - No test covers this. Your test 1 only covers the case where the write did commit.

3. **`credentials.json` and `secrets/index.json` have the same commit-then-throw ambiguity, outside the latch.**
   - `Credentials.issue/revoke` and `Secrets.replace` call `saveJson` directly, then update memory (`this.records = next`).
   - **`revoke`:** if the write commits and then throws, the disk says revoked but memory doesn't. The credential keeps authenticating deploys until restart, and the admin got a 400.
   - **`replace`:** the disk index can point to a revision the admin was told failed.
   - Nothing trips the latch on these, so the name `CONTROLLER_STORAGE_UNCERTAIN` and "metadata write failed" claim more than the change covers.
   - Either route these saves through the same latch (pass in `#persist` plus a latch callback), or describe the scope as `state.json` only in the commit and docs until the Delivery and bootstrap integration.

## Minor
- **`activate` `finally { await this.secrets.cleanup(id) }`:** if cleanup throws, it replaces the coded error. The response becomes a 400 and the restart message is lost. Unlikely, since `cleanup` probably uses `rm` with `force`, but it's cheap to guard.
- **Race on credential and secret requests:** if the latch trips while one is waiting for `body()`, the coded error is thrown inside the controller call and reaches the outer catch. That should give 503, which is correct. But the CSRF `try` in `admin-credentials` and `admin-secrets` only covers `checkMutation`, so nothing is wrong here; I'm only noting I checked it.
- **First activation:** if the save at L181 fails after `backend.claim`, it isn't tested.
   - If the write didn't commit, restart quarantines the slot ("Bucket owner has no controller record"). That's the existing crash behaviour, not a regression.
   - But it's the most likely real ambiguity on a first deploy. One test showing the restarted result would make the "fresh controller recovers" claim honest for that path.

## Claims match the code
The tests don't claim more than the code does:
- Test 3 asserts that the in-memory `route` stays `active` while the gateway sees `paused`. That matches your note that the runtime isn't drained.
- Test 4 checks that 401 responses are unchanged and that the private message is withheld.

The latch message says "restart to reload durable state". That's accurate, as long as you treat item 2 as a known orphan-artifact case.
