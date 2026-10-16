# Claude roadmap review

Review complete. Here it is.

# fogd roadmap review (Claude)

Verified claims cite this checkout. Everything under "proposal" is my recommendation, not observed behavior.

## 1. Product promise and users

**Promise as built:** "Run reviewed Void apps on hardware you own, with Cloudflare-shaped bindings, replicated state, and an exact-artifact approval gate. No Cloudflare account." That is what `docs/report.md` and `packages/platform/src/controller.mjs` actually deliver.

**Users, separated:**
- **App developer.** Writes a Void app, runs `fogd deploy`, wants the app to run unchanged. Today they get one D1, R2, local DOs, assets, string vars. Nothing else, and a hard failure otherwise (`packages/runtime/src/artifact.mjs:5`).
- **Approver.** Reviews a digest and resource/migration list and clicks approve. Today this is the same person as the operator (one Basic credential).
- **Operator.** Owns Docker, MinIO, volumes, node identities, backups. Today has no backup tooling at all. `README.md:139` names backups as needed, and nothing in `scripts/` implements them.
- **End user.** Hits `<app>.<base-domain>` and gets a 503 during every activation (`packages/runtime/src/gateway.js:14`).

**Assumptions needing your validation:**
1. Is approver really a distinct person from the submitter in your use, or is the gate protecting you from yourself? If the latter, the whole submit/approve surface is a lower priority than rollback.
2. Do you have a real app of your own you intend to run on this? The two samples are synthetic. The roadmap changes materially depending on the answer.
3. Is "Cloudflare compatibility" about portability (write once, run on either) or about escaping Cloudflare (never go back)? Portability needs conformance work. Escape needs reliability work.

## 2. Scenarios, by value

1. **Launch a real app you care about** on the homelab and keep it there. Success: it survives a month, including one host reboot and one deliberate restore from backup. Failure: data loss, or you quietly move it back to Cloudflare.
2. **Ship a code-only change.** Success: approve, brief 503, new version serving. Verified today by the smoke test. Failure mode to watch: the pause window is unbounded if a replica never reports the version (`backend.mjs` ready loop, 180 s deadline).
3. **Ship a schema change and then discover it was wrong.** Today: migration is forward-only, applied hashes immutable, code rollback requires a fresh submission (`controller.mjs` `compatible()`). Success should mean "re-activate the previous approved digest in one admin action." Nothing implements that.
4. **Add a binding to a running app** (a second R2 bucket, a KV namespace). Today rejected: `Resource identities changed`. Success means an explicit resource-change operation with its own approval.
5. **Background work:** a nightly cron, a queue consumer, a DO alarm. Cron and queues are rejected by the adapter. DO alarms are admitted (DOs are supported, alarms are a runtime API with no config to reject) and they ignore the pause. See trap 3.
6. **Real-time:** a WebSocket or SSE route through workerd into celld. Not qualified (`docs/report.md` says so). Success: a live-query page stays connected across one replica failure, or reconnects within a stated bound.
7. **Incident:** MinIO dies, or the controller volume is lost. Today: slot quarantine logic exists (`controller.mjs init()`) and is unit-tested, but the restore procedure is prose only. Success: a scripted restore drill that passes on a fresh host.
8. **Growth:** a third app. Today: edit Compose, add a slot. Acceptable for a homelab. Not a scenario to optimize yet.
9. **Two hosts:** one replica per slot per machine. Today the fleet networks are Docker bridge networks and `--advertise` uses Compose service names (`compose.yaml`), so this has never been run.

## 3. Compatibility tiers

| Tier | What it means | Where fogd is | Who owns the gap |
| --- | --- | --- | --- |
| T0 Config acceptance | wrangler keys accepted without error | Allowlist in `artifact.mjs` | Adapter |
| T1 Runtime API semantics | `env.DB.prepare()`, `R2.put()`, DO RPC behave like docs | Inherited wholesale from celld | Upstream celld. fogd adds nothing and should not |
| T2 Lifecycle and failure | deploy, migrate, pause, rollback, background events during change | Custom controller, partial | fogd |
| T3 Control plane | Void Platform / wrangler / WfP API shapes, roles, OAuth | Absent by design (ADR 006) | Dedicated service, or never |
| T4 Operational | anycast, global cache, DDoS, managed TLS, zero-downtime | Two hosts cannot duplicate | Nobody. Document honestly |

**Upstream gap vs adapter vs fork, from `docs/compat.md`:** KV, queues, cron, workflows, static assets are all "Yes" in celld standalone. Admitting them is T0 adapter work plus T2 lifecycle design. AI, Hyperdrive, Analytics Engine, dispatch namespaces are "No" in celld's `SUPPORTED_KEYS` allowlist. Those need a dedicated service or an upstream patch, and none has a credible self-hosted backend except Hyperdrive-as-plain-Postgres. A fork of celld is not justified by anything found so far; ADR 004 and ADR 005 both found upstream configuration sufficient.

**Conformance without Cloudflare:** the only honest oracle is Cloudflare's published docs plus workerd's own API tests. A differential test of celld vs workerd for D1/R2/DO calls would catch divergences between the two runtimes, which is useful, but neither is hosted Cloudflare. Say "matches workerd at pin X," never "matches Cloudflare."

## 4. Roadmap options compared

- **Reliability/backup/identity first.** Cheapest, and a precondition for everything else: you cannot run a real app without a restore path. Exit: scripted backup and restore of controller state, MinIO bucket, and replica volumes, verified by a drill that reproduces acknowledged data on fresh volumes.
- **Broader bindings first.** Highest developer appeal, but without a real app you are guessing which binding matters, and every background binding reopens the pause problem (trap 3) before you have rollback.
- **Homelab first.** This is the environment you said is next. It forces TLS, cross-host advertise addresses, and an external bucket endpoint, but on its own it just moves the same fragile stack to two machines.
- **Architecture first (dispatch, resource model).** Largest and least reversible. No evidence yet that two fixed slots are the bottleneck.

Dependencies: homelab needs backup first. Bindings need a pause/background design first. Architecture needs a real workload to justify it.

## 5. One next milestone: "First real app, operated"

**Outcome:** one app of yours runs on the two-node homelab for a sustained period, and you have performed one restore from backup and one rollback to a previous digest, both scripted.

**Included:**
- Backup/restore scripts for controller volume, bucket prefix, and replica volumes, with a drill in `scripts/`.
- Rollback: re-activate a previously active digest without resubmitting. Code only, schema stays forward-only, and the admin sees the applied-migration delta before confirming.
- Two-host Compose variant: external bucket endpoint, real advertise addresses, a TLS terminator in front of workerd. Replica IDs stay pinned to their volumes (ADR 005).
- At most one new binding, and only the one your real app actually needs.

**Excluded:** queues, cron, KV unless the app needs it; roles/OAuth; dispatch; multi-D1; resource-change operations.

**Acceptance scenarios:** scenarios 1, 3, 7, and 9 above.

**Decisions for you:**
1. Which real app. This is the only decision that matters.
2. Whether approver and submitter are really two people. If not, collapse the UX and spend the time on rollback.
3. TLS source: self-signed, your own CA, or a reverse proxy you already run.

**Opportunity cost:** developers evaluating fogd for portability see no new bindings for a while. That is the right trade: a platform that cannot restore is not a platform.

**Evidence that changes this:** if every candidate real app needs queues or cron, do the pause/background design and admit those bindings first, still with backup before homelab. If you have no real app, see section 7.

## 6. Architectural traps

1. **Immutable resource declarations.** `compatible()` deep-equals the whole resource identity. Adding one binding is a rejection, and the fix is a second state transition with its own approval, not loosening the check. Design it before admitting KV.
2. **Identity and volume coupling.** Correct and verified (ADR 005, `docs/reviews/recovery-claude.md`). The trap is operational: a backup that restores a volume under a different `CELLD_NODE` declares bounded loss. Backup scripts must carry the node ID with the volume.
3. **Background events bypass the pause.** Verified: pause is a state flag the gateway turns into 503 (`gateway.js`). Replicas keep running the old deployment, and migrations run before publish for existing apps (`controller.mjs mutate()`). A DO alarm firing during that window runs old code against the new schema. Admitting cron or queues makes this worse. The pause needs a replica-side quiesce, or activation must be defined as "new schema must be backward compatible with the active code," and enforced by review, not hope.
4. **Rollback and schema.** No rollback exists. Forward-only migrations plus "fresh submission to roll back" means a bad release costs two approvals and a migration-ledger reconciliation. Rollback-to-previous-digest is a small controller change because artifacts are already retained and digest-verified.
5. **Runtime API vs backend fidelity.** celld's D1 sessions are primary-only with a fixed bookmark, cache is always-miss, R2 multipart is process-local (`docs/compat.md`). Concretely: the gateway round-robins every request between replicas (`gateway.js` `next++ % 2`), so a multipart upload will split its parts across processes and fail. Either pin by session or reject multipart until celld makes handles durable.
6. **Cross-app services.** Rejected today, and `docs/compat.md` says celld RPC stubs cannot cross isolates. Supporting it means a shared fleet (ADR 002 rejected) or HTTP between fleets. Keep rejecting until a real app wants it.
7. **Resource isolation.** Shared bucket credentials and per-fleet Docker networks. Fine for trusted apps, and already documented. Do not let a bindings milestone silently add shared KV namespaces across apps.
8. **Bucket and controller failure.** Both single points, verified. The controller is one `state.json`; MinIO is one volume. The quarantine logic protects against the wrong fix, but nothing yet enables the right one.
9. **Conformance.** See tier note above. A workerd differential harness is worth having. Calling it a Cloudflare oracle would be false.

## 7. If the users are wrong

If you have no real app to run and the actual value is "a faithful local Cloudflare-shaped environment for Void apps I will eventually deploy to Cloudflare," then the approval gate, slots, and replica fleets are ballast. Strip to one celld replica, drop the controller, make `fogd deploy` direct again (the mode that already exists in `packages/cli/src/local.mjs`), and spend everything on T0/T1 breadth and a workerd-vs-celld conformance suite. That is a different product with a different roadmap, and it is a cheaper one. Decide which product this is before the next large chunk.
