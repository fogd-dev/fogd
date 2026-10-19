# M11c design review response

[Claude](m11c-design-claude.md) recommends native scheduling with a stronger
bootstrap and durable stop policy, switching to native hold controls if those
operational requirements cannot be met. [Gemini](m11c-design-gemini.md) recommends
native hold controls directly and identifies a retry-identity defect to reproduce.
[ADR 046](../decisions.md#adr-046-preserve-native-cron-execution-with-durable-dispatch-controls)
selects native controls rather than a fogd scheduler or whole-app stop policy.

Accepted findings: first activation needs app-free D1 bootstrap; exact approval
must precede execution; timer state is distinct from HTTP routing; restoring old
alarms can replay effects; Void siblings sharing an expression require per-job
idempotency; native retry identity needs an eviction experiment; cron controls
must use authenticated reserved-runtime routing. A basic two-tick native probe
passes. It is not the complete scheduled-app qualification.

Several review suggestions need correction before implementation:

- `celld queue pause` is not an offline bucket mutation. `queue_cli.rs` uses
  `Reachable::open` and calls the live reserved cell. A future cron CLI cannot
  inherit offline control merely by copying that command.
- Checking recovery metadata after boot cannot prevent a restored overdue alarm
  from firing. The supported backup protocol must capture the runtime hold and
  verify it before restore starts replicas. An active, uncontrolled snapshot needs
  refusal or a separate offline mechanism.
- Existing updates migrate before publishing the new release. Old handlers can
  still overlap those migrations, including after a pause request. Neither a
  boolean hold nor a momentary running count proves all external effects drained.
- A durable retry record must identify expressions safely across schedule changes;
  persisting only array indices can redirect an old retry to a different job.
  State and alarm changes need atomicity and compatible recovery semantics.
- Version fencing must use actual runtime provenance. The suggested
  `this._env.__version` is not an established runtime API. Do not introduce that
  fictional field or claim a replica observation is an atomic fence.
- Upstream cron retry backoff starts at four seconds with the current call's retry
  count of one (`alarm_retry` shifts the two-second base). Reproduction must record
  actual deadlines instead of assuming a two-second window.

Implementation starts with D1-only bootstrap support and a native retry-eviction
negative control. Then build and review the smallest runtime primitive that meets
the [M11c contract](../m11c.md), followed by ordinary Void CLI approval, operator
controls, failure/recovery qualification and portability builds. Admission remains
closed throughout the initial runtime experiments.
