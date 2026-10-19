I found no blocker that makes the PASS wrong in the run you have. There are two places where the evidence is weaker than the script's own `scope` text claims, plus cleanup gaps. `.fogd/m11b-ingress.log` contains only the PASS line. I didn't find the evidence directory (it's `argv[2]`), so I haven't checked the recorded close codes or timings.

## Blockers for claiming acceptance 4 (non-owner leg)

**1. A socket closing after the SIGKILL doesn't prove the path went through the non-owner** (`live-ingress.mjs:64-66`). The comment says this close "proves the selected socket depended on the non-owner". That only holds if the owner never closes its own local sockets when a peer dies. If losing the peer makes celld on the owner drain, move or reactivate the room's cell, a socket connected directly to the owner also closes, and the test passes wrongly. The later checks don't rule this out:
- An unchanged owner `StartedAt` only proves the process didn't restart, not the cell.
- `residents.includes(owner.id)` (`:76`) would still be true if the cell left and came back on the same node.

The script records close codes but never asserts one. `peer_tunnel.rs:701-715` shows the tunnel sends close `1012 "owner unavailable"` when it sees EOF from the owner. Losing the ingress should instead look like workerd's backend dropping, probably 1006. Fix: assert the selected socket's close code (expected to differ from 1012 or any app-initiated code). Better still, add a control socket that is known to go directly to the owner and assert it stays open through the kill.

**2. The selected socket isn't tied to the new gateway** (`:50-55`). `selectedAt` is taken before `docker compose up`, and `.at(-1)` takes the last socket that got a snapshot. The script doesn't assert:
- that exactly one socket opened after the restart,
- that it opened after the new workerd's `StartedAt`,
- that it was still open at `killAt`.

Today a wrong pick fails rather than falsely passing, because `:66` requires that same socket to close after `killAt`. Add these asserts so a flaky run stops early with a clear cause.

## Not false positives (checked)
- `gateway.js:29`: `next++` happens only after the health and route early-returns. compose.yaml defines no workerd healthcheck, so nothing uses up index 0 before the client's reconnect. If some other request did get there first, the socket would go straight to the owner and `:66` would time out, which is a failure, not a pass.
- `serve.mjs:18`: binding `${slot}-0` is `nodes[0]`, so the reordered `FOGD_SLOTS` really does make the non-owner `slot-2-0`. The controller's `FOGD_SLOTS` is unchanged and only the slot id is used from it, so routing and `GATEWAY_TOKEN` authorization behave as normal.
- Ownership is read from runtime state just before the kill (`:56-59`: owner resident and published, non-owner not resident), as the spec requires.

## Cleanup and authorization bugs
1. **The `finally` block stops at the first error** (`:82-85`). If `browser.close()` or `compose start` throws, the gateway is never restored and `ingress-compose.json` is never removed. Run each step in its own try, or collect the steps and run them with `allSettled`.
2. **Ctrl-C or SIGTERM skips `finally` entirely.** Node's default signal handling just exits, so the gateway stays non-owner-first, the ingress stays dead, and the temp file is left behind. Add signal handlers, or at least print a manual recovery command.
3. **The temp compose file holds every resolved secret**, including `FOGD_GATEWAY_TOKEN` and the bucket credentials, inside the evidence directory. The file is created with mode 0600 and `wx`, and the directory is 0700, so this is acceptable only if (1) and (2) are fixed. Otherwise the secrets stay on disk next to evidence that may get shared.
4. **"Still down at acknowledgment" is only checked at one instant** (`:74`). The replicas use `restart: unless-stopped`, and `Running:false` alone doesn't show the container stayed down the whole time. Also assert that the ingress `StartedAt` and `RestartCount` are unchanged from the moment of the kill.
5. **Only the env order changes, but the script doesn't check that.** workerd is recreated from the resolved JSON (`resolvedCompose`), not the original file. It never compares `services.workerd` against the original apart from `FOGD_SLOTS`. Add that assert so the claim that normal gateway code is untouched is checked, not just assumed.
6. **Minor:** `compose start` on the killed ingress doesn't wait for it to be healthy, so a follow-on probe could race the restart.

## Evidence limits
- I read only the files you named, and only the close-related parts of `websocket.rs` and `peer_tunnel.rs`. I didn't trace whether a peer dying makes the owner close or move its local sockets. That is the open question behind blocker 1.
- I didn't verify the close code, the reconnect times, or the lease/rebalance delay that the spec asks to record.
