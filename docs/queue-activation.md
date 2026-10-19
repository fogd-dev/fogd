# Queue activation coordinator

The controller integrates queue bootstrap, delivery holds, migrations, and app
publication. The [bounded Docker admission profile](queue-admission.md) allows
ordinary queued uploads with an explicit operator opt-in; it defaults off. The
coordinator tests described here stage artifacts privately. Public CLI acceptance
evidence is tracked separately in the admission guide.

## First activation and updates

A first queue activation publishes platform code with producer and D1 bindings.
That bootstrap responds with HTTP 503 and contains no app consumer, app code,
secrets, or arbitrary app bindings. The controller waits for its version on both
replicas, confirms queue pause, reconciles and applies migrations, then publishes
the approved consumer. After readiness, the delivery journal resumes the approved
version, or confirms pause if the operator wanted delivery paused. Only then does
the controller save the active deployment pointer and enable the HTTP route.

Updates use the same pause, migration, publication, readiness, and release sequence
without publishing bootstrap code. The queue declaration must remain identical.
An existing handler can continue across this sequence; pause is not a drain.
Applications still require additive migrations and compatible message formats.

## Durable progress

Bootstrap progress belongs to the app, independently of its active deployment ID.

| Saved phase | Permitted publication on retry |
| --- | --- |
| `pending` | Producer-only bootstrap; no consumer publication has been attempted |
| `ready` | Recheck the saved bootstrap version, then establish pause |
| `application` | Publish the approved app; never publish bootstrap again |

The controller saves `application` before attempting consumer publication. A lost
publication response therefore cannot cause retry to overwrite a consumer with
bootstrap code, even if the first activation never acquired an active pointer.

A missing journal permits bootstrap only on an unpublished fleet with no active
pointer. This rejects a stale metadata snapshot paired with a newer deployment.
Queued retirement uses the [stopped-work protocol](retirement.md#queued-app-retirement)
with a complete snapshot and explicit acknowledgment of stopped queued work.

The permanent `fogd-queue-activation-v1` requirement prevents supported older
controllers from accepting this state. As with other capability markers, binaries
predating requirement enforcement are unsupported. Matching images belong in a
recovery snapshot.

## Failure and restart

An uncertain runtime response retains the delivery hold. A resume may have committed
before its response was lost: the hold records intent, not proof that work stopped.
Retry confirms pause before any D1 ledger operation. Queue activation error handling
defers ledger reconciliation to that retry rather than performing it under uncertain
delivery state.

Startup assigns a hold to every interrupted queue activation, including interruption
after delivery release but before the active pointer was saved. It persists this
state before confirming pause. For an incomplete bootstrap it first waits for the
saved version to load. Startup never resumes a queue. A failed pause confirmation
records an unknown delivery observation and a bounded recovery diagnostic for that
app. Its route stays paused while other apps remain available. Explicit retry must
confirm pause before proceeding.
Quarantined and retired fleets receive no automatic runtime commands.

Metadata write failure stops further controller effects through the shared storage
failure guard. Recovery requires a fresh controller to load the actual durable
state. The guard cannot undo an already committed runtime effect.

A held activation permits original-artifact retry or an explicit
[replacement approval](queue-replacement.md). Replacement reconciles the original
attempt's migration evidence before atomically transferring the hold and pinning the
candidate approval. Applied SQL cannot change. Other pending submissions remain
rejectable to free admission capacity; rejecting the current hold owner is refused.

## Evidence and limits

`packages/platform/test/queue-activation.test.mjs` exercises the actual controller
approval method with a private artifact fixture. It covers initial deployment and
update ordering, operator pause, lost backend responses, ambiguous metadata writes,
and real controller-process SIGKILL at persisted intent and runtime-effect boundaries.
The process tests use a file-backed runtime stand-in; they establish controller
recovery behavior, not celld or bucket crash durability.

Run the coordinator tests with:

```sh
node --test packages/platform/test/queue-activation.test.mjs
```

The earlier [runtime qualification](queue-qualification.md) and
[delivery journal](delivery-journal.md) probes cover actual celld independently.
The Docker probe in `scripts/queue-controller.mjs` drives a private controller
instance using the built image against real celld. It covers bootstrap, D1 migration,
lost resume response, restart pause, explicit retry, and a paused update. The native
Void app then processes an import after explicit probe resume. This bypasses public
artifact admission and does not exercise the approval HTTP API or gateway.

[Authenticated operator controls](delivery-controls.md) are qualified separately.
Later [acceptance evidence](m11a-acceptance.md) covers stopped recovery, retirement
isolation, and canonical approval/routing. Retention limits and old-handler overlap
remain explicit contract boundaries.
