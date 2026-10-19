# Claude SSE pending review

I read the whole patch, the patched `live-server.ts`, the harness, the tests, the regression script, the 1.1.11 client and the shipped `dist/`. I did not run upstream vitest, typecheck or lint. Some files changed while I was reviewing: the test file now has 10 tests and the harness also accepts double-quoted imports. I re-read both.

## Verdict

The server logic is sound for what it sets out to fix. The ambiguous-reply boundary is acceptable if it is documented, so it is not a blocker. Applying the patch is blocked on packaging and verification, not on the logic.

## Blockers to applying

1. **The patch targets source that isn't installed.** `void@1.1.11` ships only `dist/` (`dist/runtime/live-server.mjs`). `patches/void-1.1.11-live-registration.patch` patches `packages/void/src/...`, so pnpm cannot apply it.
   - The fix needs a hand port to `dist/runtime/live-server.mjs`.
   - That port has to be merged into the existing `patches/void@1.1.11.patch`, which already patches `dist/runtime/ws.mjs`. pnpm accepts one patch per package version.
   - The `.fogd/void-live-package/dist/runtime/live-server.mjs` copy currently contains no `pending`, so the port hasn't been committed yet.
   - Keep the source patch as the upstream PR artifact. Only the dist hunk ships.
2. **Test the shipped file, not just the source.** `m11b-sse-pending-dist-tests.log` shows 10 passing tests, but it doesn't record which file was loaded. Run the same harness against the patched `node_modules/.pnpm/void@1.1.11_patch_hash=*/…/live-server.mjs` after install, and record that path in the log. Also run the original regression script against that file.
3. **Upstream's own suite hasn't been run against the change.** `test/unit/live-server.test.ts` has relevant cases:
   - :363, replacement survives an unregister failure
   - :449, reconnect generation cleanup
   - :81, stale prune before the topic cap
   - :522, hook-error hiding
   
   Run that suite, the typecheck and `vp lint` in `.upstream/void`. The dense one-liners will fail upstream formatting. That is irrelevant for the pinned patch but needed before any upstream PR.

## Ambiguous reply loss after a topic commit

This is a reasonable explicit boundary:
- **It isn't new.** 1.1.11 loses rev N the same way: the rev N+1 row commits, rev N's row is deleted, and the next delivery treats rev N+1 as stale and prunes it.
- **It only affects a same-id, same-topic resubscribe.** A different-topic replacement never touches the old topic's object, so the old row survives a thrown fetch.
- **It's inherent to RPC.** The outcome isn't knowable without a protocol change.

Word it honestly, though. The native client contradicts it: `live-client.ts:348-356` restores `previousSubscription` on any failure, so a native Void caller believes the prior subscription is still live. Your observer's "Not subscribed" plus explicit reload is the right UX. The patch notes should say: "after a control error, server state for that id is unknown; resubscribe or unsubscribe." Don't add re-register-on-throw logic; that is protocol growth.

## Supersession and error codes

- **New loss mode, though the official client can't reach it.** "Newest started wins" interacts badly with a newer request that fails:
  - rev2 commits at the topic, which deletes rev1's row. Rev3 for the same id starts before rev2's reply arrives, so rev2 is invalidated.
  - Rev2 settles as superseded and unregisters its own row. Rev3 then fails cleanly (409 or a pre-effect throw).
  - The id ends up with no row, and both callers got errors. In 1.1.11 rev2 would have survived.
  
  `live-client.ts` serializes flushes through `flushChain`, so one client never sends overlapping control requests, and reconnects change generation. Only raw concurrent `/control` POSTs reach this. Document it ("concurrent control for one id: the last one started wins; if it fails, the id may be unsubscribed") rather than fix it.
  
  If you'd rather close it, a smaller policy works: don't call `invalidatePending` when a subscribe starts (keep it for unsubscribe and connect), and rely on `canInstall`'s revision comparison so the highest *successful* revision wins. The topic-side `>=` guard already stops an older row from landing after a newer one.
- **`CONNECTION_CLOSED` for supersession** is acceptable. It's an existing code, and adding one would change the public `LiveControlErrorCode` union and the client. The message disambiguates.
- **A thrown register fetch still aborts the whole `/control` batch with a 500**, the same as 1.1.11. Earlier operations in that batch are committed on the server but rolled back by the client, which leaks active ids against `maxSubscriptionsPerConnection` until reconnect. This matters for reconnect resubscribe batches. A small optional fix is to catch inside `subscribe` and return `fail('INTERNAL_ERROR', …)` so each operation reports accurately. It is not needed for this patch.

## Concurrent register storage windows

- **On Cloudflare** the `list → delete → put` sequence in `register` is atomic under input gates, except when the topic is at capacity and `findStaleSubscriberKeys` makes an outbound `/check`. Two registers can interleave there.
- **I checked that the winning row can't be deleted by any interleaving:**
  - A losing register can only delete keys from its own `list` snapshot.
  - It returns early if it saw the newer row.
  - `/check` reports pending and installed rows as not stale.
  - Unregister deletes only exact keys.
- **Worst case is a temporary extra row, which self-heals.** The loser's row survives, it is unregistered when the loser settles, and the next deliver prunes it if that fails. The topic can briefly exceed its cap by one. That is the same as 1.1.11.
- **This argument still holds if celld doesn't implement input gates.** It does depend on each Durable Object name mapping to one live instance, because the `pending` map is in memory. Treat that as the celld assumption to qualify. The model tests can't show it, and a browser run can't show the race. Qualification is the regression script and tests passing on the patched dist file, plus the native browser run still passing.

## Checked and fine

- Reservation, `invalidatePending` and the limit check all run before the first await. Pending ids count toward the connection limit.
- Removing the pending entry at install, before awaiting the old row's unregister, closes the alias. Test 10 covers it.
- The `isStaleSubscriber` exception requires id, `topicKey` and revision to match, and the entry to be active. Cleanup that relies on strict stale detection keeps working.
- Topic-side guards: a newer generation, or the same id at a higher or equal revision, means "ok, no write". That is idempotent and correct.
- A counter that isn't persisted is safe: generation is persisted and part of the key, and eviction forces a new connect. Revisions in a reused same-owner map come from the same instance, so they stay monotonic.
- Unsubscribe deletes the local entry first and then unregisters on a best-effort basis. That changes the old 500 into ok plus prune-on-delivery, as the design intended.
- Reconnect and close mark pending entries inactive. Old requests in flight fail on `this.connection === connection` or on the abort check, even though the subscriptions map is shared.

No packages were published, nothing was mutated, and no Cloudflare calls were made.
