# Room movement review response

Claude's [design review](m11b-move-claude.md) required evidence that distinguishes
healthy ownership transfer from eviction, restart or failed adoption. The
[implementation review](m11b-move-final-claude.md) found no blockers or false passes
and accepts the healthy idle-room part of M11b item 4.

The drill uses no SSE observers or room alarms. It captures capacity and log leases,
checks exact runtime identities against derived ids, and reads persisted owners
before movement, after the settled batch, and after further writes. Every observed
moved room gets receipt replay and direct receiver snapshot checks. Both celld
process generations and container start times remain unchanged. The moved set must
be nonempty and each epoch must exceed its baseline; failed handoff counters on
both nodes must remain unchanged.

The donor count includes topic objects. Its ownership decrease must equal the
successful handoff counter increase, while a native batch log provides independent
trigger evidence. New unrelated cells can make that equality fail a rerun; use a
disposable fixture without other clients. All room traces remain in the private
run; the public evidence is a curated copy with unrelated runtime details removed.

Retained boundaries: the test does not require exactly one close or correlate clocks
across Docker Desktop to a fixed millisecond threshold. It checks a 1012 close,
a new socket's authoritative snapshot, actual ownership, and absence of process
replacement. The recorded run has one close per board. Startup paged-gate logs are
observations, not proof that the gate sampled both nodes simultaneously. Cleanup
restores canonical services and checks health plus routed HTTP; this is not a new
replication-recovery claim. Full stopped restoration remains separate.
