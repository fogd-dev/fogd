I can't fully check acceptance 4 locally. celld comes from the prebuilt `ghcr.io/denoland/celld:0.6.2` image, and there's no Rust source on this machine, so I couldn't read `evict_idle`. The parts that depend on it are flagged below. `.fogd/m11b-idle.log` is still 0 bytes, so I have no run output to check against.

## Verdict

The design is sound and can serve as evidence for the dedicated-fleet idle leg of acceptance 4, with one real gap: nothing proves that the 5-second setting caused the eviction. I found no false positive on the preserved socket, the restored attachment, or the "next edit applied once" claim. The narrowed scope string is accurate.

## What holds up

- **Proof of eviction comes before the edit.** The script waits until the new resident is gone from `/state` on both replicas before it sends the next operation, and then checks that it is resident again afterwards.
- **The attachment restore is actually tested.** In the pinned Void build, `ws-server.mjs` reads route params from `deserializeAttachment()`. If the attachment were lost, `ctx.params` would be `{}`, and `onMessage` throws `'Missing checklist room attachment'` (`examples/checklist/routes/rooms/[room].ws.ts`). Revision 2 can't be acknowledged without a restored attachment. This is the strongest part of the probe.
- **The socket really is preserved.** If celld or workerd closed the socket and the client quietly reconnected and retried, the final check (`count: 1, closes: []`, taken after revision 2) would fail. The `WebSocket` wrapper can't produce a false pass either: if Void bypassed it, the count would be 0 and the assertion would fail.
- **The edit was applied once.** Revision 2 with one item that is checked, read from the authoritative `onRequest` snapshot, shows exactly one application. A deduplicated retry wouldn't bump the revision.
- **Restoring the fixture is correct.** `finally` re-runs `up --force-recreate` with the original compose file and environment on the same replicas. The resolved JSON keeps the same project name and volumes. If `browser.launch` throws, it happens before any change, so there's nothing to restore.

## Blocker

**1. Nothing shows the eviction came from `CELLD_IDLE_EVICT_S=5`.** The poll waits up to 60 seconds, and the script never checks that the recreated containers actually received the variable. If the override isn't applied, or celld's default idle timeout is under 60 seconds (I couldn't check the default), the run still passes and claims "explicit five-second idle eviction." Simple fixes:
- After the `up`, check the running environment: `compose exec slot-1-a printenv CELLD_IDLE_EVICT_S` → `5`, or the value in `/state` if celld exposes it.
- Assert that `evictionObservedAt - idleAt` is under about 15 seconds, and save that delta.

## Improvements (not blockers)

2. **Room move isn't recorded.** Acceptance 4 says "Record whether a room move closes the socket." `restored` only checks `some(...)`. Save `restoredOwner` (the host that now has `owner.id`) and `moved: restoredOwner.host !== owner.host`. If it moved and no close was seen, that is the answer the doc asks for, for free.
3. **Saved evidence is hardcoded.** `socketCount: 1, closes: []` is written as literals. Save the values `page.evaluate` actually returned. Also save the `Date.now()` time of the revision 2 acknowledgment, to get edit latency after eviction.
4. **Possible secrets in the evidence folder.** `idle-compose.json` is the full resolved compose, which probably includes bucket and MinIO credentials, and it's written into the evidence output directory. It's mode 0600, but if that folder is ever copied into `docs/evidence/` the credentials go with it. Write it to `os.tmpdir()` instead, or delete it in `finally`.
5. **The resident snapshot can race the 5-second timer.** `active = await states()` runs after the acknowledgment through `docker compose exec`. If that's slow, the cell can be evicted first, and the run fails with the misleading "Run on an otherwise idle fixture" message. The likely outcome is a confusing failure, not a false pass. Taking the snapshot inside a short poll, or printing the residents in the message, makes such a failure readable.
6. **Ready check is shallow.** The readiness poll only checks that `/state` answers on 2 hosts. It doesn't check that the hosts are on the current deployment. The later "Connected · Revision 0" check covers this in practice, so it's fine.

## Out of scope, as you said

The script doesn't cover the finite idle observation on the ordinary fleet, non-owning ingress failure, or recording close codes when ingress is lost. The scope string honestly leaves those out.

## Can't check here

The probe assumes celld's `/state` `residents` means a cell actually loaded in memory and dropped by `evict_idle`, not just a lease or a placement entry. Check that against the celld 0.6.2 source before citing this as "real eviction." If `residents` is lease-based, an entry disappearing doesn't prove the in-memory state was torn down, and the claim of a restored attachment after eviction gets weaker. The `throw` in `onMessage` still proves the attachment was read.
