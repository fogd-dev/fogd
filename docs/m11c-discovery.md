# M11c discovery: scheduled background work

The next M11 slice should let a Void application perform periodic work after a
user closes the browser. A candidate fixture periodically refreshes an application's
stored status and exposes its last successful run and failure state. This is a
reusable application capability, not a claimed FilOz requirement. The [proposed acceptance contract](m11c.md) and runtime choice need peer review
before platform implementation.

## Source findings

These findings concern the pinned checkouts used by the compatibility matrix,
not a claim about current upstream releases or a completed runtime qualification.

- Void discovers cron jobs and emits a native `scheduled` export in
  `packages/void/src/router/compile.ts`. Its generated manual HTTP trigger uses
  authentication and a synthetic controller; exercising that endpoint alone would
  not prove native timer dispatch, retry or `noRetry` behavior.
- celld reads `triggers.crons` in `crates/celld/deploy.rs`, carries them in the
  deployment manifest and advertises `cron-v1`. Its scheduler uses one reserved
  `.cron` cell per script (`crates/logic/cron.rs`). Schedule resolution is a minute.
- `CelldCronSchedule` in `crates/celld/js/harness.js` invokes the native scheduled
  handler from a Durable Object alarm. It retains pending retry identity in memory;
  its source explicitly permits eviction to lose a retry. A later occurrence can
  supersede that retry. This is not a durable job queue or an exactly-once contract.
- fogd's [artifact translator](../packages/runtime/src/artifact.mjs) rejects
  nonempty `triggers` and `workflows` declarations. Durable Object classes are
  already admitted; route pauses do not suppress their alarms. Qualifying cron
  declarations would not establish a general alarm activation barrier.

## Questions the spec must answer

1. When may the first approved occurrence run relative to migrations, resource
   provisioning, secret injection and controller activation? Prove that a pending
   upload cannot execute and define interruption recovery at each activation step.
2. Which release owns an occurrence during compatible replacement? Record any
   handler overlap. Define a stable application idempotency key and show that a
   retry or ambiguous completion cannot create duplicate business records.
3. What does operator pause mean for scheduled callbacks and already-running work?
   Compare native runtime controls with a fogd dispatch gate. Do not imply that
   rejecting a callback preserves its occurrence for a later retry.
4. What is recovered after an owner kill, eviction, extended downtime or an older
   full-installation restore? Test actual native deadlines. Define skipped,
   replayed and failed occurrences explicitly instead of promising all missed work.
5. How do stopped backup, expansion and retirement account for timers that can
   wake without client requests? Keep unsupported topology operations refused.
6. What may operators observe and retry without exposing injected secrets? A
   demonstration should show last success, a failed occurrence and recovery through
   the ordinary approved app flow.

## Scope to decide

Prefer native Void cron discovery and celld execution if their lifecycle can meet
the reviewed contract. Compare that with an explicitly labelled fogd dispatcher
and with deferring admission while qualifying only the runtime. Do not introduce
a second scheduler merely to hide a missing lifecycle control. Workflows and
general application alarm governance need separate contracts; SSE subscription
cleanup does not qualify either. Cloudflare execution remains outside these tests.
