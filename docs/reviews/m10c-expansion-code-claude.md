Review of the uncommitted M10c expansion work. I read the proposal, the accepted amendments, and the earlier design review, then traced the diff plus the new compose and recovery modules. I also ran the 81-test suite and a live render check against this checkout's Docker.

## Verdict

**No correctness or security blocker for the live drill.** The four blockers from the design review are closed in code. The remaining findings are two behavior regressions in the `fogd up` and TLS guards that a default installation will not hit, plus hardening and qualification gaps.

## Verified against the accepted design

- **Source Compose is sole truth.** Rendering uses `--no-interpolate` output and clones the slot-2 definition. I rendered both counts against real Docker: the two-fleet template resolves identically to compose.yaml except for the inert `x-` extension keys, which the renderer strips. Three-fleet output passes topology validation, resolves slot-3 bucket, node, advertise, volume, network, and slot JSON correctly, and attaches minio, controller, and workerd to `fleet-3`.
- **Project name.** Derived volume and network names are cleared. A missing `COMPOSE_PROJECT_NAME` is refused by Compose with the configured message. Two different project names resolve to distinct volume and network names.
- **Controller archive preserved.** Expansion writes no state. The controller tar is restored and compared like every other source archive.
- **Volume sets.** Restoration and checks derive from the target config, so the two added volumes get the empty check and are skipped for extraction and comparison. Source writer checks derive from the source config, both before and after restoration.
- **Image set.** Added replicas copy the slot-2 pinned digests. `restoreInstallation` rejects any image not in the snapshot manifest.
- **Prefix and identities.** The new prefix is checked against both live prefixes and retained retirement tombstones with the shared overlap helper. Node identities carry the generation id and the existing distinctness check catches collisions. Both are tested.
- **Source mutation.** The plan deep-clones; the test asserts the source config, state, and image map are unchanged.
- **Fleet count guards.** `assertReplicaSelection` refuses both grow and shrink when existing containers or retained replica volumes show a different layout. Expand refuses anything but `--fleets 3`, render refuses counts other than 2 or 3, and the Kubernetes command's strict option parsing rejects `--fleets`.
- **Retirement regression.** Retirement still passes `kind: 'retirement'`, still gets the runtime capability probe and state write, and its receipt file name is unchanged. The layout relaxation to three fleets flows through retirement planning without count assumptions.
- **No credentials in render.** Render passes an empty env file, does not pass the operator env, and prints only the output path and default ceilings. The ceiling arithmetic matches compose.yaml defaults.

## Findings

1. **`fogd up` and TLS import now require the full backup topology, not just a stable fleet layout.** `packages/cli/src/platform.mjs:16` and `packages/cli/src/tls.mjs:14` call `validateTopology`, which refuses anything outside the recoverable shape. Two overrides compose.yaml explicitly offers now make `fogd up` fail: a non-MinIO `FOGD_BUCKET_ENDPOINT` ("External bucket backup is unsupported") and any `FOGD_SLOT_n_{A,B}_HOST` value other than the default ("ordered local fleet addresses"). The rendered three-fleet template even emits `FOGD_SLOT_3_A_HOST` and `FOGD_SLOT_3_B_HOST` placeholders that, if set, make the installation unstartable through the CLI. Neither override is documented for operators, so the drill is unaffected, but this is a behavior change the accepted design did not ask for. The selection guard only needs replica names. Recommendation: derive expected replicas from service names matching `slot-N-[ab]` and drop `validateTopology` from the start path, or state in the docs that `fogd up` now enforces the recoverable topology and remove the host placeholders from the template.

2. **New-volume emptiness is checked at the start of restoration, not at the end.** The proposal says "verify new volumes are empty before treating the restore as complete." `restoreVolumes` checks emptiness before any extraction. Nothing writes to the skipped volumes afterwards, and the final writer check would catch a running container, so this is safe. Either add a final emptiness pass for `skipped` volumes or soften the doc sentence.

3. **Image map shape is only partially guarded.** `restoreInstallation` checks image values are from the snapshot but not that the key set matches the target services. `restoredConfig` would then set an undefined image on any missing service and Compose would fail at `create` with an unhelpful error. One line comparing sorted keys against the target layout closes it. Low severity because `planExpansion` always builds the full map.

4. **Repeated Docker inspection on `fogd up --shared`.** `up` calls `installation` indirectly twice when TLS is on, once in the new guard and once in `checkInstalledTLS`. Harmless, just redundant.

## Qualification gaps unit tests do not cover

- The two-fleet equivalence and separate-name resolution checks exist only as my manual run today. Record them as drill evidence or add a Docker-gated test.
- `restoreInstallation` has no automated coverage for the expansion branch, including the image-subset refusal and the target-derived volume list. The drill is what proves those.
- Gate 4's byte-identical source check (volumes, bucket owner files, state) is still required by the amendments and has no code support. Capture before and after fingerprints of the source bundle directory during the drill.
- The amendments require the certificate to cover all three app names plus the replacement name. Nothing in code can verify that; confirm the SAN list before the TLS drill.

Tests: 81 passing on the full suite, 35 in the CLI package. Render equivalence verified against Docker in a temp directory that was removed afterward. No files in the repo were modified.