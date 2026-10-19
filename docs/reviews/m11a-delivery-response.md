# Delivery journal review response

The [initial review](m11a-delivery-claude.md) found a blocker: activation completion
cleared the hold before a runtime generation check could refuse resume. The revised
journal retains the hold until confirmed delivery is durably recorded. After
interruption or refusal, reconciliation pauses held work; the coordinator must
recheck readiness and explicitly complete activation. The [follow-up review](m11a-delivery-final-claude.md)
found no remaining blockers and accepted this simpler alternative to a separate
releasing-activation record. [ADR 026](../decisions.md#adr-026-retain-activation-holds-until-confirmed-delivery-release)
records the tradeoff.

Accepted improvements include validating returned runtime state, private persistence
dependencies, `effective` and `confirmed` getters, and the name `reconcile` for
explicitly reapplying intent. The version now changes only in the confirmed
activation write. A refused candidate does not replace the previous version.
Observation rejects nonboolean status, and journal validation rejects unknown keys.

Tests drive generation refusal through `QueueRuntime`, preserve hold ownership after
lost responses, and transfer an uncertain hold to an explicitly named correction
without resuming. Process-kill tests check both journal and fsynced fake-runtime
files before and after reconciliation, including interruption during observation.
They do not establish power-loss durability. The live probe confirms repeated
pause/resume calls against celld, including reconciliation after an injected lost
response from an already successful resume.

Scope remains explicit: activation readiness and authorization belong to the
controller, not this journal. Completing an operator-paused activation confirms
pause but does not check runtime version; later resume does. A held journal is not
proof of paused delivery after a failed operation. Controller startup must attempt
the appropriate pause reconciliation before migration work, without automatically
resuming uncertain work. The live probe reconstructs an object; process restart is
covered by subprocess tests. It does not kill the real controller or qualify its
approval, bootstrap, migration, or retirement paths.
