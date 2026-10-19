I found no blockers. The lock and authorization model holds: everything is behind Basic auth, mutations check CSRF and origin, and approval/activation already run inside `controller.exclusive`. So the only real race is with startup recovery. The issues below are ordered by severity.

## Should fix before merge

1. **The serialization test passes even without serialization** (`test/admin-delivery.test.mjs:121-128`). `release()` runs right after `f.post(...)` is issued, often before the request reaches the server. If someone moved the `resumable`/hold check outside `controller.exclusive`, the request would still usually see `hold = id` and get 400. To make the test meaningful:
   - Wait until the POST is actually queued behind `changing` before calling `release()`. One way is to wrap `c.exclusive` to count entries, or poll until the request body has been read.
   - Or invert it: while gated, set the hold, then clear it inside `changing`, and assert the resume succeeds only after the release.

2. **The CLI resume doesn't really bind to the exact deployment ID** (`cli/src/platform.mjs:36`). The CLI fills in `deployment: state.apps[app]?.active` from the `/v1/admin` fetch made moments earlier. Only the digest comes from the operator, so the server's deployment-ID check is satisfied by whatever is active now. Failure sequence:
   - The operator inspects deployment D1 (digest X).
   - Someone resubmits X with a different secret revision, and it activates as D2.
   - `fogd admin delivery app resume X` passes the check against D2, under secrets the operator never reviewed.

   The generation gate still keeps it to the current approved version, so this is intent binding, not runtime safety. Fix: take an optional/required deployment ID (`resume ID SHA`), or at least print the deployment ID with the digest in `status` and require both. The UI is fine: it binds the values shown when the page rendered.

## Worth fixing (low risk, clear failure mode)

3. **An operator pause during an activation hold silently carries through the activation.** `Delivery.pause` sets `desired: 'paused'`. `completeActivation` then releases to `next.desired`, so a later successful approval sets `route = 'active'` but leaves delivery paused, and the approvals page says nothing about it. That's probably the intended semantics, but the approval UI/CLI should show "delivery will remain paused (operator)". Otherwise this looks like a stuck queue after deploy.

4. **Observe while a hold has an unconfirmed `pause`.** This state comes from `interruptQueueActivation` or a failed `recoverQueueHolds`. Observe calls `celld info`, which materializes the cell, possibly on the published-but-unapproved generation from the failed activation. It does that without trying to pause. The marginal risk is small (a producer send also materializes it), but the safer behaviour is: if `hold && operation === 'pause'`, make "Refresh status" do `reconcile()` instead of `observe()`, or hide observe there.

5. **`deliveryRecoveryError` stays after a successful operator pause.** The operator pause confirms paused and clears `operation`, but `deliveryRecoveryError` is still shown ("Queue pause could not be confirmed"), contradicting the recorded observation. Clear it in `operateDelivery` on a successful pause/reconcile, as `recoverQueueHolds` does.

6. **Status code for an unconfirmed outcome.** `QUEUE_OPERATION_UNCONFIRMED` currently falls through to the generic 400. That is a server-side uncertainty, not a client error, so scripts can't tell it apart from validation refusals. Use 409/502 (or 503) on `error.code`, the way storage errors already get 503.

## Minor

- `deliveryHTML` shows observe/pause buttons for retired, quarantined, or `queueBootstrap.phase === 'pending'` apps, and they always fail. Gate them the same way `operateDelivery` does.
- All errors inside `deliveryFor(...)[action]()` are collapsed into "could not be confirmed", including definite refusals that happen before any effect. One example is `assertQueueGeneration` refusing after `info`. That's conservative and fine for secrecy. Just note the journal now records `desired: 'running', operation: 'resume'` after a refused resume, so the next hold release will resume. That matches operator intent, but it should be documented.
- `input` can be the JSON value `null`, which gives a TypeError message on resume. It's harmless (400), but `input ?? {}` or an object check is cleaner.
- CLI: extra positional arguments after `resume SHA` are silently dropped by `admin(action, id, digest, secretRevision)`.

## Checked and OK

- **Secret leakage:** `deliveryView` and `adminApp` strip `delivery.version` and `queueBootstrap.version`. `adminDeployment` strips the version when `secretRevision` is set. Runtime diagnostics (the error `cause`) never reach responses, and the test asserts this. `recoveryError` is a fixed string. App names are limited to `[a-z0-9-]` and HTML-escaped, the CSRF token is hex, and the CSP is unchanged.
- **Authorization:** Basic auth is checked before `deliveryRequest`. Deploy and gateway bearers get 401. The internal role returns 404 before routing. Mutations check CSRF, then origin, before the body is read. GET is never routed to the mutation path.
- **Serialization:** `operateDelivery` runs entirely under `controller.exclusive`, the same queue as `mutate` → `activateRelease`. So there is no interleaving with publish or `completeActivation`, and building a new `Delivery` per call is safe. Storage failure gives 503 before effects, because `persist` calls `assertStorage` and intent is written before the runtime call.
- **Resume gate:** exact ID/digest, `status === 'active'`, `route === 'active'`, no quarantine/retirement/`uncertain`/hold, bootstrap phase `application`, and `active.version === delivery.version`. `QueueRuntime.resume` then checks every replica's generation and that exactly one resident queue cell exists.

## Dependencies on later gates

- Resume trusts `delivery.version === active.version`. Hold transfer for a corrected artifact must keep `delivery.version` pinned to the last approved runtime until `completeActivation`, which is what `#apply` does today. Otherwise an operator resume could pass the controller check against a superseded generation. The replica gate still catches this, but only by refusing after `info`.
- `recoverQueueHolds` runs in `init()` before the HTTP server serves, so there's no race now. If recovery or retention ever moves to a background loop, it must go through `controller.exclusive`, or operator actions will clobber `app.delivery` (last save wins).
