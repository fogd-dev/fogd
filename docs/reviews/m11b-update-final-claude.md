**Verdict: approve the bounded slice. I found no blockers.** I read source only. I didn't delegate or change anything.

## What I checked

- **Patch mechanism.** It matches the Rust seam.
  - `op_ws_attachment_set` only writes to an existing `metadata` entry (`websocket.rs:750`).
  - `op_ws_accept` creates the entry with `attachment: None`, or keeps the existing one via `and_modify` (`websocket.rs:627`).
  - Flushing `_attachmentSc` right after `__ws_accept` is the minimal correct fix.
  - Encoding before the assignment keeps the last good bytes if a clone fails.
  - Writing again after accept is harmless, because the cache always holds the latest bytes.
- **Why idle eviction alone doesn't catch this.** `__socketFromRow` (`harness.js:~10708`) reuses the existing `__sockets` entry and keeps `_attachment` when `row.attachment == null`. That backs the claim in compat.md and ADR040 that idle eviction can hide the gap.
- **Fixture fidelity.** The modeled `__ws_accept` and `__ws_attachment_set` match the Rust behaviour: no write before an entry exists, and an existing entry is kept. On unpatched source, tests 1, 2 and 4 fail with `ERR_INVALID_ARG_TYPE`, because `deserialize(undefined)` throws. Test 3 passes. That matches "4 pass patched / 3 fail unpatched".
- **No false positive in live-update.**
  - The socket count and closes are asserted both before the flush and after the ack.
  - `ack.release === 'v2'` proves the new bundle handled the request.
  - v2 only changes `lib/release.mjs`.
  - `[room].ws.ts:28` still throws `Missing checklist room attachment`, which is where the 1011 comes from. There's no setState shim.
  - The negative record shows close 1011 and count 2 on the same unchanged app. Given that, a v2 ack on one socket means the bytes really came back in a fresh isolate.
- **Evidence files.** They exist and say what you described.
  - The idle-update run shows `count:1, closes:[]` and an evicted cell `slot-2-b`.
  - All five qualification stages print PASS.
  - The upstream test stage shows `running 0 tests` and clippy passing, which the docs disclose.
- **Build choice.** Upstream's own final image copies its binary from the `test` stage (`Dockerfile:46`), so `celld-patched.Dockerfile` copying `/out/celld` from the test target is consistent. The default still resolves to the pinned digest in both the compose default and the Dockerfile default.

## Optional fixes, most useful first

1. **Shared image tag (the real hazard).** `compose.yaml:11` tags every Docker install as `fogd-runtime:local`. Building a "disposable" patched install retags the image the user's other installs on the same Docker host use. Any path that runs without `--build` (recovery, restart) then silently runs the patched celld. Either add a line to the build note, or make the tag depend on the celld choice, e.g. `fogd-runtime:${FOGD_CELLD_TAG:-local}`.
2. **Binary provenance in the evidence.** Nothing in `update.json` or the `m11b-final-patched-*` records shows which celld binary ran. The negative-control logic covers live-update, but the failure, ingress and browser records only make sense alongside it. Add `sha256sum /usr/local/bin/celld` from one node, plus the `FOGD_CELLD_IMAGE` value, to each `probe.save`.
3. **Image provenance.** Add `LABEL` lines to `celld-patched.Dockerfile` with the source commit `90b4301` and the patch's sha256. ADR040 makes operators responsible for provenance, and the image could carry it.
4. **Scope wording.**
   - `configEnv` lets `process.env` override `.env` (`local.mjs:21`), so a stray shell export swaps the runtime. Worth one line in the docs.
   - `kubernetes-setup.mjs` builds its own runtime image and ignores `FOGD_CELLD_IMAGE`. The build note should say the option is for Docker installs only.
5. **Negative control.** There is one unpatched failure run. A second run, or a note that the failure is deterministic, would back the oracle claim.
6. **Formatting nit.** There's a double blank line before the new paragraph in `docs/compat.md`.

## Claims

- The build note says the regression "executes the actual upstream methods with a modeled host registry". That's accurate: `node:v8` stands in for `__sc_encode`, and the docs present it as a model, not the real encoder.
- ADR040 doesn't overclaim. M11b stays open, nothing is published, and lab profile is disclosed as not a release-performance claim.
- The close-1001 dispatch rejection and the deserialize-copy and attachment-size gaps are named as out of scope. That's appropriate.
