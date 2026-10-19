# Final expansion review — Claude

**Verdict: no blockers.** The code changes are correct and the earlier findings are fixed. The remaining items are about evidence quality: three test assertions are weaker than the PASS messages and docs that rely on them. Fix those before calling M10 complete. Everything else is optional.

## Prior fixes, confirmed in code
- **No recovery validator at startup.** `up` (`platform.mjs:14`) only runs `resolvedCompose` and `checkFleetSelection`, and it now passes `config` through to `checkInstalledTLS`, so the duplicate config inspection is gone.
- **Skipped volumes re-checked.** They get an emptiness check again after extraction and comparison (`volumes.mjs:16`).
- **Exact image key set.** `restoredConfig` now checks that the image keys match the target services exactly (`bundle.mjs:42`).
- **Order inside `restoreInstallation`** is right for expansion: target-derived volumes, a snapshot-only image subset, a source writer check after restore, and `expansion.json` written before `compose.json`/`restored.json`.
- **Runtime accepts three slots.** `platform/src/main.mjs:11-13` has no two-slot limit, and the `expansion-generations/<uuid>` prefix passes its regex. Older snapshot images don't need a capability probe for expansion.

## Findings

**1. `scripts/expansion.mjs` has never passed end to end (should fix).**
- The final gate-4 PASS line came from `.fogd/m10c-expansion-capacity-resume.mjs`, an untracked script that differs from the checked-in one. It issues a fresh `['fourth']` credential and never checks authority.
- The drill did check app, secret and credential equality before it failed (on the CA path at third-app submit).
- The token issued before expansion was never used after expansion. Both resume scripts issued new credentials. So "preserved scoped credentials" (`docs/recovery.md`) rests on metadata equality plus the byte-for-byte controller tar comparison, not on a live use of the token. That's defensible, but say so.
- `docs/notes.md` and `docs/recovery.md` are honest about the continuations.
- Cheapest fix: run the checked-in script once on fixtures, in the background alongside the fresh three-app work.

**2. Refusal checks match any failure (should fix).** `expansion.mjs:44` and `:73` use `assert.rejects(run(...), /exited/)`. `run` rejects with `"<cmd> exited N"` for any non-zero exit, so a CA-path error would also pass. The logs do show the right reasons ("Project still has running containers" and "Restore target project already has containers"), so today's evidence holds. A rerun could pass for the wrong reason. Use `exec` and match stderr, as `expansion-negatives.mjs:24` already does.

**3. The "identical" claim is stronger than `tar --compare` (should fix the wording).** `expansion.mjs:51` prints "every stopped source volume identical to the snapshot". `--compare` only checks entries that are in the archive, so files added to a source volume would go unnoticed. Either compare file lists or reword to "every archived file unchanged".

**4. `capacity-comparison.mjs` restarts the superseded expansion source.** Its two-fleet phase is `fogd-m10c-layout`, the expansion's source. Only one installation runs at a time, so nothing breaks. But `docs/recovery.md` says "Source … copies remained stopped", which is only true up to the paired run, and `fogd-m10c-layout` has now diverged from `fogd-m10c-expanded-source`. Add a sentence to the docs (optional).

**5. Capacity timing check is a race (optional).** `capacity-comparison.mjs:39` requires every sample's `startedAt` to be at or after the load report's `startedAt`. The `capacity.mjs` and `load.mjs` processes are spawned at the same moment, so if the metrics process samples first the check fails. Also, `errors === 0` doesn't require `requests > 0`. Phases always run two fleets then three, so ordering bias isn't controlled; one line in the docs covers it.

**6. "Middle fleet" is never asserted (optional).** `expansion-recovery.mjs` never checks that `replacement` is in slot-2. I read only the slot assignments from the snapshot's `state.json`: accounts/slot-1, replacement/slot-2, third/slot-3. So the claim is true, but a one-line `assert.equal(before.apps.replacement.slot, 'slot-2')` would back the PASS text.

**7. Readiness race in `expansion-recovery.mjs` (optional).** `ready()` polls only `accounts` and `third`, then `data(…,'replacement')` asserts 200 straight away. Add `replacement` to the poll.

**8. `recovery-fault.mjs` (optional).** The shim only matches if the restore command string stays the same as `volumes.mjs`; if it changes, the test fails by timeout rather than silently. The wrapper directory stays in `.fogd/`. Python 3 is an unstated requirement.

**9. Rendered host placeholders (optional).** The rendered template emits `FOGD_SLOT_3_{A,B}_HOST`. Setting either one later makes backup refuse with "ordered local fleet addresses". `compose.yaml` already has the same behaviour for slots 1 and 2, so it's not new; a short operator note in `docs/expansion.md` would cover it.

**Checked and fine:** `three-app-smoke.mjs` is sound (empty-apps precondition, 404 while pending, isolation read-back after all writes). It doesn't test fourth-app refusal or restarts, but the docs correctly credit those to the expansion drill. `expansion-negatives.mjs` is sound: interruption happens before `expansion.json` is written, the occupied-target refusal is matched on stderr, and the retry produced an expansion receipt.

I changed no files and ran no Docker mutations. I didn't print any `.env` contents, resolved configs or tokens; from controller state I read only app slot assignments.
