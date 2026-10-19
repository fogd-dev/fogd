Mostly yes, for the two apps retired in this drill. Both claims hold for `replacement` and `survivor`, but the docs overstate the result in two places. I checked the script, the private evidence, the logs and file timestamps.

## What holds up

**Claim 1: retained-prefix bytes match the stopped source**
- The source snapshot is taken after `backup()` has stopped the source and its bucket service. Only the bucket service is restarted (`retirement-complete.mjs:72`), and a one-off controller container hashes every object under the prefix. That supports "all app writers stopped".
- Both apps have 27 records, and the source and restored copies are compared object by object (`retirement-complete.mjs:81`).
- I recomputed the public `sortedObjectRecordsSha256` values from `complete.json`. They are SHA-256 of the record arrays serialized as compact JSON, and both match (`b95cca…`, `e4b67f…`).
- The resume recheck is real. The retry's `progress.json` holds the same replacement records as `complete.json`, and the image IDs match. The resume env file points at the `fogd-m11a-retired-replacement-1792437560590` installation, which the resume log also stops. A mismatch at line 55 would have thrown before any further step ran.
- The script was last edited at 15:20:09. The retry log was written at 15:19:36 and the resume log at 15:21:21, so the resume ran the current script.

**Claim 2: ordinary restore of an installation holding only retired apps**
- The backup carried no `queueRecovery` section, and the restore was the plain `restore()` path, not a retirement.
- The restored state includes `fogd-queue-retirement-v1`. All three apps are `route: retired` with no `delivery` or `queueRecovery`, the gateway returns 404 for each, and both retained prefixes hash-match after startup.

## False or overstated claims

1. **"Closes the two remaining retirement checks" (`docs/report.md`) and "the retained prefixes still matched".** The first retired app, `imports` (prefix `slots/slot-1`), never had a source-side comparison. The earlier evidence still lists "comparison begins after restored startup", and that applies to `imports`. The final check at line 103 only covers `replacement` and `survivor`, so `slots/slot-1` was never hashed in the zero-live install. Either say "the two apps retired in this drill" or add slot-1 to the final comparison.
2. **"Each of the two remaining apps had pending work when retired."** The script checks `backlogCount >= 1` but never checks that the backlog is the submitted `jobId`. The jobId is recorded and never used. There is indirect support: the input hash `2d162e…` for `retained\npending` appears in both prefixes. Either assert the job id is in the queue's pending set, or soften the wording to "had a non-empty backlog".

## Gaps that don't invalidate the claims

3. **The no-consumption check is only taken right at startup.** Both retained prefixes have `wake/entries/2026-10-23T…` keys, four days ahead. The hash match right after `ready()` shows nothing ran at boot. It does not show the retired backlog stays untouched when that wake fires. Add this to the evidence `limits`, next to the wall-clock retention note.
4. **"Starts correctly" is shown through the controller's admin API only.**
   - `ready()` counts apps over the admin API, and `controllerReady: true` is a hard-coded literal.
   - Nothing checks that containers are running and not restarting (`compose ps`).
   - The 404s show the gateway answers. They can't tell a deliberately retired route from a gateway that is up but not routing yet.
5. **Provenance of the replacement hashes.** The replacement snapshot came from the pre-edit script version, which isn't saved. The resume recheck covers this as long as the hashing code in `fingerprints()` didn't change. A note in `docs/notes.md` would cover it.
6. **The resume check is loose and leaves no record.**
   - Line 58 accepts any prior retirement entry with a matching name. It doesn't check that the entry's prefix equals the app's current slot prefix.
   - `complete.json` doesn't record that the recheck ran. Only the absence of an error shows it did.
7. **The script edits the fixture's compose file in place** (`retirement-complete.mjs:22-23`), pinning images by ID. That's fine for a disposable fixture, but the setup instructions in `docs/retirement.md` should mention it.
8. **The public evidence doesn't say how `sortedObjectRecordsSha256` is computed.** Name the serialization (sorted records, compact `JSON.stringify`) so someone with the private file can reproduce it.

Public admission stays closed in every changed doc, and the roadmap adds the never-approved queued-upload backup gap as next work. That part is consistent.