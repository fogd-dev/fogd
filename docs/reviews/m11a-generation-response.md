# Queue resume primitive review response

The [Claude review](m11a-generation-claude.md) found no blockers within the internal
single-queue scope. Accepted hardening binds the observation to the exact named
queue cell using the pinned celld `engine_api.rs` identity scheme: SHA-256 namespace
key, a truncated HMAC of the queue name, then a truncated HMAC of that prefix.
The unit fixture records the real `imports` address, and the live probe exercises
that identity on resident and cold cells. Another queue cannot substitute for an
evicted selected queue. Additional resident queues still fail closed.

Mutation and post-mutation confirmation errors now carry `QUEUE_OUTCOME_UNKNOWN`
and retain their cause. The mutation helpers are private so callers use the gated
resume method. A separate `info` reads the same cell's reported state; it does not
prove delivery. Tests cover lost responses and a successful command followed by a
contradictory state. The future controller must persist unknown observations and
must not interpret a thrown resume as evidence that delivery stayed paused.

The live probe's claim now distinguishes observing an approved generation from
injecting a stale one. Stale, missing, duplicate, and wrong-queue observations are
negative unit cases; the live test covers rejected requested versions, resident
queues, and cold materialization after both replicas restart. Old handlers remain
outside the gate; this is compatible overlap, not draining.

Queue rejection is pinned by `packages/runtime/test/artifact.test.mjs`, including
nonempty `queues` declarations. No admission or public administration path calls
this primitive yet. Controller publication serialization, persisted intent,
bootstrap progress, interrupted activation, recovery-age policy, and retirement
remain requirements before enabling the binding.
