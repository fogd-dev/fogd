I read the patch, the patched runtime, `session.mjs`, `pages/index.tsx`, the server receipt path in `board.mjs`, and both Dockerfiles. The `sendIfOpen` method itself is correct. But two things block it in the current tree: the app doesn't call it yet, and the Docker build images won't install with the patch.

## Blocking

**1. The app still calls the buffering `send`.** `examples/checklist/pages/index.tsx:15` passes `message => socket.send(message)` into `ChecklistSession`. In the window you describe (the socket has stopped being OPEN but the close event hasn't fired yet), `send` pushes the message into the SDK buffer, which gets flushed on the next `open`, before any snapshot. That is B1, still there. The callback has to be:

```ts
message => { if (!socket.sendIfOpen(message)) throw new Error('Socket not open'); }
```

The `Parameters<typeof socket.send>[0]` type can stay as it is.

**2. Both Docker builds will fail at `pnpm install`.** `docker/runtime.Dockerfile:8` and `docker/verify.Dockerfile:6` copy `pnpm-workspace.yaml`, which now lists `patchedDependencies`, together with the lockfile. Neither copies `patches/`. With `--frozen-lockfile`, pnpm checks the patch file's hash and stops when the file is missing. Add `COPY patches patches` before `RUN pnpm install` in both. `.dockerignore` doesn't exclude `patches/`, so that line is all that's needed. Your note that both build targets must carry the patch explicitly describes exactly this gap.

## Correctness of `sendIfOpen` (OK)

- **The OPEN check is the right gate.** Per the WebSocket spec, `WebSocket.send` throws only while CONNECTING. In CLOSING or CLOSED it silently drops the data and only increments `bufferedAmount`, so the check is necessary. JS is single-threaded, so nothing can change the state between the check and the call.
- **A new socket can't be mistaken for the old one.** After a reconnect, `this.socket` is the new CONNECTING socket, so the method returns false. `ready` is false at that point anyway, because `opened()` resets it until a snapshot arrives.
- **The false path recovers.** In `session.mjs:103`, the catch calls `disconnected()`. The close event then calls `disconnected()` again, which is harmless. After reconnect: open, snapshot, `flush`, and the operation is resent with the same opId.
- **Duplicate resends are safe on the server.** If a message was sent while OPEN and the ack was lost, the resend is deduplicated by `board_receipts` (`board.mjs:27-40`), which replays the ack or returns `operation-conflict`. True means "handed to the browser socket", nothing more; the ack is still the only proof of delivery.
- **Exceptions:** `JSON.stringify` can only throw on cyclic or BigInt values. Payloads have already passed `parseOperation`, so this can't happen in practice. Letting it propagate is fine.
- **Reading the state as the literal `1`** matches the existing `send` code and works on both browser and Node/undici WebSockets.

## Is this the smallest reversible fix?

Yes. Compared with the alternatives:

- **Reading `(socket as any).socket.readyState`:** no patch needed, but it ties you to the same internals, and a Void upgrade would break it silently. The pnpm patch is keyed to `void@1.1.11`. On a version bump, pnpm 10 errors with an unused or failed patch by default, which is the loud failure you want.
- **Dropping VoidSocket for a native WebSocket:** about 30 lines of reconnect and typing code, and you lose the typed `connect<'/rooms/:room'>` surface. That's more code and moves away from the native-Void goal.
- **Upstream shape:** `sendIfOpen(event): boolean` is a good proposal. If upstream pushes back, ask for a public `readyState` getter as the fallback. It's equally small, and app code can do the check itself.

Minor: the `.d.mts` patch edits a hashed chunk filename (`ws-CsBNxv86.d.mts`). That's fine for a pinned version, but any rebuild of upstream breaks the patch. That's another reason to land it upstream rather than carry it.

## Tests needed

1. **Fake VoidSocket test (node:test):**
   - Set `readyState` to 2 (CLOSING): `sendIfOpen` returns false, the underlying `send` is never called, and the SDK buffer stays empty.
   - Set it to 0 and 3: also false.
   - Set it to 1: returns true and calls `send` exactly once.
   - Plain `send` keeps its current behaviour, so the patch is purely additive.
2. **Session test:** a `send` callback that returns false the way the page wrapper does (throws) leaves the operation pending. The status becomes Reconnecting. `opened()` alone sends nothing. After a snapshot, exactly one resend goes out with the same opId. The existing "send failure" test (`session.test.mjs`) covers most of this already; adding a CLOSING-specific case is enough.
3. **Browser test:** force the socket into CLOSING (server-initiated close with a delayed close frame, or call the native `close()` and submit synchronously in the same task). Then assert:
   - no operation frame reaches the server before the new connection's snapshot (check server-side frame order: snapshot, then operation);
   - the operation is applied exactly once.

   The test must fail when the page uses `socket.send`. That check is what catches problem 1.
4. **Build check:** both Docker targets run `pnpm install --frozen-lockfile` successfully, and a grep shows `sendIfOpen` in the installed `node_modules/void/dist/runtime/ws.mjs`. That catches problem 2 and any silent patch drop.
