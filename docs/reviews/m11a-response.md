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
