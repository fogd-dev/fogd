I'd keep the Docker default at `FOGD_QUEUE_APPS=0`. Most of the M11a acceptance list has real evidence behind it, but two requirements are still open: the populated-neighbor retirement rerun, and an offline second-target build of `examples/imports`. Even once both close, I'd recommend changing "experimental" to "supported opt-in" rather than turning queues on by default.

## Requirement → evidence map

| m11a.md requirement | Evidence | Verdict |
|---|---|---|
| Submission acknowledgement | `scripts/queue-public.mjs:65` checks for 202. | ✅ |
| Page reload | `scripts/queue-public-browser.mjs` uses Chromium through workerd with no request interception. It reloads while paused and again after completion, and checks the saved URL is unchanged. | ✅ |
| Successful completion | `queue-public.mjs` normal mode; the job shows 1 attempt and 2 result rows. | ✅ |
| Duplicate delivery | The recovery drill sends two queue messages for one job. Both survive restore and produce exactly 2 rows (`queue-public-recovery.mjs`). The re-POST checks in `queue-public.mjs:75-76` only test idempotent resubmission. | ✅ (the recovery drill is the real proof) |
| Retryable failure | `retry-once` reaches 2 attempts and completes; the browser drill repeats this. | ✅ |
| Terminal failure | `fail` mode stops at `failed` with 2 attempts (`queue-public.mjs:67-69`). | ✅ |
| Explicit retry without duplicate business records | After retry the job completes with 2 rows. A resubmit leaves the job unchanged. | ✅ |
| Acknowledge and schedule are separate effects (retry/outbox boundary) | `lib/jobs.mjs` saves input, then the D1 row, then sends. Resending is idempotent. `examples/imports/test/jobs.test.mjs:8` covers a send failure. | ⚠️ Unit test with a stand-in only. Acceptable because the boundary is app logic. |
| Scoped submission and exact approval | `queue-public.mjs:34-51` covers credential scope and refuses a wrong digest. | ✅ |
| Nothing happens before approval | No owner and no `deploy/` objects before approval, and the route returns 404 (`queue-public.mjs:45-50`). The rejected claim leaves a release receipt. | ✅ |
| First-deploy migrations | Canonical approval activates and serves; the bootstrap ordering is shown privately (`m11a-activation.json`). | ✅ |
| Additive update with pending and in-flight work | `queue-public-update.mjs` keeps v1 in flight while v2 is approved. The migration is present before resume, v2 finishes first, and each job has one attempt. | ✅ |
| Consumer failure and restart | Handler exceptions are tested canonically. Killing the consumer process is only tested direct-to-runtime (`m11a-native-imports.json`). | ⚠️ Weak but acceptable, since runtime behaviour doesn't depend on how the app was admitted. |
| Controller failure at activation boundaries | History drill: controller SIGKILL plus a stopped replica during an approved update, then retry with admission off. Activation process-kill tests cover the rest. | ✅ |
| Stopped backup/restore with queued work | Two pending messages, then backup, then a fresh-project restore. HTTP stays at 503 until acknowledgment, the changed review is re-acknowledged, and resume drains the queue. | ✅ |
| Keep existing three-app isolation | Canonical runs use two fleets. Three-fleet queue isolation exists only as private-artifact evidence (`m11a-queue-retirement*.json`). | ⚠️ Acceptable, because the admission flag doesn't touch fleet layout. Should be stated in the closeout, not implied. |
| Retirement keeps old queue state and never activates it in a replacement | Old-prefix bytes are identical before and after retirement and replacement, the retired route returns 404, and `delivery` is undefined. | ✅ for the retired app |
| Retirement preserves the neighbouring app | `m11a-queue-public-retirement.json` has `neighbor.rows: []` and `dataPreservationQualified: false`. | ❌ **Open.** Populated rerun not yet run. |
| Same source through ordinary offline Void builds | `scripts/verify-builds.mjs:36-40` builds only guestbook, grown and accounts. I found no managed-target build of `examples/imports` in the scripts or docs. The only imports build is the fogd target via `fogd deploy`. | ❌ **Missing.** |

## Unmet or weak, in priority order

1. **Populated-neighbor retirement rerun is still open.** The current `--seed-neighbor` change looks right:
   - It seeds before pause and backup, so the sentinel is in the snapshot.
   - It checks the sentinel appears through the gateway.
   - It now requires `neighborRows.length > 0` on every run. A rerun without the flag on this fixture will fail, which is the safe outcome.
   - It compares the rows exactly after retirement and again after replacement approval.
   - Caveats:
     - The seed is a direct D1 write through the controller's `Backend`, not through the app. That's fine because hello has no POST route, but the evidence should say "backend-seeded".
     - `replacement.rows` is saved but never asserted. Adding `assert.deepEqual(await served.json(), [])` is a one-line check that the replacement didn't inherit data.
2. **No offline second-target build for imports.** Add `examples/imports` to `verify-builds.mjs` (fogd plus the managed target). No credentials are needed.
3. **The failed-claim bundle was never restored.** It is marked "requires crash recovery" after two replicas exited 143. It isn't an m11a.md acceptance item, because the recovery drill restored a later snapshot. The doc should record it as an accepted gap rather than "next work" (`docs/queue-admission.md:50`, `docs/report.md:706`).
4. **Stale docs to fix in the closeout:**
   - `docs/queue-activation.md:4-6, 39, 96-99` still say admission is closed, queue retirement is refused, and public acceptance is pending.
   - `m11a.md:3-5` status line.
   - `docs/evidence/m11a-queue-public.json` `limits[1]` still lists update/recovery/retirement/browser as pending.

## Default decision: keep it at 0

- **Gates:** items 1 and 2 above are unmet, so flipping the default now would get ahead of the acceptance list.
- **Policy, even after the gates close:**
  - **Expansion and Kubernetes:** approving a queued app permanently rules out `fogd expand` and Kubernetes recovery for that installation. This applies to activated *and* retired queue history (`docs/queue-recovery.md:4`, `packages/cli/src/recovery/expand.mjs:8`).
  - **Off doesn't stop work:** setting the flag back to 0 doesn't pause consumers that are already approved.
  - **Retention:** paused messages still age out on wall-clock time, and retirement source volumes can bring retired work back if restarted.
  - These are consequences an operator should choose deliberately. The admin approval step does show the queue, but the default shouldn't commit an installation to this before anyone asks for it.
- **Recommended closeout:** keep `compose.yaml:103` and `.env.example:35` at 0. Mark Docker queue admission **supported opt-in** once items 1 and 2 pass. In the opt-in docs, state the expansion/Kubernetes lock-in plainly next to the flag. Kubernetes stays refused, as agreed.

I made no edits or Docker calls.
