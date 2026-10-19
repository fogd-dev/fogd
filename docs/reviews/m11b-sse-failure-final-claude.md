# Claude review: SSE failure qualification

**Verdict:** I found no false pass in either script. The publication test shows what it says it shows: durable edits keep working while the topic node is frozen, and the same observer connection is repaired by late hints, with no reload. I have one blocker, about how the evidence is written up rather than the code, and four advisory items.

## Blocker: the paused node was also a log replica

`slot-2-b` holds the topic, but it was also the board's log follower. Pausing it stalled the write path too, so the run tested publication stall and log-follower eviction together.

- **Evidence:** in `.fogd/m11b-sse-publication-separated/publication.json`, revision 2 took 1584 ms to ack (`sentAt …953993` to `acknowledgedAt …955577`). Revision 3 acked in 16 ms.
- **Cause:** `publication.log` shows the write only finished when `gray follower evicted … member="slot-2-b" rule="backstop" backstop_ms=1500` fired, followed by `log ensemble degraded; acks ride the bucket`. Writes stayed live because celld evicted the paused node, not because publication was separate from writes.
- **Effect:** revisions 2 and 3 were acked with weaker replication. The `scope` string in `scripts/live-sse-failure.mjs:105` doesn't mention this.
- **Fix:**
  - Disclose the eviction and degraded ensemble in the scope string and the M11b write-up.
  - Before cleanup ends, check that `slot-2-b` rejoined the log ensemble. Line 96 only checks that `/state` responds, so the next run (including the isolation rerun) could start on a degraded cluster.
  - Or place the topic on a node outside the board's log ensemble, if the topology allows it.

## Advisory

1. **Late-hint revisions aren't asserted.** The watch page only fetches on control or hint (`examples/checklist/lib/observer.mjs`; no polling). Lines 98–100 therefore prove repair by hint on the same stream (1 open, 0 errors). But "hints 2 and 3 arrived after unpause" is only true in the evidence: both arrived at `…956422`, after `unpausedAt` at `…956398`. A hint for revision 2 alone would also satisfy `Revision 3`. Assert that `recoveryEvents` contains messages for revisions 2 and 3 with `at >= unpausedAt`.
2. **Cleanup can hide the original error.** If the watchdog fires (line 83), `paused` stays set. The `finally` then unpauses a container that isn't paused, which errors, and the `AggregateError` replaces the original throw. The original is only kept in `failure.json`. Fix: clear `paused` inside the watchdog, or check `inspect(host).Paused` before unpausing at line 111. The gateway restore at line 111 also doesn't wait for routing to come back.
3. **Hints can be published before the write is durable.** The `timed-out revision=2` log at `14.999` means the publish started around `13.999`, but the ack reached the browser at `15.577`, after the log flush. My inference is that the output gate holds the reply while `publishHint` runs immediately. That's harmless here because hints only trigger a snapshot fetch, which is also gated. It's worth one sentence in the docs.
4. **Only one timeout was logged.** `outcomes` has a single `timed-out` line, for revision 2. The revision 3 publish completed after unpause, inside its 1 s deadline. The `[23]` regex at line 91 accepts that, which is fine. Just don't describe it as "both timed out".

## Checks that held

- **Lease watchdog:** `CELLD_TTL_MS || 10000` (line 80) gives a 3333 ms budget. That 10000 default also appears in `docker/celld-supervisor.sh:9`; I didn't find it in `machine.rs` under that name. The actual pause was 2652 ms, the watchdog didn't fire, and the logs show about 6.6 s of lease headroom left.
- **Topic residency:** the topic was on `slot-2-b` only, before and after the pause (lines 69, 77, 101), so ownership never moved.
- **Same observer connection:** the observer's connection lived on the board node (line 74). There was one `open`, and the event streams didn't change during the pause (line 88).
- **Unchanged nodes and sockets:** `StartedAt` was the same on the board node and workerd, and the WebSocket count and closes didn't change (lines 86–87).
- **Diagnostic log:** the edit to `[room].ws.ts` adds `revision=` to the timeout log and nothing else.
- **Isolation (`scripts/live-sse-isolation.mjs`):** this is sound. The new `subscriptionId`/`topic` assertion at line 41 matches the existing evidence (`board|true` for both apps, no errors), and the scope string still makes no hostile-tenant claim. The rerun result isn't in yet. Remaining gap from the prior review: only `pageerror` is captured, not console errors or failed requests.
