**Verdict: not ready for the browser integration gate.** Two issues need fixing first, because each one breaks a guarantee m11b states explicitly: (1) operations can reach the server before the snapshot and rollback check, and (2) a restored room can make a tab freeze silently. Two smaller issues are worth fixing in the same pass. The rest is close: per-operation keys, same-ID resend, terminal rejection removal, and the server's `input.mjs`/`wire.mjs` import change all look right.

## Must fix

**1. Void's `connect` still sends some writes from its own buffer, before the snapshot.**
In `node_modules/void/dist/runtime/ws.mjs:76-81`, `VoidSocket.send` only sends directly when `readyState === 1`. Otherwise it pushes the message into `buffer`, and the `open` handler sends that buffer before it emits `open` (lines 47-50).
- The browser sets `readyState` to CLOSING/CLOSED before the `close` event runs. During that window `session.ready` is still true.
- A `submit` in that window goes to `flush` → `socket.send`. The message is buffered without error and `sent.add(opId)` runs.
- On reconnect, Void sends the buffered operation **before** `model.opened()` and before the snapshot arrives. A restored, lower-revision server then applies it before `snapshot()` can stop writes. That breaks "stop automatic writes" on rollback.
- After the snapshot, `flush` sends the same operation a second time (`sent` was cleared). That is the duplicate retry on top of the pre-open buffer that the doc rules out.
- In production `send` never throws, so the `catch { this.disconnected() }` at `session.mjs:101` never runs. The test at `test/session.test.mjs:67` covers behavior this client can't actually have.
- Fix: in `index.tsx`, make the send callback throw unless `socket.socket?.readyState === WebSocket.OPEN`. Your existing catch path then handles it. Or construct the socket with options that never buffer, if Void exposes any.

**2. A restored room silently freezes a tab whose rollback floor is stale.**
- `connectionFloor` is set only from this tab's own in-memory `watermark` (`disconnected()`, line 48).
- `snapshot()` folds the shared storage high into `this.watermark` (lines 64-68), and line 66 drops any snapshot below that value.
- Scenario: tab A observed revision 10 and tab B observed 3, both on the same room. The server is restored to 7.
  - B reconnects, and 7 ≥ its floor of 3, so it doesn't detect the rollback. B also flushes pending operations into the restored room.
  - B's watermark becomes 10. Snapshots 8 and 9 are then dropped with status still "Connected", until the server passes 10. That is exactly the "silently stall" m11b forbids.
- Fix: in `disconnected()`, use `connectionFloor = Math.max(this.watermark, this.readWatermark())`. Filter rendered snapshots against this tab's own observed revision only, but still write `max()` to storage.
- Add a two-tab test where the floors differ and the room is restored.

## Should fix

**3. The blocked state hides the restored state and has no way out.** The rollback error says "Review the restored state", but `snapshot()` throws before it assigns `view.items`. The user sees an empty or stale board, not the restored one. The persisted watermark also keeps the tab blocked across reloads, with pending operations stuck and no reconcile action short of clearing localStorage.
- Fix: render the snapshot before blocking.
- Then either add an explicit "accept restored state" action (reset the watermark, keep the pending operations), or document that this fixture accepts the dead end.

**4. Mapping `error` to `disconnected()` can leave a healthy socket stuck.** Void also emits `error` when it can't parse a message as JSON (`ws.mjs:52-56`), and the socket stays open. The tab then sets `ready=false`, shows "Reconnecting" and resets `connectionFloor`. `fresh` is still false, so the next snapshot sets `ready=true` but never calls `flush`. Operations submitted in that window sit unsent until another submit, a storage event, or a real reconnect.
- Fix: drop the `error` → `disconnected` listener. A real browser socket error is always followed by `close`, so nothing is lost.

## Minor (fine for a fixture; noting them)

- **Strict local validation of saved operations.** Line 26 throws on any saved entry that `parseOperation` rejects, and that blocks the whole room. An operation saved by an older client version therefore never reaches the server for the explicit rejection m11b asks for. This will matter for acceptance step 5 (v1/v2 compatibility).
- **Every tab sends every pending operation for the room.** The server's receipts make this idempotent, so it is safe. But a rejection message appears only in whichever tab settles first, which may not be the tab where the user made the edit.
- **Storage race hardening.** `pending()` turns `getItem() === null` into a fatal "Invalid saved operation". Chrome processes storage changes from other tabs on the main thread, so this is unlikely to trigger. Skipping null entries would be safer than calling `fail()`.

## What looks correct
- Each operation is persisted before it is sent, and nothing goes out until the first snapshot of each connection.
- A snapshot doesn't count as an acknowledgment; the operation is resent with the same ID.
- Terminal rejections remove the pending entry and show the reason.
- Storage failures stop writes.
- Storage keys are scoped by room. The trailing `:` in the prefix stops room `shared` from matching `shared-2`.
- Revisions only increase within a session.
- The server change only moves `parseOperation` and `ServerMessage` into shared modules; there is no behavior change.

## For the browser integration test
Cover findings 1 and 2 directly:
- Submit while the socket is closing and assert the server receives nothing before the snapshot.
- Run two tabs with different floors against a restored room.
