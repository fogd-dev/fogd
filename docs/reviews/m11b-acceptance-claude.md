**Verdict: M11b can't close yet.** The last gate, item 2's refusal of upgrades before approval, has no passing evidence. The approval run already finished and failed. I found no other blockers that require new implementation. A few doc and evidence fixes are needed, plus one rerun.

## The approval run failed, and how to fix the script

`.fogd/m11b-approval/failure.json` shows the run failed on line 59. It waited for a 404 handshake status from Chromium's DevTools protocol and got nothing (`Received []` after 5 s). The checks before that line passed:

- staged release `pending`, app not routed;
- page GET returned 404 `Unknown app`;
- the browser socket got an `error` and close code 1006, with no `open` or message.

Cleanup appears to have worked. No `fogd-m11b-approval-*` containers remain, and all seven `fogd-m11b-sse-*` containers are up. The log file is empty (0 bytes), so I couldn't confirm the exit code or that the `['checklist','live-probe']` poll passed. Check that before reusing the fleet.

Chromium apparently doesn't report a status for a failed WebSocket handshake. The assertion that failed is also the only one that separates "never reached the app" from "the app refused it". A 403 `Forbidden origin` from `onBeforeConnect` also gives the browser an error and 1006. Keep the status check strict rather than dropping it.

Fixes, smallest first:
1. **Pre-approval status (blocker):** get the 404 status and `Unknown app` body directly. Send a raw Node `http.request` with `Upgrade: websocket` and the same `Host` and `Origin`. Keep the Chromium attempt as the browser-side observation. For the post-approval 101, keep the DevTools check if it fires; otherwise fall back to the raw request too.
2. **Wrong-digest check is too loose:** `assert.rejects(cli(['admin','approve',…,'0'.repeat(64)]))` passes on any error, including usage or auth errors. Match `/digest mismatch/` (the controller throws `Stored artifact digest mismatch`).
3. **Slot assumption is implicit:** `untouched(slot)` assumes app A lands on `slot-1` and app B on `slot-2`. Today that's true: `available()` picks the first unoccupied slot. Add `assert.equal((await admin()).apps[app].slot, slot)` after approval so the empty-storage check provably looked at the right prefix.
4. Optional: assert `release.submitter === credential.id` to back the "scoped upload" claim.

These parts of the script are sound:
- the target fleet is fresh (renamed volumes and networks, existence checks, no bind mounts);
- images are pinned by sha256 and match the candidate `2a6bc369…`;
- app B's refusal is tested while app A is already live, which is the stronger case;
- teardown keeps volumes and only restarts the source fleet if target teardown succeeded.

The rerun needs a new output directory, because `context()` refuses to reuse one.

## Item 6: "publish after durable acknowledgment"

**This needs a wording correction, not more implementation.** The code in `routes/rooms/[room].ws.ts` runs in this order:
1. `transactionSync` commits;
2. `await connection.send(ack)` and the snapshot;
3. broadcast to peers;
4. `void publishHint(...)`.

So "after" holds only in program order. The ack is held by the output gate until the write is durable, so the hint can leave, or time out, before the browser has its ack. The stall run showed exactly this.

The requirement still holds where it matters:
- A stalled or failed publish never blocks the ack or the next edit.
- `ChecklistObserver.hint` only triggers `refresh()`. It never treats the hinted revision as state or as a target.

Suggested wording for `m11b.md` item 6 and the README:

> Hints are issued after the transaction commits and the acknowledgment is handed to the native send. Network order between a hint and the output-gated acknowledgment is not guaranteed, and a peer may see a hint first. Hints carry only a revision and trigger an authoritative snapshot read.

Also state the assumption: snapshot GETs are taken to be held by the same output gate. That's inferred, not measured; only the WebSocket side was measured.

Same class as the restore limit: if a write were lost after a hint, an observer that already has the higher revision keeps it and silently ignores the lower snapshot. Note it, don't block on it.

## Requirement-by-requirement

| # | Verdict | Basis / gap |
|---|---|---|
| Contract (receipts, capacity, persisted rejections, origin) | **Met** | Room code; `board.test.mjs` (real SQLite, fake transaction wrapper) covers capacity, conflict, terminal rejection and schema. Live runs cover conflicts, typed rejection, 400 for a bad room, cross-origin refusal. **Scope note:** the capacity bounds (100 items, 1,000 receipts) are tested only at unit level, which the requirement allows. |
| 1 Native build, patches recorded and reviewed | **Met** | `void@1.1.11.patch` (WebSocket send plus live registration) pinned in `pnpm-workspace.yaml`; the celld patch has a recorded SHA-256. Patch notes and reviews exist. No shim. |
| 2 Two apps, scoped upload; refused before approval; isolation | **Open (blocker)** | Convergence and isolation are covered (`board-protocol`, `sse-failure` isolation). The refusal needs a passing `approval.json` after fixes 1–3 above. |
| 3 Concurrency, duplicates, conflicts, dropped ack | **Met** | `board-protocol`, `browser` |
| 4 Owner and ingress kills, workerd, idle, move | **Met** | `process-failure` and `ingress` on stock celld, rerun on the candidate in `patched-runtime` (`processLoss`, `ingressLoss`); `idle`; `move` records the 1012 close |
| 5 Compatible v2 with open sockets; route pause; SSE max age | **Met with the opt-in candidate only** | `patched-runtime`, `route-pause` (new connections get 503 while the established socket gets a v2 ack), `sse-patched` update. Stock celld fails as a negative control (1011 close). This is a stated limit, not a gap. |
| 6 SSE | **Met after the wording fix** | `sse-patched`, `sse-failure`. Cancellation observed at max age 5 s, no latency claim. |
| 7 Stopped restore; lower revision | **Met, with limits** | `restore` covers lower revisions only; equal or higher divergent histories are not detected and must stay explicitly out of scope. The failure-path cleanup edits were not fault-injected, and the provenance note says so; that's acceptable because the success flow is what's claimed. Retirement sources unchanged since `d3c83c1`. |
| 8 Offline builds, docs, reproduction | **Evidence-hygiene gap** | `docs/evidence/m11b-offline-builds.json` was last updated at `b836783`, image `fogd-verify:m11b-ui`. Checklist source and patches last changed at `ba68363`, where the final builds appear only as a text line in `sse-failure.validation`. Refresh that file with the `ba68363` build image digest and commit, or point to the log. |

Also update `m11b.md` lines 3–6 and the line about the remaining audit near the end, which still say the audit is open.

## Closing the Docker live-session slice

Yes, it can close as a local Docker slice with the opt-in patched runtime (celld candidate plus pinned Void patches), once three things are done:
1. a passing approval run with the fixes above;
2. the item 6 wording correction;
3. the refreshed item 8 evidence.

The closing note should say:
- no stock celld 0.6.2 acceptance and no upstream acceptance claim;
- no latency, hint-delivery or hint-ordering guarantee;
- lower-revision rollback detection only;
- anonymous demo apps, no hostile-tenant claim.

General scheduled and workflow effects, remote infrastructure and the Cloudflare migration stay open roadmap work. None of the requirements makes them a condition of this slice.
