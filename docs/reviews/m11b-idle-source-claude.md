I found no blockers. The updated `scripts/live-idle.mjs` can serve as evidence for the five-second idle-eviction part of acceptance 4. The upstream source settles the question I couldn't check last time.

## What the upstream source says

- **The setting really caused the eviction.** `actor.rs:2497` reads `CELLD_IDLE_EVICT_S` with `env_vars::positive`, so leaving it unset gives `None`. `evict_idle` (`lib.rs:6104`) then returns straight away, so idle eviction is off by default. With the new `printenv` check (lines 26-29), an eviction can only come from the five-second setting. That clears last round's blocker.
- **`residents` means the cell is actually in memory.** `residents()` (`lib.rs:1061`) only lists cells in the `Resident` or `EnsuringDurability` phase, and `/state` publishes exactly that list (`actor.rs:4181`). It is not based on leases or placement. When a cell drops out of `residents`, it has left memory.
- **The cell stays on its host as `dormant`.** `evict_idle` calls `begin_eviction(&candidate, false, …)`, and `false` means "not a handoff". The phase is published as `"dormant"` (`lib.rs:336`). A cell is only given up under memory pressure (`shed_toward_floor`), even with the default `CELLD_PRESSURE_OWNERSHIP=release`. So `phases.dormant >= 1` is the right state to expect, and `moved` should come out `false`.
- **The socket is the hibernated kind.** Void calls `acceptWebSocket` (`ws-server.ts:338`), so a dormant cell with that socket is "hibernated" in the source's own definition (`is_hibernated`, `lib.rs:1795`). The scope claim is accurate.
- **15 seconds is a fair limit.** The load sample runs every second (`main.rs:3429`), and a finished stop re-enters `evict_idle`. Expect eviction about 6 seconds after last use, plus the durability check and the stop. `idleAt` is taken after the `states()` call, so the measured gap if anything comes out shorter than the real one, never longer. That can't produce a false pass.

## Earlier findings

| # | Status |
|---|---|
| 1. Eviction not tied to the setting | Fixed: `printenv` on both replicas, the source shows eviction is off by default, and the 15-second check |
| 2. Room move not recorded | Fixed: `restoredOwner` and `moved` are now saved |
| 3. Saved evidence was hardcoded literals | Fixed: `socketObservation` holds what was actually observed, and the ack time is saved |
| 4. Credentials in the output folder | Partly fixed (see A) |
| 5. Snapshot can race the 5-second timer | Still open, but it can only cause a confusing failure, not a false pass |

## Small issues left (none block)

- **A. The compose file can survive a failure.** `rm(file)` (line 76) only runs if `browser.close()`, the restore `up` and `healthy()` all succeed. If the restore fails, `idle-compose.json` (with any credentials) stays in `probe.output`. The `wx` flag on line 15 then makes the next run fail with `EEXIST`. The restore uses `probe.compose`, not `file`, so moving `await rm(file, { force: true })` to the top of `finally` fixes both.
- **B. `phases.dormant >= 1` counts the whole host, not this room.** A cell from `known` that went idle in the same window could also satisfy it. The source shows an idle eviction can only end in `dormant`, so this can't produce a false pass. It is just weaker evidence than it looks. A sharper check would compare the dormant count before and after: `dormant` after eviction greater than at `active`.
- **C. The 30-second ordinary observation only shows that nothing gets evicted.** Idle eviction is off by default, so this is a baseline: no idle eviction happens and the socket stays open. Line 80 checks the compose config, but a default set in the image itself (`ENV`) would get past that check. A `printenv` there that expects an empty result would match the check on the idle path. The saved `scope` string doesn't mention the ordinary observation. One clause like "ordinary leg: default policy has no idle eviction; socket held 30s" would make it explicit.
- **D. A simpler wait.** Line 88's `expect.poll` on the clock could just be `await page.waitForTimeout(30000)`.

## Verdict

Approve. Fixing A before citing the evidence takes one line. B and C are wording or strengthening, not correctness. `.fogd/m11b-idle.log` was empty when I last looked, so I still have no run output to check these claims against.
