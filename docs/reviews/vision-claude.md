# Claude vision and roadmap review

Review grounded in the frozen snapshots plus `docs/features.md`, `docs/report.md`, `docs/build-output.md`, and `docs/decisions.md`.

# Review: fogd vision and roadmap

**Verdict.** The vision is the right anchor and the layer table is the strongest piece of the set. The roadmap mostly serves it, but M7 is still too large to be the "smallest coherent next spec," three claims in the docs outrun the runtime split, and the admin-approval gate is quietly becoming part of the product definition when it should stay installation policy. Recommendation at the end.

## 1. Vision and distinction

The north star does distinguish fogd from a container host without making dependencies the purpose. The decisive sentence is in Boundaries: "If it only wraps container launches, that distinction has not been demonstrated." Keep it. The layer table correctly says celld and workerd inventories do not establish fogd support, which `features.md` also enforces.

Two gaps in preserving Void's benefits:

- **The layer table calls the second row "Void CLI and Platform experience."** Per `features.md`, Void Platform depends on Workers-for-Platforms dispatch namespaces, which neither runtime provides. fogd replaces Void Platform rather than hosting it. The vision should say so plainly, or G1 readers will expect Void's roles, OAuth approval, and usage pipeline to appear.
- **"Typed resource APIs and types carried into the UI" is named as the SDK contribution, yet no scenario or exit gate tests the typed client path end to end.** Report: assets are "accepted, no asset-heavy acceptance test." That is the one Void benefit fogd has not touched, so G1's evidence line is correct but currently has zero coverage.

## 2. G1 to G5 as a filter

They are concrete enough to reject most unrelated work, but G3 and G5 overlap enough that any binding can be smuggled in under G5 "expand capabilities." Suggested filter, four questions, all must be yes before a milestone slot:

1. Which scenario ID in `product.md` fails today without this?
2. What does a developer or operator stop doing by hand?
3. What failure drill or compatibility finding is the exit evidence?
4. Does the default Docker installation still pass the smoke test with this disabled?

Measurable signals without invented targets, all already recordable from existing scripts and logs:

- Manual steps per first deploy and per update of the supported starter, counted from the transcript.
- Number of author interventions when a second person runs install, upgrade, and recovery.
- Supported, partial, and rejected cells in `features.md` that are backed by a linked runtime test versus accepted config only.
- Recovery time and loss boundary from the M8 drill, recorded, not targeted.

## 3. M7 to M12 stress test

**Order and dependencies.** M8 before M9 is right. M10 is misordered. The report says resource declarations are "frozen on first approval" and `product.md` U3 calls that "a product blocker for normal app iteration." M7's exit demands "an update with backward-compatible migration," which is only the schema half of iteration. The first real pilot app will need a new bucket or variable within weeks. Pull additive resource change forward into M7 or an M7b, and leave retirement, slot reuse, and capacity refusal in M10.

**Size.** M7 as written bundles six things: rendered UI and assets, typed API, auth flow, compatible migration update, second-developer submit and observe, and failure diagnosis. That is a quarter of the whole product. The smallest coherent spec is:

> **M7a, "One complete Void app, twice."** Pick one Void starter with a rendered page, client assets, a typed route, and one D1 table. Deploy it, then deploy an update that adds a column and a second page. Exit: assets served and tested from a second machine, typed client compiles against the deployed API, migration applied once under crash injection, and the submitter sees status and failure reason without admin Basic auth.

Defer app authentication provider choice and second-identity work to M7b. Auth is the decision most likely to stall, and it is installation policy more than platform capability.

**Claims the current split and build output prevent.**

- **"Keep updating the app without separately managing its runtime and storage."** True only inside the frozen declaration set. Until additive resources land, this is a v0 overclaim in the vision's experience paragraph.
- **"Workers application contract" with "compatibility targets."** The build adapter disables worker code splitting, celld 0.6.2's collector drops Vite chunks, migrations are resolved outside the staged bundle, and `/__void/` must be blocked at ingress. Those are fogd-specific build contracts. The portability fixture in M7 should record them immediately as declared differences, otherwise M12's "without forking app logic" is already false at the build layer.
- **M9 "same application workflow works outside local Docker."** ADR 002 gives each app its own two-replica fleet and ADR 003 builds MinIO from source. Any second environment inherits a per-app fleet count and a single bucket. Say "same application contract" rather than "same workflow," because operator workflow will differ substantially.
- **M12 "non-Void Workers import."** Nothing in the adapter handles non-Void entrypoints, and service bindings and KV are rejected. Fine as a direction, but it should be labeled U10-conditional and not share a milestone number with offline managed-target builds, which are achievable sooner.

**Missing exit criteria.** M11 has no failure model stated for Durable Object alarms during route pause, even though the roadmap itself flags that pauses do not drain alarms. M8 should name all writers explicitly: controller metadata, MinIO, every replica log volume, and workerd config.

## 4. Capability versus pilot policy

Separate cleanly:

- **Platform capability:** immutable artifact identity, resource declaration lifecycle, routing, recovery, scoped credentials, status visibility.
- **Installation policy:** whether approval is required, who approves, shared token versus per-person identity, availability targets.

Tensions:

- **Admin approval versus personal installation.** G2 says "an individual can fill both roles," but the controller enforces submitter and admin separation with two credential sets. A solo operator approving their own digest is ceremony. Approval should be a policy setting with a documented direct-activate mode, not a product invariant. The roadmap response currently calls the direct path "an operator diagnostic path," which bakes the FilOz policy into the product.
- **Portability versus integrated experience.** Every fogd-only convenience, such as migration resolution outside the bundle, widens the gap M12 must close. The portability fixture is the right mitigation but must veto, not just record.
- **Future extensions versus G5.** Coherent as written, provided the admission rule holds.

## 5. Opportunities

The existing list is sound. Two critiques: "Better generated-app guidance" has no scenario ID and risks becoming a product of its own. "Native compute or AI services" should state up front that `features.md` marks Workers AI "No" at every self-hosted layer, so it is a new service, not a binding.

Three to add, with the third deferred:

1. **Local-first developer loop parity.** The supported starter should run under `void dev` and under a local fogd with the same declared resources. This directly serves G1 and is cheap to test. Admission: one starter, one diff of behavior.
2. **Reproducible installation as a documented, versioned artifact.** G2's "second person follows procedures" needs a pinned Compose and config bundle with an upgrade note per release. This is the cheapest path to M9 credibility and is mostly documentation discipline.
3. **Deferred: offsite recovery copy.** M8 requires "an independent copy outside the failed host." Define only the interface the backup produces, a directory of files with a manifest. Do not choose a destination. Filecoin stays untouched, per your direction.

## 6. Contradictions, costs, overclaims

- Vision says "receive a usable URL," but the report says no certificate or DNS provisioning and no public deployment exist. Usable from another machine needs TLS and DNS in M8 scope.
- Hidden operating cost: four celld containers plus MinIO plus controller plus workerd for two apps. Homelab pilots should record memory per app before M9 chooses a topology.
- Premature decision: Kubernetes named as M9 candidate before any homelab second host has been tried. The two-host homelab is cheaper and exercises the same identity and disk retention lessons from ADR 005.
- The roadmap says "start a portability fixture in M7" but no exit gate in M7 names it. Add it or it will slip.

**Recommendation.** Keep the vision text, add the Void Platform substitution sentence, and split M7 into the "one complete Void app, twice" spec above with additive resources included. Decide these three before writing it:

1. Is approval a product invariant or an installation policy with a direct-activate mode?
2. Which single Void starter and UI path is the supported fixture?
3. Does M7 require remote access from a second machine, which pulls TLS and DNS forward, or is localhost acceptable for one more milestone?
