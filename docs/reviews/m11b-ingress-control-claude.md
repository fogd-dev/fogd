**No blocker. The scope is now substantiated.** The direct owner control socket closes the gap in my first review (blocker 1).

## Why the evidence now holds

- **The owner's cell stayed live and in place.** The control socket connects straight to `slot-2-b:8080` (`live-control.mjs:6`). It saw revision 1 before the kill (`live-ingress.mjs:66`). It then recorded `opens:1, closes:[]` and received the revision 2 snapshot that the browser's post-kill write caused. Last, it answered the probe with a typed `rejected/invalid-operation`. If celld had drained, moved or reactivated the cell when the peer died, this local socket would have closed. That was the false-pass path I was worried about, and it is now ruled out.
- **The browser socket that dropped depended on the ingress.** In `ingress.json`:
  - The gateway `StartedAt` is 21:02:38.888Z (about …758888 ms).
  - Socket 1 closed at …758492, which is the recreate.
  - Socket 2 opened at …759510, after the new gateway started, and was still open at the kill (asserted at `:63`).
  - Socket 2 closed with code 1006 at …760918, 101 ms after `killAt`.

  The gateway `StartedAt` (`:83`) and the owner `StartedAt` (`:80`) are both unchanged, and the owner's control socket stayed open. The only thing that died was `slot-2-a`, so that is what socket 2 was routed through.
- **The ingress stayed down.** `StartedAt` is unchanged and `Running:false` holds at acknowledgment (`:82`). This covers the `unless-stopped` restart concern.
- **Cleanup** (`:95-102`) now uses `allSettled` and runs each step independently. Leaving signal recovery to the README is fine for a manual fixture.

## Nits (none block)

1. **The `scope` string at `:92` is out of date.** It still credits "socket close … and unchanged owner process". The direct owner control socket staying open is now the main evidence, so name it.
2. **Assert that the control socket saw revision 2** (`messages.some(m => m.revision === 2)`). It's in the evidence but not asserted, and it's what shows the same live cell served the post-kill write.
3. **Bound the close latency.** `:73` accepts any close up to 30 s after the kill. Something like `close.at - killAt < 5000` would stop an unrelated later drop from counting as the ingress loss.
4. **A browser close code of 1006 is weak evidence on its own.** workerd may map any backend drop to 1006. That's fine here because the control socket carries the proof, but don't present 1006 as the discriminator.
5. **The controller's `/tmp` keeps leftover files.** The `stop` command removes only `.command`. The JSON state file stays, and so does `.command` if the 120 s deadline already fired. These hold room data but no secrets, so it's low priority. A `rmSync(file)` on stop would fix it.
6. **Cleanup runs two compose operations at once.** `compose start <ingress>` and `up --force-recreate workerd` (`:98-99`) run concurrently against the same project. This is usually fine, but running them one after the other avoids rare compose lock and network races. Just as in my first review, `compose start` doesn't wait for health before a follow-on run.

I didn't re-read `websocket.rs` or `peer_tunnel.rs`, because the control socket result answers that question from runtime behaviour.
