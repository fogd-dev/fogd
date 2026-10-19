# M11a initial queue activation probe

This exploratory local probe informs [the proposal](m11a.md). It does not qualify
queue support in fogd; admission still rejects queues. The fixture uses the pinned
celld 0.6.2 runtime in an isolated Docker project, with its own bucket, volumes,
credentials, and ports. The current approved example installation is separate.

## Results on 2026-10-19

1. Pausing a named queue on an empty fleet failed: no node leases exist before an
   initial deployment. Both replicas reported that they were awaiting deployment.
2. Deploying a no-binding bootstrap established the fleet, but queue pause failed
   with `RuntimeFailed`. The replica log identified the missing `__Queue` class.
   celld's `deploy.rs` includes its queue runtime feature only when the manifest
   has a producer or consumer declaration.
3. Adding a producer declaration to the platform-owned bootstrap enabled queue
   pause. The bootstrap had no consumer, accepted no writes, and returned HTTP 503.
   Its queue info response confirmed `paused: true` with no stored messages.
4. Publishing a consumer with the same physical queue name preserved the pause.
   A direct request to the fixture app enqueued one message. After five seconds,
   backlog was one and the consumer's R2 effect list was empty.
5. Restarting both replicas preserved the paused state, pending message, and absence
   of an R2 effect. Deliberate queue resume allowed one consumer effect to appear.

The original zero-deployment pause order is therefore unavailable. A producer-only
platform bootstrap is a candidate upstream-compatible first-deployment path. It
runs no application code and attaches no consumer. The controller must retain and
recover this stage explicitly; successful manual sequencing alone is insufficient.

## Evidence and limits

Private logs are `.fogd/m11a-pause-before-deploy.log`,
`.fogd/m11a-bootstrap-pause.log`, `.fogd/m11a-producer-bootstrap-pause.log`, and
`.fogd/m11a-pause-probe.log`. The last probe passed both assertions. Expected
connection-refused diagnostics during replica restart precede the successful
readiness poll; they are not a final probe failure.

This fixture used a small direct Worker to isolate runtime behavior. It did not yet
exercise Void queue code generation, D1 migrations, controller activation recovery,
failed or long-running consumers, terminal retries, backup/restore, or retirement.
The R2 marker is a consumer-effect observation, not an exactly-once guarantee.
The five-second check does not measure timing guarantees or arbitrary delayed work.
A repeatable committed qualification harness will follow the lifecycle review.

## Next questions for source review and probes

- Can paused delivery be established before the first application publication and
  reconstructed after interruption at every bootstrap/activation stage?
- Which version finishes work already in flight when queue attachments change?
  Does pause prevent all new delivery paths, including dead-letter/redrive paths?
- How should uncertain resume be reported and repaired without pretending that HTTP
  pause also stopped background execution?
- What persisted evidence can support a stronger drain, if needed, without relying
  on a fixed sleep or interpreting backlog as a handler-completion receipt?
- How do paused pending work and in-flight leases behave after stopped recovery and
  fleet retirement, while preserving secret revisions and old message compatibility?

## Preliminary generation update

The follow-up probe paused the queue after the first completed message, enqueued a
second message, published v2, reloaded both replicas, and captured `/state` privately.
The queue remained paused until resume. The second R2 effect recorded v2; the first
retained its v1 marker. Evidence: `.fogd/m11a-generation-probe.log` and the two private
node state snapshots. This qualifies only that paused pending-message sequence.
No handler was held in flight, so the review's old-generation concern remains a
required probe. See the [review amendments](reviews/m11a-response.md).

## Held handlers, delayed effects, and stopped recovery

The repeatable [qualification harness](queue-qualification.md) adds a producer-only
bootstrap, explicit generation checks, held v1/v2 overlap, `waitUntil`, retry
exhaustion, and handler-budget observations. The first direct-runtime run and the strengthened repeat on both fresh fleets
passed on 2026-10-19. The [recorded lifecycle evidence](evidence/m11a-queue-lifecycle.json)
separates each phase and retains node generation diagnostics.

The held v1 handler completed after v2 had already completed a pending job. At the
paused pre-resume observation the queue cell belonged to the current generation,
while the old generation still had an executing service request. The empty-queue
`waitUntil` probe recorded an R2 effect about eight seconds after the main handler
returned. It therefore disproves an empty-backlog drain, and also rules out a
live-lease count alone as a sufficient drain test.

With `max_retries: 1`, a deliberate failure consumed two attempts and then vanished
from the runtime queue. A 27-second handler under a 20-second response budget also
exhausted two attempts without its later completion marker. These observations do
not prove termination of every kind of I/O or impose that budget on `waitUntil`.

The [recovery evidence](evidence/m11a-queue-recovery.json) covers an interrupted
handler and a separate pending message. After force-stopping the selected replicas,
a full snapshot restored onto fresh resources. Both queues stayed paused; the event
history was unchanged and both messages remained stored. Deliberate resume completed
the pending job at attempt one and the interrupted job at attempt two. Backup took
27.6 seconds and restore 13.8 seconds, excluding startup. The source stayed stopped.

These remain direct Worker probes, not native Void/D1/controller qualification.
The [second review](reviews/m11a-probes-claude.md) requested stronger assertions and
identified the remaining activation gates; [the response](reviews/m11a-response.md)
records the accepted changes and implementation direction.

The strengthened runs additionally asserted the queue cell's current-generation
ownership and actual concurrent overlap: v2 completed its pending message before
v1 completed its held message. Both runs observed a `waitUntil` effect scheduled
35 seconds after a handler configured with a 20-second response budget. That budget
does not bound all background work. The recovery repeat confirmed pause more than
30 seconds after the interrupted lease's actual expiry before deliberate resume.
