# Claude review: stopped board recovery

The plan is sound and the client code supports it. I found no blocking flaw, but several places could produce a false pass. Fold the items below into the runner before you qualify.

## What the code guarantees (checked)

- **Backup** (`backup.mjs:30-47`) stops workerd and the controller, then the replicas, then MinIO. It checks that no running container mounts the snapshot volumes, tars every volume read-only, and checks again after `image save`.
- **Restore**:
  - It refuses to reuse the source project name (`restore.mjs:31`) and refuses existing containers, volumes or networks (`requireFresh`).
  - It renames every volume and network to `${project}_*` (`bundle.mjs:48-49`) but keeps the ports.
  - Each volume must start empty, and is compared byte-for-byte with its tar after extraction (`volumes.mjs:14-16`).
  - It re-checks the bundle checksums on every restore. So the targetB restore also proves the bundle didn't change after targetA.
- **Writer** (`session.mjs:68-71`): it blocks only when `fresh && snapshot.revision < connectionFloor`. `connectionFloor` is set in `disconnected()` and in the constructor. When blocked, `receive`, `opened` and `flush` all do nothing, so pending entries stay in localStorage. `acceptRestored` lowers the stored watermark, re-runs `snapshot()` while `fresh` is still true, and flushes once.
- **Observer** (`observer.mjs:38`): `!observed && rev < floor`, where `floor = view.revision` at disconnect. `refresh` stops entirely once `restored` is set, and only `location.reload()` clears it (`watch.tsx:23`).
- **Receipts** (`board.mjs:27-40`): a replayed `opId` returns the *original* revision. If the payload changed, it returns `operation-conflict` and writes no receipt.

## False-pass risks to close

1. **The snapshot must come from a clean stop, not a crash.** `backup.mjs:37-38` only warns when a replica exits non-zero or is OOM-killed (for example, killed by SIGKILL when the stop timeout runs out). Assert from the manifest's `exits` that every non-workerd service exited with code 0 and `oomKilled=false`, and that no "Snapshot requires crash recovery" warning appeared. Otherwise you are qualifying crash recovery and calling it stopped recovery. Also assert the manifest has no `queueRecovery`.
2. **Baseline receipt replay can pass on item-ID idempotency alone.** "No new item" doesn't prove the receipt survived. Replay the same `opId` and payload with a probe client and require `ack.revision === 1`, not 2. Also send the same `opId` with a changed payload and require `operation-conflict`. Both probes leave state unchanged, so they're safe on targetA. Confirm the snapshot is still revision 1 afterwards.
3. **The writer's watermark must actually be 2 before you disconnect it.** If revision 2 is written by another client and never reaches the writer, the writer's floor stays at 1. Revision 1 on targetB is then not lower, nothing blocks, and pending edits flush on their own. Assert `localStorage['fogd-checklist:<room>:revision'] === '2'` on the writer page before you block it, and the pending key after you enqueue.
4. **routeWebSocket mechanics:**
   - The route only affects sockets created after it is installed. Install a passthrough route (`connectToServer`) before the first page load, then close the live routed socket to disconnect.
   - Count frames inside the route handler in both directions. Once you attach `onMessage` you must forward messages yourself, and `page.on('websocket')` is not a reliable counter for routed sockets.
   - A blocked attempt may look open and then closed to the page. That is harmless because `ready` stays false until a snapshot arrives. Still count frames during the blocked windows.
   - "Zero operation frames" only counts once the writer has received the revision 1 snapshot frame from targetB and you've waited a stated period after it. Show the counter works by having it record the single operation frame after Accept.
5. **The observer must reach targetB through a real reconnect.** Record that the EventSource `error` (and so `disconnected()`) fired while targetA was down, and that targetB accepted the subscribe before the restored banner appeared. Record the banner without any page reload, as the plan says.
6. **"Commits once" needs a check after the fact.** Reload the writer and confirm 0 pending, revision 2 and two items. Replay the pending `opId` with the probe and require the ack to show revision 2. Confirm with a GET snapshot. The reloaded observer should then reach revision 2 through a hint, which also shows publication works after restore.

## Lower-revision semantics: the limit to state in the evidence

Detection compares revision numbers only, so it can't tell two histories apart when they share a number. If any other client takes the restored server to revision ≥ 2 before a stale client reconnects, then:
- the stale writer accepts that snapshot and flushes its pending edits on top of a different history;
- the stale observer shows it as Live.

Your test avoids this through ordering, and that's the right scope for item 7 ("explicit lower-revision error behavior"). But the evidence should say equal or higher revision divergence is undetected.

**A better trigger (follow-up, not needed to close item 7):** a revision hash chain, `h_n = H(h_{n-1}, opId, payload)`, stored with each receipt (at most 1,000 rows). Return `(revision, h)` in snapshots and acks, and have the client send its `(watermark, h)` on open. The server then reports `diverged` whenever its hash at that revision differs, whatever the revision numbers are. A room-local nonce won't work because restore copies storage verbatim. An installation incarnation ID stamped at restore would need platform plumbing; the hash chain stays entirely inside the app.

## Replication, mount and network safety

- Record `docker volume ls` for source, targetA and targetB with no overlapping names.
- Record `docker inspect` mounts per target container: only `${target}_*` volumes and no bind mounts.
- Record the target container networks: only `${target}_*` networks. That shows `S3_ENDPOINT=http://minio:9000` resolves to the target's own MinIO and not the source's.
- Record running image IDs equal to `manifest.images`.
- Check the target `compose.json` matches the source config except for name, volumes, networks, images and `pull_policy`.
- Leave targetA fully down before restoring targetB. The plan already does this, and it matters because `compose create` takes networks from the scarce pool.
- Use ephemeral browser contexts. When the source restarts at revision 1 on the same origin, a persisted profile holding watermark 2 would see a false "restore".

## Cleanup and partial failure

- `compose.pending.json` exists only between `writeJson` and the rename at `restore.mjs:53`. After that, the file is `compose.json`. If the failure was before `create` (image load, capability check), there may be no compose file at all.
- So: use `compose.pending.json`, otherwise `compose.json`, otherwise list resources by `label=com.docker.compose.project=<target>`. Run `down` without `-v` in every case.
- A retry needs a new project name, because `requireFresh` rejects partly created volumes.
- Restart the source with `up -d --no-build --pull never` (`--no-build` stops a missing image from triggering a rebuild) and check that `docker compose ps` shows only that project.

## Anything else needed to close item 7

- **The retirement sentence.** Item 7 also says "existing offline retirement contracts remain unchanged; changing a route alone is not a revocation mechanism". The plan doesn't cover it. A `git diff` of `packages/platform/src/{retirement,queue-retirement}.mjs` and `packages/cli/src/recovery/retire*.mjs` since the item began, plus one line in the evidence, is enough. No new test is needed.
- **The second approved app.** After the targetA restore, verify the other app's metadata, approval and room state are preserved and that it received nothing from the checklist room.
- **The equal-revision limit** from the section above, written into the evidence.

Beyond those, the plan as written plus the assertions above is enough to close item 7. The broader M11b audit stays separate.
