**Verdict: qualified.** M11b closes as a bounded local Docker live-session slice on the opt-in celld candidate with the pinned Void patches. All three closure conditions from my first audit are met, and I found no new blocker. I only read files and checked Docker state; I ran no tests.

## Condition 1: approval evidence. Met.

`scripts/live-approval.mjs` hashes to `c3526e12…eb8e39`. That matches `.fogd/m11b-approval-reviewed-source.sha256` and the `probeSha256` in `docs/evidence/m11b-approval.json`. Apart from that hash field, the public evidence file is identical to the private `.fogd/m11b-approval-reviewed/approval.json`, and the log records PASS.

- **Raw upgrade:** a standards-compliant `Upgrade: websocket` request with the same Host and Origin asserts `{status:404, body:'Unknown app'}`. It also rejects if the socket upgrades unexpectedly. This is the check that rules out a 403 from the app itself.
- **Browser refusal:** Chromium sees an error and close code 1006, with no open or message events, and the Origin is asserted. After approval, the same URL gets exactly one 101 handshake, an ack at revision 1, a snapshot, and a durable GET at revision 1.
- **Wrong digest:** the probe asserts HTTP 400 with `Deployment/digest mismatch`. Status stays pending and storage prefixes are unchanged. You're right and my first review was wrong here: `controller.mjs:159` checks the request digest before the artifact guard at `:177` (`Stored artifact digest mismatch`) is reached. Nothing claims that corruption guard is exercised, which is correct.
- **Slot and submitter:** the probe asserts slot-1 and slot-2 after approval, so the empty-storage checks provably looked at the right prefixes. It also asserts `release.submitter === credential.id`.
- **Cleanup:** no `fogd-m11b-approval-*` containers remain. All seven source `fogd-m11b-sse-*` containers are up, and the `f01d5785` target volumes are kept as designed.

## Condition 2: requirement 6 wording. Met.

`docs/m11b.md` item 6 and `docs/m11b-acceptance.md` now say hints are issued after commit and the native-send handoff, with no guarantee on network arrival order. The acceptance doc also covers:
- snapshot GET output gating is inferred, not measured;
- the uninterrupted-observer limit;
- no hint-delivery guarantee.

No stale "after durable acknowledgment" wording remains in the README or docs.

## Condition 3: offline builds. Met, with one hygiene note.

`docs/evidence/m11b-offline-builds.json` records the command with `--network none`, image `sha256:19c144ad…`, source commit `fdb22fa`, and a log hash. The log hash matches `.fogd/m11b-acceptance-offline.log`. The log shows five apps going through typecheck, build and staging, and the five "Offline artifact staged" digests match the evidence file's `stagedDigests`.

The hygiene note: the verify image was built at 22:09Z, before `75b2caf` (22:19Z) changed `patches/` and `pnpm-lock.yaml`, and only `examples/checklist` is mounted in at run time. I compared the image contents with the repo:
- `void@1.1.11.patch` and `pnpm-lock.yaml` match byte for byte;
- the root `package.json` differs only in the `test` script, which doesn't affect builds;
- the other examples, `packages/` and `verify-builds.mjs` haven't changed since well before the image was built.

So the build inputs are effectively `fdb22fa`. Adding one line to the evidence saying so would be worth it, but it doesn't block closure.

## Closing scope

The status lines in `docs/m11b.md` (lines 3–6 and line 183) and the "remains open" line in `docs/m11b-acceptance.md` still say the audit is open. That's intentional pending this review; flip them on closure. The closing note should keep these exclusions:
- no stock celld 0.6.2 or upstream acceptance;
- no remote or hosted infrastructure, and no Cloudflare migration;
- no latency, hint-ordering or hint-delivery guarantee;
- lower-revision rollback detection only;
- anonymous fixtures, no hostile-tenant claim;
- general scheduled and Workflow effects remain separate.
