# Claude review: healthy room ownership movement

I'd run this plan, but only after fixing the blockers below. I checked it against `.upstream/celld` (`logic/rebalance.rs`, `logic/lib.rs` rebalance/release_dormant, `celld/main.rs` balance loop, `celld/actor.rs`, `ownership_store.rs`).

## What the code confirms
- **Weight 1/100 is enough to force a move.** Let N be every cell held across the fleet, counting topics and any other cells, not just the tested rooms. Node a's target is `ceil(N/101)` = 1 for any N ≤ 101, so a gives away `owned_a − 1`. Node b has room for `N − 1 − owned_b`. With 3 rooms and an empty b, at least 2 cells move. 2 rooms would do; 3 is fine. Only one cell stays on a: the most recently used one, which could be a topic cell. Equal weights would move only 1 cell, so keep the skew.
- **`placement_weight` is read only by the balancer.** The first acquire still lands on the node the request enters through, so pinning ingress to a is the right setup. Still confirm a owns each room from storage (see evidence below), not from ingress.
- **The 1012 is the expected close.** `release_dormant` closes parked sockets with `ws_close_scope(cell, 1012, "service restart")`.
- **The pause is a fleet-wide in-memory atomic that is published in the lease.** It is not persisted, so a recreate clears it. Recreating before you pause is therefore correct. One paused lease makes every node's `Fleet::observe` return `None`. Pause only a, then resume a. Verify through the lease (`rebalance_paused`) and through the absence of `rebalance_batch` log lines.
- **Recreating gives a clean count.** `owned_cells` counts in-memory `held_epoch`, so after a recreate both nodes start at about 0. Old `own.json` records don't inflate either side.

## Blockers
1. **Only `Phase::Dormant` cells with empty `requests` and no imminent alarm can move.** An open SSE/EventSource or Void live subscription to a tested room keeps it active, so it never becomes dormant and never moves. Close the observers, or don't attach them to tested rooms. "Hibernated" must mean the room is absent from b's debug `residents` and still owned by a, with zero pending requests.
2. **Alarms.** `alarm_resident_ms` defaults to an hour. If the checklist room arms any alarm, `alarm_is_imminent` excludes the cell from moving. Confirm the room arms no alarm.
3. **The balance loop needs every live lease fresh**, with `paced_handoff` set and not paused. It also needs `fleet_ready`, a not draining, b not draining or shedding, `restoring == 0`, and `reports_adoption_capacity` true. Capture both lease JSONs (`nodes/{node}.json`) before you resume, or a no-move result can't be diagnosed.
4. **Replication health gate.** Adoption needs a durable replica. Before resuming, record healthy log epochs and the paged gate. Otherwise a stalled restore on b looks like a failed or partial move.

## False passes to rule out
- **A 1012 from a reload or restart carries the same "service restart" reason.** Require all of these:
  - a's `rebalance_batch` log event
  - `rebalanced` increasing by exactly the number of moved cells
  - `rebalance_failed` and `handoff_failed` unchanged
  - StartedAt unchanged on both celld processes and on workerd
- **A failed adoption leaves the cell unowned.** Your reconnect through a then makes a reacquire it, with a new epoch on a. Only an `own.json` record naming b counts as moved.
- **Owner inferred from the room still working.** Once the cell is on b, gateway a forwards to b, so a working room says nothing about the owner. Confirm the owner from b's `residents` after the reconnect wakes the room, plus the `own.json` record.
- **A revision 1 snapshot served from client state.** Require it to arrive on the new socket after b's residency appears.
- **Duplicate check read from the wrong node.** After replaying the baseline op, read the item count from the runtime on b (or after another idle eviction), not from the browser's model.
- **Rooms that stayed on a.** Report them as observations only, keyed by exact cell id.

## Required evidence per tested room
- `cells/{cell}/own.json` read from the bucket three times: after the baseline (node a, epoch E), after resume (node b, epoch greater than E), and after the revision 2 edit (still b). Use the exact cell id from runtime debug; don't compute it. **Yes, use this persisted owner key.** It is the authoritative record, and runtime residency corroborates it.
- From a: the `rebalance_batch` count and before/after `rebalanced`, `rebalance_failed` and `handoff_failed`.
- Close code and reason, plus timestamps: resume, close, reconnect, snapshot.
- Receipts:
  - the replayed baseline op returns the prior receipt at revision 1 with no extra item
  - the new edit returns revision 2
  - the final item count read from b

## Simpler trigger
I found none. The weight skew plus native pause/resume is already the upstream balancer path. Drain and SIGKILL are different mechanisms, and the second is already qualified. `/rebalance/pause|resume` is POST only and returns 409 when the node publishes no lease, so treat 409 as a failure. Resume on the same node you paused.

## Scope
Claim only that healthy idle-cell ownership moved from a to b, with a 1012 reconnect, preserved revision and receipts, and no double application. The physical socket is not preserved, and this says nothing about SLA, preservation under replication faults, or resident (non-dormant) cells.
