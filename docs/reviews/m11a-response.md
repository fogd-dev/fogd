# M11a review amendments and probe response

The [Claude review](m11a-design-claude.md) requests revisions to the
[original proposal](../m11a.md). The proposal remains the review baseline; these
amendments record accepted changes and unresolved questions. Queues remain rejected.

## First deployment

Accept the finding that an empty fleet cannot receive an operator pause. The
[independent runtime probe](../m11a-probe.md) reproduced it. A no-binding bootstrap
also failed because it omitted the queue runtime feature. A platform-owned
producer-only bootstrap succeeded: pause persisted through application publication,
one queued message, and both replica restarts, until deliberate resume.

Prefer this bootstrap candidate over the review's publish-then-pause suggestion.
An HTTP route pause is not proof that application code cannot enqueue: module
initialization or other activation can have effects. The producer-only bootstrap
runs no application code and attaches no consumer. Its explicit crash/retry state
still needs qualification before this becomes the implementation contract.

## Updates and generation ownership

Accept that replica pointer readiness is not by itself proof of consumer generation
readiness. A preliminary paused-message update probe observed v2 processing after
publication/reload/resume, but it did not hold a v1 handler in flight. Capture the
supported deployment/generation diagnostics and message release identity in the
next probe. Do not promote one successful paused message into a general guarantee.

The suggested live-lease diagnostic patch is an option, not yet an accepted drain
contract. Establish what zero leases proves about executing handlers, settlement,
`waitUntil`, and external effects. Likewise, do not adopt a fixed lease-duration sleep
as proof of termination without source and failure evidence. Compatible overlap
remains a candidate if its limits are observable and sufficient.

## Delivery intent, naming, and scope

Persist intended delivery state before calling pause/resume, then observe the
runtime flag. The verbs are idempotent, so retrying a timed-out call is appropriate.
Keep the distinction between intended and observed state visible during failure;
HTTP routing is a separate state. Qualify interrupted publication, including a
queue attachment changing before fleet pointers, with explicit republish recovery.

Keep logical queue names: each app already has its own fleet namespace. Record
queue declarations in resource history and reject consumer removal/renaming in this
slice. Start with one same-app work queue and only justified options. Admin controls
should expose status, pause, and resume; omit payload inspection and destructive
purge. Whether a same-app dead-letter queue is required remains a product/recovery
question, not something to reject solely because Void's defaults omit it.

## Retention and terminal outcomes

Accept that upstream retention and exhausted retries can delete messages. A pause
or stopped snapshot does not freeze wall-clock retention. Recovery must report the
age and consequences of pending work and require an explicit recovery policy before
starting consumers. Verify retention with isolated test-clock facilities or an
upstream test; do not change the host's clock or system configuration.

Writing an app failure row on the last attempt helps handled failures but cannot
cover a process killed before that write. The fixture therefore needs durable
input/job records and an explicit reconcile/retry path, or a qualified dead-letter
contract. Do not infer successful completion from an empty queue. A D1 insert and
queue send are separate effects; duplicate sends and partial submission must be
safe. This boundary must be resolved before claiming scenario U7.

## Next qualification

Build a repeatable probe for held/over-budget handlers, release identity after
update, interruption at activation boundaries, pending/in-flight stopped recovery,
and retry exhaustion. Preserve the tested bootstrap sequence and paused-message
result as evidence, not as completed M11a. Review the resulting lifecycle state
machine before changing fogd admission.

## Runtime probe review and accepted changes

The [second Claude review](m11a-probes-claude.md) supports implementation using
persistent pause and compatible overlap without a runtime fork. It does not approve
changing admission yet. Its key concern is now explicit: old code, including
`waitUntil`, can run against a later additive schema and can outlive an empty queue.

The qualification harness now asserts queue-cell generation ownership, v2 completion
before the held v1 completion, and a delayed effect after observed paused/empty
state. Pause/resume operations are confirmed with a separate status read. Exhaustion
uses the configured retry count and observes an additional retry-delay margin.
Timeout observation is anchored to the final attempt's recorded start and intended
effect time. Recovery captures the actual leased-until value, uses a longer held
job, and checks paused preservation after that lease has expired. The repeatable
fixture and cleanup contract are documented in [the guide](../queue-qualification.md).

Accept the bootstrap queue-set equality and retry-progress requirements. Do not
republish bootstrap merely because an interrupted first deployment lacks an active
controller record. Accept a generation gate before every resume, and test a cold
queue cell as well as a resident one. Test D1 migration on bootstrap directly; if it
works, use pause → migrate → publish for both first deployment and updates.

The suggested rollback check needs strengthening: zero stored messages cannot prove
that older background work will not enqueue another payload. Keep known older queue
artifact reactivation unsupported until its payload compatibility policy is explicit.
Likewise, an empty runtime queue cannot prove application completion after retention
or process failure. Durable input/job records and reconciliation remain required.

[ADR 025](../decisions.md#adr-025-persistent-queue-pause-with-compatible-handler-overlap)
records this direction. Remaining implementation gates are native Void/D1 behavior
across overlap, controller kill points and uncertain operations, interrupted
attachment/pointer publication, durable reconciliation after killed/exhausted work,
retention-age recovery policy, and retirement/isolation. No queue admission change
has been made by the probe work.

The strengthened lifecycle harness subsequently passed on both fleets of a fresh,
image-pinned fixture, and the strengthened recovery run passed on a fresh target.
The longer `waitUntil` probe produced its effect beyond the handler response budget.
The [public evidence](../evidence/m11a-queue-lifecycle.json) records both fleet runs;
[recovery evidence](../evidence/m11a-queue-recovery.json) includes the actual lease
expiry and the later paused observation. Setup, probes, and recovery are reproducible
from the committed [qualification guide](../queue-qualification.md).
