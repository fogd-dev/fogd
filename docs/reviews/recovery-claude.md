# Claude recovery review

**Verdict: yes.** A stable, per-volume `CELLD_NODE` is the supported fix, and it is the only one the pinned source makes work. "Wait for ensemble repair" is not a gate celld exposes or guarantees. The stable-name rerun in `.fogd/recovery-stable.log` passes end to end, including the B kill.

## What actually happened

The failing recovery is in `.upstream/celld/crates/celld/node_log.rs:5041-5055`. For each name in the dead leader's `record.ensemble`, recovery reads `nodes/<name>.json`, and a member is only "conclusive" if its lease is present and expired by more than 3×TTL **and** the seal POST to its recorded address fails without an HTTP answer. B's record named A's old random ID. That lease object still exists in MinIO with `addr: celld-a:8081`, so recovery posted a seal there, signed for the old name (`peer_auth.rs:137-150`). The new A process verifies `target != expected_target` at `peer_auth.rs:226-228`, answers 409 (`peer_auth.rs:79`), the transport wraps it as `PeerHttpError` (`node_log.rs:2506-2509`), and the recovery loop counts an answered error as `inconclusive` (`node_log.rs:5097-5108`). The loop never logs that branch, so the only trace is the final "undecided" error. There is no timeout that ever turns a vanished identity into a conclusive one. If dead-lease GC later deletes the record, `Ok(None)` is also counted inconclusive (`node_log.rs:5050-5054`). Either way the log can never seal and every D1 activation retries forever. The fragments were on A's disk the whole time.

## Why name reuse is the designed path, not a hack

- `node_log.rs:4494-4525`: boot reads the log record keyed by **this node's name** and recovers the predecessor session from it. Sessions are `node/generation`, with generation a per-process key (`ownership_store.rs:49-54`, `log_tier.rs:284-291`). That design only has effect when the name is reused.
- `node_log.rs:1022-1024`: `SealResp` documents "a name-reused machine with a fresh disk answers 0".
- `main.rs:436-440`: a replacement binding the prior address while the prior lease is live is a handled case.
- `docs/guarantees.md:174-177`: a restarting node serves *authenticated* seal and tail requests before its own recovery so co-restarting nodes can recover from each other's disks. Authentication is target-name bound, so that promise requires the name to survive the restart.
- `docs/guarantees.md:301-303`: "Keep the node names, peer addresses, and data directories. A follower disk can hold acknowledged writes that the bucket does not yet hold."
- celld itself reuses names: control-plane re-exec passes `CELLD_NODE` through (`control_plane.rs:71-73`) and dev mode uses a deterministic name (`dev.rs:726`).

Random-per-process is the documented default (`main.rs:3744`, `cli.rs:336`), but nothing in the source repairs an ensemble reference to a dead random identity.

## Why "wait for membership repair" is not a usable alternative

- `node_log.rs:5745-5748`: maintain returns early when the current ensemble is still active and the candidate set is not wider. With no writes after A died, B kept `members={A-old}` for the whole 120s+ window. Your logs confirm B's record still named A-old when it was killed.
- No internal route exposes the ensemble. The only observables are the "log ensemble open; fleet acks enabled ... members=" log line and `log.ensemble` inside `nodes/<id>.json`. The health endpoint only reflects `fleet_ready` on the node you ask, not whether peers re-recruited it.
- `docs/guarantees.md:157-166` explicitly lists "persistent errors can block recovery and startup" as a limit. The source does not guarantee failover here, and I would not claim it does.

## Minimal correct setting and test

**Setting.** What the working tree now has is correct: `CELLD_NODE` unique per replica, pinned to its `CELLD_WATCH` volume (`compose.yaml:49,56`). The `.env` pin to the two old random IDs is the right one-off to recover the existing data. Two constraints from source: never run two live processes under one name, and never reuse a name on an unrelated disk (that path declares bounded loss, `node_log.rs:5236-5262`).

**Restart wait.** Not strictly required for correctness. Boot refuses to fence a live predecessor lease and retries with TTL-multiple backoff (`node_log.rs:4934-4939`, `main.rs:4286-4313`), so an immediate `docker compose start` after `stop -t0` self-corrects. The supervisor's 15s sleep already satisfies `docs/guarantees.md:76-79` for in-container crashes. ADR 005's "wait at least one lease lifetime" is fine as operator guidance, but it is a recommendation, not a precondition.

**Test.** `scripts/recovery.mjs` as written is the minimal reproducer and it now passes. Two small additions would make it prove the right thing:
1. Do one PUT between "celld-a rejoined" and the B kill. Today verify is read-only, so the second kill only recovers fleet acks from the first PUT. A write here exercises B's ensemble with A under its stable name.
2. After each rejoin, assert the dead session's log sealed, either by checking `nodes/<id>.json` `log.state == "sealed"` via the bucket, or by asserting the container logs contain no "no complete true witness". Health alone does not prove the log sealed.

One accuracy note on `docs/decisions.md:84-87`: "The recovery request rejected the changed target identity" is correct, but it is the *restarted A* that rejected the seal, not the recovering node. Worth tightening so the ADR reads cleanly.