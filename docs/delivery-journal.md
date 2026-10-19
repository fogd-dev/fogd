# Persist delivery intent

The internal `Delivery` journal separates operator intent, activation ownership,
and runtime observations. It does not enable queue admission or run inside the
production controller yet. The [queue runtime gate](queue-qualification.md#resume-generation-gate)
provides its runtime operations.

| Field | Meaning |
| --- | --- |
| `desired` | Operator intent: paused or running |
| `hold` | Activation that requires a delivery pause; null after confirmed release |
| `version` | Version from the last confirmed activation completion, or null before first completion |
| `observed` / `observedAt` | Last recorded runtime observation, or unknown |
| `operation` | Last operation whose confirmation has not been durably recorded |

A held queue's effective target is paused regardless of operator intent. `confirmed`
is true only when there is no pending operation and the recorded observation
matches that target. These are historical observations, not a lease guaranteeing
that the runtime cannot change afterward. A controller migration gate must also
check that the current activation owns the hold. A queue can still be running after
an uncertain resume while its effective target says paused. Only the observation
and confirmation fields describe what was established. It may keep running until
reconciliation actually pauses it.

## Operation ordering

Each mutation durably records intent, an unknown observation, and a pending
operation before calling the runtime. Success requires the returned pause state to
match the requested operation, then a durable confirmation write. A runtime error
leaves the pending operation unknown. A persistence error disables that journal
instance: reload from durable storage before further work, since the write may
have committed despite its error.

`hold(id)` pauses delivery without changing operator intent. A corrected deployment
can use `hold(newId, { replaces: oldId })`; the expected old owner must match.
The controller must authorize that transfer and serialize it against activation.
Transfer does not publish code or release delivery.

`completeActivation(id, version)` requires a confirmed pause owned by that
activation. Only the activation coordinator may call it, after migration,
publication, and readiness checks. It retains the hold during the runtime call and
clears it only with the confirmed outcome. An operator pause stays paused across
completion. Resume still checks the exact queue cell and approved runtime generation.
When operator intent is paused, completion confirms pause without validating the
runtime version; the coordinator must already have established readiness. A later
resume independently checks the recorded version. This method must never be used
to discard a failed migration's hold.

If activation release fails or is interrupted, the hold remains. Explicit
`reconcile()` first applies the effective pause; the coordinator then rechecks
readiness and explicitly completes activation. This may briefly pause delivery
that had already resumed before its response was lost. It avoids releasing a
failed activation merely because the runtime later becomes reachable.

Construction and reload never perform runtime operations. `observe()` invalidates
the old observation before reading status and does not release holds or clear
pending operations. `reconcile()` explicitly reapplies the effective target. With
no hold, a pending operator resume can resume again using the recorded version.
Repeated celld pause/resume operations are covered by the live probe.

## Qualification

```sh
node --test packages/platform/test/delivery*.test.mjs
```

Subprocess tests send SIGKILL before an effect, after an effect, and after confirmed
persistence, for both operator resume and activation release. They also interrupt
observation between writes. Journal and fake-runtime files use the real fsynced
`saveJson` implementation. This qualifies process interruption, not power-loss
recovery or celld behavior. Separate tests cover generation refusal through the real
`QueueRuntime` adapter, contradictory results, persistence failures, explicit hold
transfer, and overlapping calls.

After preparing a native imports fleet with the [qualification guide](queue-qualification.md),
exercise the journal against real celld:

```sh
node scripts/queue-delivery.mjs slot-1 .fogd/queue-delivery
```

This probe persists its journal in the private evidence directory. It injects a
lost response after a real resume, reloads the journal without effects, and explicitly
observes and reconciles. It also preserves an operator pause across simulated
activation completion and leaves delivery paused. It does not test controller
approval, migrations, publication, or controller-container failure.

The controller must own one journal instance per app, serialize publication across
all journal operations, and use a single durable save path for its metadata.
Controller startup must reconcile held queues toward pause before permitting
migration work; it must not automatically resume unheld queues with uncertain
operations. Bootstrap progress, public admin authentication, controller restart handling,
backup/recovery age policy, retirement, and artifact admission remain integration
work. See [ADR 026](decisions.md#adr-026-retain-activation-holds-until-confirmed-delivery-release).
