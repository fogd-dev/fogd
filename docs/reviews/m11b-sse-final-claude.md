# Claude SSE final review

I found no correctness bugs in the source or dist. The new `/register` serialization is sound: it can't deadlock and doesn't change semantics. The weak points are in the evidence, not the code: one doc claim gets ahead of the browser run, and some test assertions are looser than what they claim.

## What I checked myself
- **Generator reproduces.** I ran `scripts/patch-void-live.mjs` on a temp copy of the installed package. The output is byte-identical to the installed `dist/runtime/live-server.mjs`.
- **Source patch matches the checkout.** `git -C .upstream/void diff` equals `patches/void-1.1.11-live-registration.patch`, ignoring `index` lines. The checkout is on `6ef71cf` and its `package.json` says 1.1.11.
- **Dist differences are only the patch plus formatting.** The OXC-vs-rolldown changes are `/* @__PURE__ */` removed, `void 0` → `undefined`, braces added, and the export moved inline. The tail `export { createLiveDurableObject }` is gone, so there is no duplicate export. The remaining import names match what the TS source imports.
- **Install is clean.** Every importer in the lockfile uses `patch_hash=cc05…`, and the root, checklist and guestbook installs all resolve to that one directory. The older `.pnpm/void@1.1.11*` directories are unreferenced leftovers.
- **Tests pass on the installed file.** `node --test scripts/void-live-probe/registration.test.mjs` passes 11/11 and prints the installed dist path. The module also imports in plain Node and exports `createLiveDurableObject`.

## Register serialization
**No deadlock.** While queued on the chain, `register` waits only on storage and on `findStaleSubscriberKeys`. That function's `/check` calls go through `fetchWithTimeout`, so they're time-bounded, and `/check` on the connection side makes no outbound calls. A topic → connection → topic cycle can't form.

The capacity test also covers the closest real case:
- The connection's `subscribe` is waiting on the topic `/register`.
- That register calls back into the same connection's `/check`, which gets served.
- A second register on the same topic is queued behind it.

The chain never rejects (`then(()=>{},()=>{})`), so one failure can't jam later registrations.

**The capacity bound now holds.** `register` is the only code path that adds rows. Publish, unregister and the alarm only delete, so a snapshot taken before the `/check` await can only overcount. Rows deleted after a stale verdict stay deleted, for two reasons:
- Revisions only go up.
- Every row is either pending (which `/check` treats as not stale), installed, or dead.

**Semantics are preserved.** Raw POSTs now commit at the topic in arrival order. Ordering for the same subscription is still decided by the revision early-return and `canInstall`, so newest-started-wins and the unknown-state boundary are unchanged. Both are documented in `docs/patches/void-live-registration.md` and `docs/decisions.md`.

**One real cost: queueing at a full topic.** Each register at capacity does a full stale scan, which takes up to `ceil(connections/6) × deliveryAttemptTimeoutMs`. The caller's `topicStub().fetch` has no timeout of its own. So k concurrent attempts against a full topic now take about k times as long, where before they ran in parallel. A reconnect storm is the likely trigger. This is a latency issue, not a correctness one; one sentence in the patch doc covers it.

## Findings, most important first
1. **The doc claims the browser result before it exists.** `docs/patches/void-live-registration.md` (Verification section) says "The fogd browser test verifies SSE cancellation/reconnection across actual approval and a later edit." That run is still underway. Mark it pending until `.fogd` holds a passing `sse-update` record.
2. **`live-sse-update.mjs` doesn't assert the order it claims.** The snapshot check only requires `s.at >= activationStartedAt`, which is not "after registration". To match the stated scope:
   - Record when control acks arrive, through the existing fetch wrapper.
   - Require the v2 snapshot to come after the first successful ack following `close.at`, or at minimum after the reopen `open`.

   I traced the listener order (the observer's `disconnected` runs before the client's `onError`), so a false pass is unlikely today. Still, the assertion should encode the claim rather than depend on that order.
3. **The capacity negative depends on timing.** The test releases the first check after a single `setImmediate`. Against the unpatched code, the second register has to reach its `/check` within that tick. It does now, per the negative log. A safer gate: wait until the second request reaches `hooks.beforeRegister` (connection side, which the chain doesn't block), then yield. That keeps the negative reliable without stalling the positive case.
4. **The dist imports are never loaded by the tests.** The harness removes the dist imports and substitutes stubs, so a wrong chunk specifier or alias would still pass all 11 tests. Add one line to the test file: import the installed file for real and assert `typeof createLiveDurableObject === 'function'`. I ran this by hand and it passes.
5. **Generator robustness (minor):**
   - It doesn't check that `.upstream/void` is at `6ef71cf` with only this patch applied, so a dirty checkout would ship silently. A `git rev-parse` plus a check that the diff matches the patch would close that.
   - It removes every import from the transpiled code. A future source import of some other helper would be dropped and only fail at runtime. The 6 harness stubs would catch it only if a test exercised that path. An assert that the dropped import names are a subset of the preserved dist import names would close it.
6. **The upstream lint and typecheck logs don't prove a pass.** `m11b-upstream-lint-all.log` and `m11b-upstream-typecheck2.log` each hold only the command banner. Silence probably means it passed, but record the exit code (`; echo exit=$?`). The 25/25 live-server test log is conclusive.
7. **No test that publish and unregister keep moving.** The source comment says a stuck register doesn't block publication or cleanup, but nothing tests it. While the first register is held in `afterCheck`, run a `publish` and an `unsubscribe` and assert both resolve. This is cheap.

## Verdict
- **Source and dist:** correct; nothing blocks applying them.
- **Generator:** reproducible, with the guards in finding 5 recommended.
- **Register serialization:** sound, no deadlock, semantics unchanged; document the queueing cost at a full topic.
- **Tests:** findings 3 and 4 should go in before relying on these as regression gates.
- **The observer stays experimental:** fix finding 1 now; finding 2 and the in-progress browser run are still needed before it can drop that label.

I changed nothing in the repo. The only file I wrote was the generator's output in a `mktemp` directory.
