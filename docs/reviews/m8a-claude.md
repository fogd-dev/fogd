Reading is done. Here's the review.

**Verdict: the contract is sound in shape, but four points will lose data or produce an unrestorable bundle as written.** The celld-side facts that drive them: `docker stop` sends SIGTERM, which celld maps to `ShutdownMode::Handoff` (`.upstream/celld/crates/celld/main.rs:4872`). Handoff releases every ownership record so a peer takes the cells; it does not seal the node-log session. Acknowledged fleet-mode writes can live only on replica disks, and recovery of them needs the same node names and peer addresses (`docs/guarantees.md`, "Keep the node names, peer addresses, and data directories"). The supervisor delay of 15s already exceeds the 10s lease TTL, and `CELLD_SHUTDOWN_TOTAL_MS` 40s fits inside the 45s grace period.

## Blockers

1. **Sequential replica stop causes ownership churn into a node you are about to kill.** Stopping slot-1-a first hands its cells to slot-1-b, which restores them, bumps epochs, and then gets its own Handoff with no peer left. That lengthens the window and makes the "killed replica" case more likely for the second node. Stop all four replicas in one `docker compose stop slot-1-a slot-1-b slot-2-a slot-2-b` after ingress and controller. Draining peers refuse new ownership, so parallel stop is the clean path.

2. **"Resolve the actual Compose configuration" is ambiguous and can capture config that was never running.** `docker compose config` reads the current `.env` and compose file, not the running containers. If the operator edited `.env` after `fogd up`, the bundle records credentials, prefixes, or node IDs the volumes were never written under, and the restored controller will quarantine every slot. Gate: `docker inspect` each stopped container, compare Image, Cmd, and the FOGD_/CELLD_ env values against the resolved config, and refuse on mismatch.

3. **Image pinning by `fogd-runtime:local` is not a pin.** That tag is shared with the source project and is rewritten on every `fogd up` build. If the generated Compose file keeps `image: fogd-runtime:local` and the `build:` block, a later `up` rebuilds or silently picks a different image. `docker save` by ID also loads untagged. Direction: strip `build:`, `docker tag <id> fogd-<project>:runtime`, set `pull_policy: never`, and verify `docker image inspect --format '{{.Id}}'` equals the recorded ID before writing the receipt.

4. **Host ports collide.** The generated file inherits `127.0.0.1:8787` and `8788`. Restore and source cannot coexist, and the acceptance text requires continued writes on the restored install while the source may be restarted. Require `--http-port/--admin-port` on restore or emit `ports` from flags; refuse if unset.

## Data-loss and isolation hazards

- **Exit codes decide crash consistency, so record them.** After stop, read `State.ExitCode` per celld container. 0 is a completed handoff, 137 or 143 after the grace period is a kill. Store per-replica status in the manifest and print it; "report" is otherwise unverifiable.
- **Foreign mounts of project volumes.** "No project container running" misses an operator's ad-hoc `docker run -v fogd_bucket:/x`. Check `docker ps --filter volume=<name>` for every captured volume before copying.
- **Backup helpers must mount read-only.** Use `-v vol:/src:ro --rm` for the tar helper so a bug in the backup path cannot write to the source.
- **Second interpolation.** Only `docker compose config` output escapes `$` as `$$`. Any YAML you serialize yourself from parsed JSON will not. Use the config output verbatim, drop `name:`, and run the generated file with `--project-directory <output>` so no stray `.env` is loaded. Add a fixture secret containing `$HOME` and `${X}` to the round-trip test.
- **Compose label ownership of volumes.** Volumes created by raw `docker volume create` lack compose labels and trigger "not created by Compose" handling. Simpler: `docker compose -p NAME -f gen.yaml up --no-start` creates networks, volumes, and stopped containers with correct labels, then tar into the volumes, then write the receipt. The operator's explicit step becomes `docker compose start`.
- **Occupied-target check must cover unlabeled leftovers.** Filter by `com.docker.compose.project=NAME` for containers, volumes, and networks, and also by name prefix `NAME_`.
- **Shared-bucket rule is already enforced by topology.** Because backup refuses external buckets, source and restore can only share a bucket if MinIO data is bind-mounted, which is also refused. Say so instead of leaving it as an unstated invariant.

## Missing acceptance gates

- **Fleet-only writes survive.** Add the kill case to the restore test, not just the backup report: load writes, `kill -9` both replicas of a slot, backup, restore, assert every acknowledged write is readable and `nodes/<id>.json` log state reaches `sealed` on the restored fleet. Without this the RPO=0 claim after restore is untested.
- **No quarantine after restore.** Assert `state.json` has no `quarantined: true` and `fogd-owner.json` matches every app slot after controller init.
- **Post-restore byte verification.** Manifest should carry per-file digests, and restore must re-digest each volume before writing the receipt. A tar-level checksum only proves the archive was intact, not that extraction succeeded.
- **Config immunity to operator environment.** Run `docker compose -f gen.yaml config` with hostile shell vars set, such as `FOGD_BUCKET=other`, and assert identical output.
- **Coexistence.** Start restored while source is stopped, write, then start source; assert both serve independently and neither touches the other's volumes (`docker inspect` Mounts).
- **Interrupted backup** should leave no manifest, and `fogd restore` on it must refuse before any `docker` resource creation, which the current text implies but does not test for the "no effects" half.

## Implementation direction, reversible

Backup is a thin shell over existing primitives: `docker compose stop` in two steps, `docker inspect` gate, `docker save <ids>`, one tar helper per volume with `--numeric-owner -p`, a `sha256` list, then `manifest.json` written last via the same fsync-and-rename `saveJson` already in `packages/platform/src/store.mjs`. Restore is the mirror: verify, `docker load`, tag, `up --no-start`, tar in, re-digest, receipt. Every step creates only project-labeled resources under the new name, so rollback is `docker compose -p NAME down -v` plus deleting the output directory, and nothing touches the source.

Skipped: encryption, live snapshots, cross-version restore. Add when M8b or an offsite requirement arrives.
