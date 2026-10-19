# Claude route-pause review

I found no blocking defects. A passing run would show what item 5 of the gate asks for, and the obvious ways it could pass falsely would make it fail instead. There are a few precision gaps worth closing before you use the result as evidence.

I checked against `activation.mjs`, `backend.mjs` (`claim`, `publish`, `ready`), `controller.mjs` (`route()`), `runtime/src/gateway.js`, the checklist input validation and the earlier `live-ingress.mjs`. Both files pass `node --check`. I didn't run anything, didn't touch Docker and didn't open any env files.

## What holds up
- **The hold is real.** `publish()` sets the step to `waiting-for-replicas`, then `backend.ready()` checks every node in `slot.nodes`. A paused replica makes each `/reload` time out after 5s and retry until the 180s deadline. Nothing before that step needs the paused node: `claim` and `publish` only use S3 and the bucket. No controller pause is injected, so the header comment is accurate.
- **Route state is bracketed.** `prepareActivation` sets `app.route = 'paused'` before any backend work. The script checks `route === 'paused'` before and after the HTTP and WebSocket probes, plus `State.Paused === 'true'` on the frozen container.
- **The socket's path can't fool the test.** If the reconnect had gone through the non-owner, freezing it would freeze the socket, and the `during-route-pause` ack poll would time out. A passing run proves the socket didn't depend on the paused node.
- **Approval rejections are handled.** Handlers are attached to the `cli approve` promise as soon as it starts.
- **Cleanup order is right.** It unpauses in `approve`'s finally, keeps `paused` set if the unpause throws, closes the browser before recreating workerd and rolls workerd back only if it was changed.
- **The operations are valid.** `{kind:'set', itemId, checked}` passes `parseOperation`. The final state of 2 items at revision 3 adds up: add, then set, then the pending add.

## Blocking
None.

## Advisory (worth fixing before recording evidence)
1. **The 503 check doesn't confirm why it's a 503** (`live-route-pause.mjs:50-51`). The gateway also returns 503 for `Routing unavailable` (controller lookup failed or timed out) and `No healthy replicas`. Also assert the body is `App activation paused`. The WebSocket `'refused'` check has the same gap, since any `onerror` counts. A raw upgrade request from Node, or `fetch` with `Upgrade` headers, would capture the status and body. The route bracket makes a wrong 503 unlikely, but it isn't proven.
2. **Which release handled the operation during the pause isn't pinned.** `ready()` checks nodes in the controller's order, not the reordered gateway order. If the owner comes first in `slot.nodes`, it has already reloaded to v2 before the hold, so the revision 2 ack comes from v2. Otherwise it comes from v1. `ack.release` is saved but not asserted or explained. Record the owner's `/state` version and the controller's node order, then assert the release you expect. The doc only says established sockets can mutate, but the evidence should say which handler did it.
3. **Reordering the gateway doesn't make it "prefer" the owner.** `gateway.js` alternates the order on every app request (`next++ % 2`). The owner is only picked if the reconnect is the first app request a fresh gateway sees, which is the same assumption `live-ingress.mjs:52` documents. There's no false positive here (point 3 above), but a wrong pick shows up as a puzzling 10s ack timeout. Record selection evidence like live-ingress does: the socket's open time is after the gateway's `StartedAt`, and the reconnect snapshot is on that socket. Otherwise, reword the comment.
4. **Original errors can get masked.**
   - `approve`'s finally awaits the approval, which can take up to about 180s, and then rethrows the approval's error. If a gate assertion has already failed, that error replaces it.
   - If `compose pause` itself fails, `paused` is already true, so the finally's unpause failure hides the real cause.
   - In `live-update.mjs`, the finally's `pauseGate?.cleanup()` throws an `AggregateError` that replaces the test's error.

   Keep the first error and attach the others, or log them.
5. **Small evidence gaps.**
   - No timestamp for when the pending record was released relative to the unpause.
   - The 503 and WS responses aren't recorded.
   - The owner isn't re-checked as resident immediately before the pause.
6. **It isn't documented.** `docs/m11b.md` doesn't mention `FOGD_LIVE_ROUTE_PAUSE` and has no result entry. The `scope` text in the saved record has been updated, but the doc still needs the reproduction steps and the result after the run.
7. **Nits.** `state.apps.checklist` is hard-coded in `live-route-pause.mjs:47,69` while the caller has `app`. In pause mode, `idleEvidence` is filled in and then saved as null; a separate variable would be clearer.

The cheapest fixes are adding the 503 body check and asserting `ack.release` together with the owner version.
