**Verdict: approve with fixes.** The core SQL protocol is correct. The edit, the revision bump and the receipt commit together in one `transactionSync`, and nothing sends from inside it. Receipts are looked up before the capacity check and before validation. Replays are compared on the normalized payload, and refusals don't use up revisions. All 5 tests pass on real `node:sqlite`. Fix the first two items before the Docker run treats this as protocol evidence. I checked the route against the pinned Void source (`void@1.1.11` `dist/runtime/ws-server.mjs`).

## Fix before the Docker check

1. **If the ack send throws, the other clients never get the snapshot.** In `routes/rooms/[room].ws.ts:30-31` the edit is already durable before `await ctx.connection.send(...)`. Void's `send` and `broadcast` call `webSocket.send` directly (ws-server.mjs:113, 133). If the sender closes right after sending, that call can throw, and then `broadcast` is skipped. Peers keep a stale board until they reconnect.
   - The same problem exists inside Void's `broadcast`: one closing socket returned by `getWebSockets()` aborts the loop for every socket after it. That is upstream behaviour; record it, don't shim it.
   - Fix: try/catch the ack send so the broadcast always runs, or broadcast first and then ack.
   - Docker check: the sender closes immediately after sending a valid op; assert that the peer still receives snapshot rev N.

2. **A GET request to any room name creates storage.** `onRequest` (`[room].ws.ts:33-35`) never checks the room name; only `onBeforeConnect` does, and that hook runs only for upgrades (ws-server.mjs:193 vs 216). `new Board()` runs `CREATE TABLE` and `INSERT OR IGNORE`, so `GET /rooms/<anything>` creates a populated Durable Object for any URL-decoded name. Fix: run the same regex in `onRequest` and return 400 when it fails.

## Decide and document

3. **Rejections aren't recorded, so "terminal" doesn't hold across retries.** Only acks write receipts. Example: `set item-x` is rejected with `unknown-item`, the client resends the same opId after someone adds `item-x`, and it gets acked. The doc line "a duplicate returns the prior result" (m11b.md:52) reads as if this can't happen. With per-room localStorage keys shared by two tabs, one tab can show the rejection while the op is applied anyway. Two ways out:
   - Store the semantic rejections (`unknown-item`, `item-exists`, `item-capacity`) as receipts. They then count toward the 1,000 limit.
   - Or state in the doc that rejections are re-evaluated on retry and are only terminal for the client that received them.

   Either way, add a test for it.

4. **The initial snapshot is sent before the 101 response.** Void calls `onConnect` after `acceptWebSocket` but before it returns the 101 (ws-server.mjs:208-214). Whether workerd and celld buffer that first frame is exactly what the Docker check must show. Assert that the first message the client receives is the snapshot. The transport probe didn't cover this.

## Minor / portability

- **opId echo:** an invalid opId is echoed back unbounded (`rejected(opId, …)`). Truncate it, or reply with `opId: ''` for `invalid-operation-id`.
- **Double validation:** `wire` runs `ServerMessage.parse`, and Void validates the same message again on send. Plain `{ ...m, release: 'v1' }` is enough on the WebSocket paths. Keep the parse only for `onRequest`, where nothing else validates.
- **Schema setup on every call:** the `Board` constructor runs its DDL on every message, connect and GET. It's cheap, but it's an implicit write outside the transaction on every read. That's acceptable for a fixture; add a `ponytail:` note or memoize per instance.
- **`RETURNING`:** `UPDATE … RETURNING revision` would replace the update-then-select pair. Durable Object SQLite supports it, and so does node:sqlite.
- **Test fixture fidelity:** good. The adapter's `exec` returns arrays and the code only spreads results, so it behaves the same on real cursors, and the code never issues raw `BEGIN`, which real Durable Object SQL rejects. No bigint mismatch, because node:sqlite returns numbers by default.

## Test gaps (acceptable for this slice; track them)

- The doc asks for tests of concurrent clients, but no test exercises the route: origin 403, room 400, broadcast fan-out, wire schema and the 1007 path. Two of these belong in the Docker check: the close-after-send case in item 1, and an upgrade with an `x-forwarded-host` that doesn't match `Origin`.
- No test pins down how a retried, previously rejected op behaves (item 3).

Browser pending storage, reconnect and SSE aren't claimed in this slice, and I didn't review them as complete.
