# Claude follow-up: replication recovery

**Verdict:** The blocker is mostly addressed. The disclosure part is done. The recovery check still can't tell a degraded log from a healthy one, so one fix is needed before it can serve as a gate.

## What holds

- **Disclosure:** The scope string (`scripts/live-sse-failure.mjs:132`) and `docs/report.md:1026-1031` now say the paused node is also the log follower, mention the eviction and bucket-backed acknowledgments, and make no latency claim.
- **The final run passed and matches the committed evidence** (`pausedAt` 1792449248257). The pause lasted 2702 ms against a 4000 ms budget. Both timeouts were logged (revisions 2 and 3). Revision 3 was acked after 1417 ms, just after the eviction at the 1500 ms backstop. Late hints for 3 and then 2 arrived 1–2 ms after unpause on the same stream.
- **The log really did recover in this run.** `replication.log` has `degraded … epoch=5`, then `log ensemble open; fleet acks enabled epoch=6 members={"slot-2-b"}` at 22:34:11.017, and then `posture_repair degraded_ms=1257`. `ensemblesAfter` shows slot-2-a moving from epoch 5 to 6.
- `active: false` on epoch 6 is expected. It is `may_have_fleet_acks` (`ownership_store.rs:225-231`), not a liveness flag, so it was right not to assert on it.

## Required fix: `requireEnsembles` passes while the log is degraded

- **Cause:** Degradation is only an in-memory flag (`node_log.rs:2786`, `degrade_shared` at `node_log.rs:2820`). It never changes the lease record. The leader keeps publishing `state:"open"`, the same epoch and the same ensemble while acks go through the bucket. A new record is written only on `Reopen` (`node_log.rs:5797-5822`, `log_to_wire(&record,false)`).
- **Effect:** All three calls (line 99 before injection, line 122 after resume, line 140 in cleanup) would pass on a cluster that is still degraded. Before this run, the lease said epoch 5 open with `[slot-2-b]`. During the degradation it said exactly the same thing. This run recovered, but the script never asserts that it did. The report's "must report open log ensembles … again" sentence suggests a check the code doesn't make.
- **Fix (smallest version):** Assert the transition, not the shape of the lease.
  - After resume and in cleanup: for each `log ensemble degraded … epoch=N` line on a host since `pausedAt` (or since the script started, in cleanup), require a later `log ensemble open … epoch=M` line on that same host with M > N. Also require that host's lease `log.epoch` to be ≥ M. Poll the logs together with the lease, inside the same 90 s timeout.
  - Before injection, the lease check can't see a degraded state left by an earlier run. Run the same check over the compose logs since container start, or since the last recreate. Any `degraded` line with no matching later `open` should fail the run.
  - Then reword `report.md:1029-1030` to: "each degradation must be followed by a reopened epoch with the peer before exit."

I found no other required changes.
