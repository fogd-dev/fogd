I found two blockers to fix before committing. The rest of the foundation holds up. The tests pass: runtime and CLI 14/14, `platform.test.mjs` 40/40, and the queue-activation and queue-replacement suites 77/77.

## Blockers

**B1. With queues turned off, a held queued activation can't be cleared.**
- `assertQueueAdmission(request, 'approve')` at `controller.mjs:162` refuses every approval of a queued request. That includes `status: 'failed'` retries of the request holding the delivery hold.
- `assertQueueDecision` (`queue-activation.mjs:75`) already refuses rejection while that hold exists. So once `FOGD_QUEUE_APPS=0`, there is no operator action that clears the hold. That breaks your rule that existing approved queue lifecycles stay operable.
- The Compose default is `0`. Any queued installation that restarts without setting the variable lands in this state.
- Fix: gate only new admission. Check `request.status === 'pending'` in `mutate`, and leave `failed` retries and held-hold retries alone. Add a test: queue on, fail the activation, restart with queues off, retry succeeds.
- Related, not a blocker: the submission gate also blocks any update to an already-active queued app, because removing queues is refused. That freezes those apps while the flag is off. Gating only queue introduction (no `app.delivery`) would fix it. If freezing is intended, say so in the docs.

**B2. Some never-approved queued requests are never counted as inert, so backup refuses forever.**
- The predicate requires `status ∈ {pending, rejected}` and `!state.apps[request.app]`. Ordinary operator use breaks both:
  1. Submit queued `hello` (P) and leave it pending. Submit and approve a non-queued `hello` (N). `activation.mjs:26` marks P `superseded`. `superseded` isn't accepted, and `apps.hello` now exists.
  2. Submit queued `hello`, reject it, then deploy a non-queued `hello`. The app record now exists.
- In both cases `hello` is not in `names` because it has no queues or delivery. So `queueBackupApps` throws "requires an activated app for every queue declaration", and `assertQueueFreeRecovery` refuses too. There is no remedy: superseded and rejected requests can't be mutated, and history is permanent.
- These records can never gain authority. They never got a `secretRevision`, and `compatible()` refuses adding queues to an app that's already deployed.
- Fix: for the `step === 'submitted' && !hasOwn(secretRevision)` branch, also accept `superseded`. Drop the app-absence requirement there. Instead require that no app record references the request id (`claim.deployment`, `delivery.hold`, `active`, `uncertain`). Keep the strict app-absence check for the `claimRelease` branch.
- Add the two scenarios above as backup and queue-free regressions.

## Should fix (small)

- **The predicate doesn't check that the queue name is canonical.** `queue-history.mjs:7` only runs `validateQueueDeclaration`. It never checks that the physical name is app-prefixed. The CLI fixture uses `queue: 'imports'` for app `imports`, which is non-canonical (canonical is `imports-imports`), and still passes. Use `isDeepStrictEqual(translateQueues(q, request.app), q)`, and fix the fixture to use a canonical name.
- **The id check is loose.** `validIdentity` matches `/^[a-f0-9-]{36}$/`. The strict UUID regex from `claimApproval` in `claims.mjs` would be better.
- **Nothing tests that Kubernetes stays off.** `kubernetes/workloads.mjs:29` builds the env from an explicit allowlist, so `FOGD_QUEUE_APPS` can't leak in today. One assertion that the rendered controller env omits it would lock that in.

## Checked and correct

- **Name round trip:** prefixing applies only when the name lacks `app-`, and applying it twice gives the same result. `receiveArtifact`'s `isDeepStrictEqual` rejects an uploaded `queues: {}` because translation drops it. Policy order is fixed by `Object.fromEntries`. Queue runtimes are per-fleet, so derived names can't collide across apps.
- **Binding and secret conflicts:** both include producer bindings, compared case-insensitively.
- **Opt-in before effects:** `assertQueueAdmission` runs before `requireQueueCapability` and before persisting, and the test asserts the capability is absent after a refused submission. Rejection stays allowed. `main.mjs` accepts only `0` or `1`, and the Controller defaults to `false`.
- **Claim release receipt:** it's written in `rejectUnclaimed` only after the pristine, other-fleet and `assertUnclaimed` checks, in memory before the caller's single save. The ambiguous-persistence test covers both the committed and uncommitted cases. Branches with claimed, failed, held or uncertain state still return false. A queued request that claimed successfully and then failed keeps its app record, so it still refuses, which is the intended boundary.
- **Shared predicate:** Docker backup, expansion and Kubernetes restore/backup all route through `queueBackupApps` or `assertQueueFreeRecovery`. Restoring artifact-only state returns `null` from `restoredQueueState` and needs no queue evidence. The permanent capability is kept, and allowed in the queue-free path only when every declaration is artifact-only.

B1 and B2 are the only commit blockers. Full real-Docker public acceptance remains the next step, as your scope says.