# Claude review: stopped board recovery

I found no blockers in the code, but the reviewed run's evidence has a provenance problem (finding 1). The reviewed run hasn't finished: `.fogd/m11b-restore-reviewed` has only the baseline, the backup and the targetA restore log so far, with no `restore.json`. So this verdict covers the code plus the first run's evidence.

## Findings, most important first

1. **The reviewed run may not be running the current browser helper.** `live-restore-browser.mjs` was last changed at 18:55:32. The reviewed run wrote `context.json` at 18:55:06, after its modules had loaded, so it is running the earlier version of that file. `live-restore.mjs` (changed at 18:54:16) was loaded correctly. Before citing the reviewed run, either confirm with a diff that the 18:55:32 edit doesn't matter, or rerun.
2. **The first run doesn't prove the new assertions.** Its `restore.json` was produced by older code. It has no `conflict`, no `otherBaseline`, no network list, and no metadata comparison. It does prove the core flow:
   - The writer showed `Writes stopped · Revision 1 · 1 pending` with 0 frames sent while blocked.
   - The observer showed `Restored state detected · Revision 2`.
   - Exactly one retried frame went out, with the same pending ID, and its ack came back at revision 2.
   - The restored board has 2 items, and the targetA item "Acknowledged after the snapshot" is correctly absent.
   - Mounts in both targets use only fresh `<target>_*` volumes.

   Item 7 can only rest on the reviewed run, after finding 1 is settled.
3. **The retirement sentence in item 7 has no evidence.** "Existing offline retirement contracts remain unchanged; changing a route alone is not a revocation mechanism" isn't covered by the script or by `scope`. Add a `git diff` of the retirement and queue-retirement sources since item 7 began, plus one line in the evidence. Without it, item 7 isn't closed.

## Cleanup hazards (minor, none damage data)

- **Source restart ignores failed target cleanup** (`live-restore.mjs:98`). If a target `down` fails, the target still holds the ports. The source `up` then fails partway and leaves half-created source containers. Skip the source restart when `failures` is non-empty, and report "source left stopped".
- **Browser leak on startup failure.** If `restoreBrowser` throws before it returns (for example at `goto`), its Chromium process is never added to `browsers`. Only a process leaks.
- **Partial-restore assertion.** `cleanupTarget` treats "no compose files and no containers" as clean. Volumes from a partial restore remain, which is what you want. The failure record should name the project so a person can find them.

## Possible false passes (low risk)

- **Empty `manifest.exits` would pass** (`:55`). `every` on an empty array is true. Also assert `exits.length === Object.keys(probe.config.services).length`. In the first run, `workerd` exited with code 1, which the allowance covers.
- **Config check is partly circular** (`:27`). It compares the restored config against the same `restoredConfig` function that restore itself uses. The independent checks cover the gap:
  - fresh-volume disjointness (`:28-29`);
  - `inventory()`, which checks actual container image IDs and exact mounts and rejects bind mounts;
  - container networks matching the `<project>_` network names.
- **`seed.frames[0]` is assumed to be the operation** (`:48`). This is guarded indirectly by `receipt.revision === 1`, and the first run confirms it.

## Confirmed correct

- **Zero-frame check.** It counts all client frames, including ones dropped while blocked, and the single retry shows the counter works.
- **Reconnect proof.** It requires an EventSource error after targetA started stopping, and a targetB subscribe accepted after targetA stopped.
- **Reload proof.** The observer moves through `Live · 1` then `Live · 2` without a reload, so a hint was delivered after restore.
- **Duplicate check.** The pending operation is replayed and acks at revision 2, then the reload shows 0 pending.
- **Down without `-v` everywhere.** The source stays down until both targets are down.
- **No queue recovery, and browser contexts are ephemeral.**
- **Equal or higher revision divergence** is stated in `scope` as outside this detector.

## Item 7 verdict

Item 7 isn't met yet. It will be once the reviewed run passes with the current helper (finding 1) and the retirement-unchanged line is added (finding 3). The design is sound and the first run already shows the core behaviour.
