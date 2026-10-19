Review complete. Verdict first, then blockers, simplifications, and the invariant check.

## Verdict

The expansion direction is right: a stopped snapshot transformed into a fresh stopped target is exactly the shape retirement already uses, and the recovery code is already count-general except one gate line. The proposal over-builds the configuration side. A JavaScript generator, a generated `compose.yaml`, and an equivalence test are not needed. Compose can emit the unresolved template itself.

## Blockers

1. **The generator creates the second source of truth it tries to avoid.** Making `compose.yaml` a generated file means the generator becomes the source and the YAML becomes a build artifact guarded by a drift test. I verified on this checkout that Compose already produces what the proposal wants:

   ```sh
   docker compose --env-file /dev/null -f compose.yaml config --no-interpolate --format json
   ```

   Output keeps every `${VAR:-default}` and `${VAR:?...}` string verbatim, expands the YAML anchors, resolves the build context to an absolute checkout path, and preserves the `FOGD_SLOTS` literal unexpanded. I fed that JSON back to Compose as the input file with env overrides and interpolation worked at execution time. So `fogd docker render --fleets 3` reduces to: take that output, clone `slot-2-a`/`slot-2-b` into `slot-3-a`/`slot-3-b` with `SLOT_2`, `slot-2`, `fleet-2` tokens rewritten, append one slot object to the `FOGD_SLOTS` string on controller and workerd, add network `fleet-3` and attach minio, controller, workerd. The hand-written `compose.yaml` stays the only source. No generated default, no equivalence test. One wart to handle: `--no-interpolate` mangles the top-level `name` to `compose_project_name-fogd`, so delete `name` from the rendered file and keep relying on `COMPOSE_PROJECT_NAME`.

2. **`restoreInstallation` iterates source volumes, not target volumes.** At `packages/cli/src/recovery/restore.mjs:22` the volume list comes from the bundle config. For expansion the target has two extra volumes. As written, the empty-volume check in `volumes.mjs` and both `stopped()` calls would skip `slot-3-a`/`slot-3-b`, so the "verify new volumes are empty" promise is not met by reuse alone. Fix is small: derive volumes from the target config and pass the added replicas as `skipped`, which is the path retirement already takes.

3. **`restoredConfig` indexes images by service name.** At `bundle.mjs:40`, `service.image = images[name]` gives `undefined` for `slot-3-a`/`slot-3-b` because the manifest only lists source services. The expansion plan must extend the images map with the template fleet's pinned image before calling it. Without that, `docker compose create` fails or pulls, and the "same pinned runtime image" claim is false.

4. **New prefix must be disjoint from retired prefixes, not just live slots.** The controller refuses to start if a configured prefix overlaps a retired one (`packages/platform/src/retirement.mjs:13`). Retirement planning already checks this against `state.apps[*].retirement.previous.prefix` using the shared `overlap` helper. Expansion must read `controller.tar` state the same way `retire.mjs` does and run the same check. The proposal says "fresh disjoint bucket prefix" without naming this set.

## Concrete simplifications

- **Model `fogd expand` on `planRetirement`, not on a new subsystem.** `retirement-plan.mjs` is 28 lines: clone config, rewrite replica env, rewrite `FOGD_SLOTS`, hand a `{config, skipped, evidence}` plan to `restoreInstallation`. Expansion is the same shape with append instead of replace. Target size is a 30 to 40 line `expansion-plan.mjs` plus a CLI arm. Everything in the proposal's expansion section that reads like a new design is already an invariant of `restoreInstallation`: fresh project refusal, pending file rename, stopped source check, empty-volume check, archive comparison, interrupted targets never reused.

- **Drop the fresh three-fleet template for qualification gate 2.** A fresh two-fleet install, backed up immediately and expanded, is a fresh three-fleet installation with zero apps. That satisfies gate 2 without a render command at all. Keep `fogd docker render` only if operators need a rebuildable three-fleet file for image upgrades, which is a real gap (see below), but it is a separate slice from expansion.

- **The two-fleet gate is one line.** `layout.mjs:12` is the only place that hard-codes the count. `validateNetworks`, `validateMounts`, `validateFleetStorage`, `serviceNames`, and `volumeNames` already derive from the slot list. Change the check to accept two or three and the whole recovery stack follows. Kubernetes keeps its own `[1, 2]` literal in `kubernetes/config.mjs:23` and needs nothing.

- **Shrink refusal needs no code.** Reversal is "discard the target, `docker compose start` the untouched source". State that explicitly in the guide as the rollback procedure and drop the shrink discussion.

## Unresolved template versus frozen config

The proposal is right that the resolved bundle `compose.json` and a rendered template serve different purposes and must not be confused. The rendered template participates in bootstrap, `.env` credential generation, and TLS import because interpolation happens at run time. The expanded target is a frozen, credential-embedded, image-pinned file like every restore output. Two consequences worth stating in the doc:

- An expanded installation has no `build` section, so `fogd up --build` cannot upgrade its images. This is a pre-existing gap for all restored installations. The tls-upgrade script shows the current escape hatch: extract settings from the bundle config back into an env file and return to `compose.yaml`. For three fleets that return path needs the rendered template, which is the one real argument for keeping `render`.
- `tls.mjs:12` and `backup.mjs:13` call `compose config` without `--project-directory`, unlike `local.mjs:34`. With an absolute build context in the rendered file this is harmless, which is why the absolute context matters.

## Recovery invariants that hold as proposed

- Controller startup treats a never-owned slot as available (`controller.mjs:44-58`), so the third slot admits an app with no quarantine.
- Gateway backends derive from `FOGD_SLOTS` with no count assumption (`runtime/src/serve.mjs:18`).
- Shutdown ordering in backup derives replicas from layout, so a three-fleet backup stops all six replicas before the bucket.
- The manifest format, image inventory, and archive inventory are all derived from the validated layout, so a three-fleet bundle verifies with the existing `verifyBundle`.

## Qualification notes

- Gate 4 should also assert that the source project's volumes, bucket owner files, and `state.json` are byte-identical before and after expansion.
- TLS: the third app's hostname must be covered by the installed certificate. A wildcard cert covers it, a two-name SAN cert does not. Say which the drill uses.
- Add a negative test for an expansion whose chosen prefix collides with a retired prefix, since that is the failure the controller would otherwise surface only at start.