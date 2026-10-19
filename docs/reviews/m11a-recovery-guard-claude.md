# Claude review: queue recovery boundary

I reviewed this from the code itself: the working diff, the untracked `queue-safety.mjs` and its test, the controller state model, kube shape and inventory, and the pinned celld harness. The new test passes (3/3). I didn't edit anything.

**Verdict:** the refusal is correct where it matters and fails safe. I found one real gap (Kubernetes `envFrom`) and one UX problem worth fixing in this slice. In the next protocol proposal, three parts are overbuilt. The persisted startup deadline is the main one, and it can be dropped.

## Immediate implementation

**What holds up**
- The queue marker is permanent. `requireQueueCapability` sets `fogd-queue-activation-v1` when a request is submitted (`controller.mjs:108`) and when it is approved (`controller.mjs:172`), and nothing removes it. So pending or rejected queue history is caught even after the app record changes.
- The controller only reads `FOGD_DATA_DIR` (`platform/src/main.mjs:15`), and Compose folds `env_file` into `environment`. The Docker check in `layout-validation.mjs:26` therefore covers Docker. Edge values like `''` or `null` are refused, which is the safe direction.
- On restore, the checksum is verified before the state check runs, and the state check runs before any image load or volume creation. That holds for Docker restore, expand, retire and the direct `restoreInstallation` entry, and for `kubeRestore`. The kube controller claim is pinned by `contract.mjs` claims, so it can't be missing from a bundle.
- Missing or unparseable state refuses without echoing its contents.

**Issues, most important first**
1. **Kubernetes bypass through `envFrom`.** `shape.mjs:38` only inspects `main.env`, and nothing rejects `envFrom`. The `fogd-private` Secret accepts extra keys, because `privateValues` only reads the keys it knows. So a hand-edited `manifests.json` with `envFrom: secretRef fogd-private`, plus a `FOGD_DATA_DIR` key in that Secret, survives `kubectl diff` and gets a nested data dir past the check. Fix: reject `envFrom` on every container in `validateSet`/`validatePod`. It's one line.
2. **A refused backup takes the source down for no reason.** Backup stops all writers before it finds out it will refuse. Because the queue marker is permanent, a read-only look at the live `state.json` before stopping gives a definitive "queued, refuse now" with no outage. `saveJson` writes via temp file and rename, so that live read is atomic. Keep the post-stop check, since a request can still be submitted during the window. In Docker that's a one-shot `--mount ...,readonly` helper running `cat /data/state.json`; in kube, an exec `cat` before `stop`. The doc's line "Backup stops the installation and … leaves the source stopped" would then apply only to that race.
3. **The guard checks less than the controller's own validator.** `validateQueueState` also scans `deployments[*].resources.queues`; `assertQueueFreeRecovery` only looks at apps. In practice the controller refuses to boot when queues exist without the marker, so this isn't an exploitable hole, but the two can drift. Export one predicate from `@fogd/platform` and use it in both places, the same way `./retirement` is already exported.
4. **The backup refusal has no test.** Only the restore side is tested. Add a queued-state case to `scripts/installation-recovery.mjs` and `scripts/kubernetes-recovery-negatives.mjs`. It should assert three things: no `manifest.json`, the source is stopped, and `controller.tar` is kept.
5. **Minor items:**
   - `'data-controller-0'` is hardcoded twice (kube `backup.mjs:32`, `restore.mjs:29`); use the constant from `contract.mjs`.
   - `snapshotState` extracts with the host's `tar -xO ./state.json`, but restore extracts with GNU tar inside the container. A forged bundle with both `./state.json` and `state.json` could show the check one file and restore the other. This is low priority because the operator writes the bundle, but a `tar -tf` check for exactly one state entry closes it.
   - The extra `assertQueueFreeRecovery` calls in `expand`/`retire` duplicate the one in `restoreInstallation`. They're fine to keep because they give a clean error before planning starts.
   - Behaviour change: a bundle from a controller that never started (no `state.json`) now refuses. That's acceptable; just mention it in the doc.

## Next protocol proposal

**Overbuilt: drop or simplify these**
- **The persisted startup deadline, the supervisor check on every restart, and the release state shared with replicas.** The deadline only buys "replicas stay stopped and storage is kept", and the immutable backup bundle already gives you that. Records that were inside retention at backup time stay in the bundle indefinitely. Holding the restored replicas back preserves nothing the bundle doesn't, and expired rows can't be delivered anyway. Without the deadline, the startup race, the problem of a permanent deadline stopping a healthy fleet, and the shared-release design all go away. Use a one-shot clock check at restore, plus detection on the controller's first boot (below).
- **The privileged one-shot helper that writes queue journals.** The existing admin pause already persists operator pause in the controller and in celld's journal (`_setPaused` writes meta before rearming). The admin UI says operator pause persists across successful approvals, so an approval racing the stop can't undo it. Pause through the existing path, confirm with `observe`, then stop everything. Ingress during that window doesn't matter because new messages are younger than the bound.
- **"Account for newly admitted messages in empty queues."** Messages admitted later always have `enqueued_at` at or after the time of the info read. DLQ transfers also insert with `now` (`harness.js:~7036`). So for an empty queue the bound is just the observation time. No accounting is needed.

**Gaps that block the proposal as written**
- **Retention length must be recorded, not assumed.** `retentionMs` comes from runtime config (`__cell.queueLimits`), so the CLI must not hardcode it.
- **The count-discrepancy rule needs to be exact.** `stored_count` includes rows waiting to be purged and expired rows that haven't been swept; `oldest_message_timestamp` excludes the purge-pending ones (`harness.js:6315`). Use `stored === backlogCount`, otherwise refuse. "Unexplained" is too loose.
- **Claim at-least-once delivery only.** Messages leased at stop get redelivered after resume, and handlers that were mid-run may already have side effects in D1. Say this plainly.
- **Clock skew.** Docker containers share the host clock, so skew only matters if you restore on a different machine. Use one fixed margin with a `ponytail:` note, not a skew protocol.

## Smallest next end-to-end protocol (Docker only)

1. **Backup:**
   - For each queued app, run the existing admin `pause`, then `observe`.
   - Extend `observe` to save the info result in the delivery journal: `{ stored, backlogCount, oldestMessageTimestamp, retentionMs, at }`.
   - Stop everything, then archive the controller.
   - The offline guard reads the archived state and refuses unless every app with a `delivery` record meets all of these: desired is paused and observed is paused; no `hold` or `operation` in progress; bootstrap is not `pending`; `stored === backlogCount`; and the evidence is newer than the app's last state change.
   - Write `earliestExpiry = (oldest ?? at) + retentionMs − margin` into the manifest.
2. **Restore:**
   - Refuse if `clock() ≥ earliestExpiry`. The clock is a function parameter, not an env knob.
   - Write `state.recovery = { snapshot, earliestExpiry }` into the restored controller volume, reusing the `writeRetirement` saveJson-and-verify pattern.
3. **Controller first boot with `state.recovery` present:**
   - Delivery stays operator-paused, because the journal already says so.
   - Compare the live `info` against the evidence. If the clock has passed `earliestExpiry`, or the live backlog is lower, set `deliveryRecoveryError`: possible expiry, reconcile from the D1/R2 input, the bundle has been kept. Otherwise clear `state.recovery`.
   - This needs no new release action. Resume is already digest-bound, and an explicit `pause` already clears `deliveryRecoveryError` (`admin-delivery.mjs:42`).
4. **Tests:**
   - Injected clocks on both sides of `earliestExpiry`, with a real subprocess `fogd restore` that refuses past it.
   - A case where boot-time detection fires after a delayed `compose up`.
   - A case where `stored !== backlogCount` refuses.
5. **Kubernetes and legacy bundles:** Kubernetes stays refused. Legacy queued bundles, which have no evidence, stay refused, as they are today.

The kube `envFrom` rejection (item 1) and the pre-stop refusal (item 2) are worth landing in this slice. Everything else in the immediate change is ready as it stands.
