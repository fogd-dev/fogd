I found three blockers in `scripts/live-failure.mjs`. The rest is wording you should tighten. I made no edits or mutations.

## Blockers

1. **Nothing checks that the owner is actually dead when the survivor acknowledges the edit** (`:42–49`). `compose.yaml` sets `restart: unless-stopped` on these services. The script never checks container state between the SIGKILL and the acknowledged edit. If Docker restarts the killed container, the "survivor accepted the edit" claim could really be the restarted owner taking the room back. That fits the evidence: the first run took 10.8s, about the time of a lease handoff, so it can't tell the two cases apart.
   - **Fix:** before clicking Add item, assert that `compose ps --format json <target>` reports exited/not running. Record that state in the evidence.

2. **There is no proof the survivor took over the room.** `states()` uses `Promise.all` across both nodes, so it throws while one node is down. That means the script never reads the survivor's `/state`. The takeover is inferred from the ack and from the owner being down, which leans on blocker 1.
   - **Fix:** after the ack and before restarting the owner, fetch `/state` from the survivor alone. Assert that `owner.id` is in its `residents` and `published` lists. Save that.

3. **Reconnect times can't be worked out from the evidence.**
   - `start` (the kill time) isn't saved, so the `closeEvents`/`events` timestamps can't be lined up against the kill.
   - `elapsedMs` runs from kill to the acknowledged second edit, so it includes Playwright typing time and the wait at `:44`.
   - On the workerd leg, nothing ties a close/reconnect to the kill either.
   - Acceptance 4 asks for close codes and reconnect times, including lease/rebalance delay. The current fields don't support that.
   - **Fix:** per target, save `killAt`, the first close event after `killAt` (with its code), the time a socket opened and stayed open, and the ack time. Assert that at least one close event happened after `killAt` for each target. Without that, a workerd restart that never dropped the socket still prints "reconnects".

## Misleading claims and wording

- **`:44` passes on a stale label.** The page still says "Connected · Revision 1" before the browser notices the kill, so this wait can pass instantly. The comment admits this and the next mutation covers it. Either way, it isn't a reconnect measurement, so it shouldn't feed any timing claim.
- **`published` is local runtime state, not cluster-wide.** It's the owner node's own report of which cells it has running (`runtime.rs:615` keeps a `published: HashMap<String, CellHandle>` per node). That satisfies "identify ownership from runtime state". It is not lease or membership proof, so don't call it "published membership".
- **The owner diff is only safe by assertion** (`:35–36`). An unrelated cell that becomes resident while the test runs, with the room's own cell missing, would be silently picked as the owner.
   - **Fix:** if the cell ID can be derived from the room name, compute it and assert it equals `owner.id`.
   - **Otherwise:** at least assert the candidate shows up on exactly one host.
- **Owner kill may also be an ingress kill.** The script never records which node the browser's socket entered through. If that node is the owner, the leg is really owner+ingress loss. Record it, or note in the scope string that it's unknown.
- **The PASS line overstates the workerd leg** (`:61`). "workerd restart reconnects" is only shown by a later mutation succeeding (see blocker 3). Also, `context.json` records image digests for the celld nodes but not for workerd.
- **`:55` is redundant.** That item was already visible at `:49`. It doesn't show that state survived the owner restart, because the owner never serves the room again. Drop it, or replace it with a residency read after restart.
- **Scope strings disagree between runs.** The first run's evidence says "gateway/ingress loss … remain open". The current code says "non-owning ingress loss and idle eviction remain open". That's fine as long as the in-flight combined run uses the current string. Still out of scope as stated: browser disconnect, the idle runs, v2, SSE and restore.

## What holds up

- The fixture scoping works: the helper only accepts `fogd-m11` project names, the script narrows that to `fogd-m11b`, and the slot-2 handler budget is checked.
- The fresh room plus the final revision 3 / 3 items snapshot rules out duplicate application.
- Running each kill in `try/finally` with a restart is safe.
- The first run's evidence is consistent: 1006 closes about every 1s for roughly 10s, then the survivor acknowledges at revision 2.
