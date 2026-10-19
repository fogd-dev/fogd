I found the likely defect. It's in celld, not in Void or the checklist app. Void calls `serializeAttachment` on the server socket before `acceptWebSocket`. celld's Rust registry has no entry for the socket at that point, so it drops the bytes. The attachment then exists only in the JS socket object. That object survives idle eviction but not a generation swap, because the swap starts a new isolate.

## The failing sequence (read from source and logs; nothing run)

1. **Void writes the attachment first.** In `.upstream/void/packages/void/src/runtime/ws-server.ts`, `setStoredConnection(server, stored)` runs at line 328 and `this.state.acceptWebSocket(server)` at line 338.
2. **celld keeps it only in JS.** `serializeAttachment` (`harness.js:10659`) stores `this._attachment = value` and calls `__ws_attachment_set(this._id, …)`. That op (`js/websocket.rs:750-769`) only writes if a registry entry already exists. `WebSocketPair` / `__ws_alloc` (`websocket.rs:284`) just allocates an id and creates no entry, so before accept the write does nothing.
3. **Accept doesn't recover it.** `op_ws_accept` (`websocket.rs:659-673`) creates the entry with `attachment: None`. `acceptWebSocket` (`harness.js:2809-2820`) never re-sends `ws._attachment`. Nothing else in the repo writes the attachment, and nothing tests the attach-before-accept case.
4. **The swap starts a new isolate.** At log lines 856-868 slot-2-b starts isolate 10 for generation 3, retires isolates 9 and 3, swaps all six cells out, and starts them again in isolate 11 (`fresh=false`).
5. **The new isolate reads an empty row.** `__sockets` (`harness.js:10365`) belongs to the isolate, so in isolate 11 it is empty. `_socket(24)` then goes through `getWebSockets` → `__ws_list` → `__socketFromRow` (`harness.js:10700`) with `row.attachment == null`, so `deserializeAttachment()` returns undefined. Void falls back to `params: {}`, and your guard throws `Missing checklist room attachment` (log line 881).
6. **Why idle eviction passes.** This step is inference; I didn't confirm it in a log. Idle eviction drops the cell's residency but appears to keep the pool isolate. The original JS `WebSocket` object stays in `__sockets` with its in-memory `_attachment`, so the empty Rust row never gets read. The deployment test is the first one that replaces the isolate while a socket is held.

## Minimal upstream patch (`.upstream/celld/crates/celld/js/harness.js`)

```js
  serializeAttachment(value) {
    this._attachment = value;
    // Keep the bytes: a pre-accept call has no registry entry to land in yet.
    this._attachmentSc = __sc_encode(value);
    __ws_attachment_set(this._id, this._attachmentSc);
  }
```
```js
  acceptWebSocket(ws, tags = []) {
    …
    __ws_accept(ws._id, this._scope, JSON.stringify(ws._tags));
    if (ws._attachmentSc) __ws_attachment_set(ws._id, ws._attachmentSc);
    __sockets.set(ws._id, ws);
  }
```

The Rust side is safe with this order: `op_ws_accept`'s `and_modify` doesn't clear the attachment, so writing it right after accept sticks. Keeping the encoded bytes, rather than encoding `_attachment` again at accept time, also matches workerd, which clones when `serializeAttachment` is called.

The patch doesn't touch the reconnect requirement or your guard. A celld regression test should cover attach-before-accept followed by an isolate replacement (a generation swap, or retiring the pool slot), then a message that reads `deserializeAttachment()`.

## Experiments to confirm it

1. **Rust bytes after accept (no celld rebuild).** As a temporary diagnostic in the room, add `onConnect: ctx.connection.setState({ probe: 1 })`. Void's `setState` calls `serializeAttachment` after accept, so it rewrites the whole stored connection, `params` included, into Rust. If `live-update.mjs` then passes with `count: 1, closes: []`, the pre-accept write was the gap. Revert the diagnostic afterwards; it isn't a fix.
2. **Idle eviction with a forced isolate replacement.** Run the idle test so the pool slot is retired between eviction and the click, for example by arranging another isolate to start and replace it. It should fail the same way with the unpatched pinned 0.6.2 image and pass with the patch.

## A separate issue in the same log

At line 10.08 the close dispatch fails with `InvalidAccessError: WebSocket close code 1001 is not permitted`. Void's `completeWebSocketClose` echoes the peer's 1001 back to `ws.close`, and celld's `WebSocket.close` rejects it (`harness.js` around line 10603). This doesn't cause the failure you're chasing, but it's a second Void/celld mismatch to look at later.
