# Claude implementation review: room ownership movement

The run passed and I found no blockers or false passes. The drill is enough to close the "record whether a room move closes the socket" part of item 4, scoped to healthy idle rooms. Stopped restore (item 7) is still open. Process `live-move` has exited, and `move-compose.json` was removed.

**What the reviewed run shows** (`.fogd/m11b-move-reviewed/move.json`)
- **Owners:** all 3 rooms were owned by `slot-1-a` at epoch 1, then by `slot-1-b` at epoch 2 after the pause and quiescence, then by `slot-1-b` at epoch 3 after replay and the next edit. Ownership never went back to a.
- **Same-node epoch bump:** 2→3 is the receiver advancing the epoch on its first write. The donor's retained topic `acaa…` shows the same pattern: it was published at epoch 2 on a. This is not a re-acquire by another node.
- **Donor counters:** `owned_cells` went 6→1 and `rebalanced` went 0→5. In `logic/lib.rs:5029` that counter goes up once per adopted handoff, so 5 = 6−1. `rebalance_failed` and `handoff_failed` stayed at 0. There was exactly one `rebalance_batch cells=5`, at 22:44:25.403Z.
- **Close timing:** the 1012 "service restart" close came 14 ms after that batch on all 3 sockets. Socket 2 opened about 1.07 s later with a revision 1 snapshot.
- **Replay and edit:** replaying the original op returned the original ack (`revision:1`). The receiver's direct snapshot was identical before and after the replay. The next edit reached revision 2 with 2 items.
- **No restarts:** StartedAt was the same for a, b and workerd, and both lease generations were unchanged. b's log went `active:false` → `true` at epoch 1.
- **Field names:** every field the script reads from `/state` exists at the top level of `actor.rs:4208`. This matters because `assert.strict.equal(NaN,NaN)` passes: a missing `owned_cells` would have let the equality check pass silently.

**Weak spots, none of which change this run's verdict**
1. Line 100 picks moved rooms by `node===receiver` only. It doesn't require the epoch to exceed the original. That's harmless here, but the check is one expression.
2. The script doesn't assert that each moved board has exactly one close and no close on socket 2. The events show it, but nothing checks it.
3. It doesn't assert that the 1012 time matches the `rebalance_batch` time. I checked it by hand (14 ms apart). Adding the assertion would make the run fully self-proving.
4. The "6−1=5" donor check (line 105) breaks if the donor takes on new cells during qualification, for example a topic created by the next edit. That would make the check fail on a good run, never pass on a bad one. Worth noting for reruns.
5. The only `paged_gate` events are the startup ones with `live_leases=1`. None show both leases. That's fine as an observation, but the run doesn't show the gate counting both nodes.
6. The script uses `docker logs --since <host ms>` to show that nothing rebalanced while paused. If Docker Desktop's VM clock drifts from the host, that check could miss lines. `rebalanced=0` before resume backs it up anyway.

**Cleanup**
- The `finally` block recreates the canonical services and checks celld health plus a gateway 200. It doesn't confirm that workerd's `FOGD_SLOTS` went back to `[a,b]`, and it doesn't re-run `readyLeases` (log ensemble open). So "ready" here means health and HTTP 200, not replication recovered.
- Both celld nodes are force-recreated at once without a drain. That's acceptable on a disposable fixture.
- Each run creates a persistent `move-cleanup` room cell.
- If an earlier crashed run left `move-compose.json` behind, the `wx` write fails, so `changed=false`. That run then skips the restore and deletes the stale file.
- `balance(false)` in `finally` does nothing useful, since the recreate follows anyway.

**Docs (`docs/m11b.md`)**
- The move claim at lines 174–175 sits inside "Current SSE evidence" and breaks the line wrapping. Give it its own short section, or put it under item 4. State the observed answer: yes, a move closes the socket with 1012 "service restart" and the client reconnects in about 1 s.
- Keep the scope limits: healthy idle rooms, a forced 5 s eviction, uneven weights, and ingress pinned to the owner. It makes no claim about the same socket surviving, resident cells, replication faults or SLA.
- The other parts of item 4 (killing the non-owning ingress replica, restarting workerd, disconnecting a browser, the ordinary-fleet idle observation) are not covered by this drill. Item 4 is fully closed only if those already have evidence.
- `docs/evidence/m11b-move.json` is a curated copy of the run (it drops `allRoomEvents` and `processes`). It shares no top-level fields with the run except `before`/`after`, which differ, so say in the doc that it's derived from `.fogd/m11b-move-reviewed`. I didn't find any secrets in it.
