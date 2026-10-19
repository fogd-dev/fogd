# M10c fleet selection and expansion proposal

Status: proposed for peer review. The recovery foundation is committed; three
fleets are not yet qualified. This proposal extends the original M10c contract
and its review amendments.

## Operator outcome

Operators can start a three-fleet Docker installation and expand an existing
two-fleet installation through stopped backup and fresh restore. Each app still
owns a pair of celld replicas and a private network. Three simultaneous apps must
pass approval, persistent state, restart, recovery, and retirement qualification.
Kubernetes remains explicitly limited to its experimental two-fleet contract.

## One source of Compose configuration

Use a JavaScript Compose template generator for both two and three fleets. Keep
`compose.yaml` as a generated two-fleet default for direct `docker compose up`.
A test compares it against the generator so the definitions cannot drift. Compare
resolved two-fleet configurations against the previous checked-in YAML before
switching sources. Preserve all existing environment substitutions, defaults,
resource ceilings, mounts, entrypoints, and network membership.

`fogd docker render DIRECTORY --fleets 2|3` writes an unexpanded Compose JSON
template with the checkout build context, without reading or embedding credentials
or creating Docker resources. Existing environment selection, TLS import, and
`fogd up --shared` continue to resolve variables at execution time. Operators set
`FOGD_COMPOSE_FILE` to this generated file. Reject other counts and occupied output
paths. Show configured default resource ceilings and their environment overrides;
actual limits remain in the resolved configuration.

A Compose profile is the alternative: less generator code, but profile-aware slot
declarations and profile-aware inventory must remain consistent across up, TLS,
backup, and restore. An environment-provided slot JSON literal would give operators
another way to create inconsistent layouts. The generator avoids those two forms
of state. It costs a generated default file and its equivalence check.

## Expand from a stopped snapshot

Proposed command: `fogd expand BUNDLE --fleets 3 --project NEW --output DIRECTORY`.
Verify the existing two-fleet bundle before creating resources. Require the source
and any source-volume writers to be stopped. Refuse same-project, occupied targets,
unsupported counts, and three-to-two shrinkage. Keep the original bundle unchanged.

Clone one validated replica template into slot-3-a/b, with new node identities,
a fresh disjoint bucket prefix, a private network, and two empty replica volumes.
Append matching controller/gateway slot declarations and attach shared containers
to the added network. Preserve every original service, application, secret revision,
credential, replica identity, volume, and storage prefix except the shared network
and slot declarations that expansion requires. Existing app names and routes do
not change. Images remain pinned to the source snapshot; added replicas use the
same pinned runtime image as the template fleet.

Restore all existing archives with the established empty-volume, comparison, and
stopped-source checks. Verify new volumes are empty before treating the restore as
complete. Keep the target stopped and publish final Compose configuration only
after transformation succeeds. An interrupted target is never reused. The receipt
records the expansion separately from ordinary restoration and retirement.

This is a new-installation transformation, not a rolling resize. The operator pays
whole-installation downtime and temporary duplicated storage. Starting the target
is an explicit existing `fogd up`/Compose action. Refuse an accidental count change
against an existing project's containers; direct Docker administration can bypass
CLI checks and remains the operator's responsibility.

## Qualification

1. Prove generated two-fleet configuration equivalence and three-fleet structural
   consistency, with negative count, prefix, identity, and occupied-output tests.
2. Deploy three app names with scoped credentials and exact-digest approval. Check
   isolated D1/R2/DO state, a capacity refusal for a fourth app, one replica restart,
   and gateway restart.
3. Restore a complete three-fleet stopped snapshot into fresh resources. Verify all
   routes and existing records. Retire the middle fleet through another fresh
   restore; verify both survivors and a different-name replacement with empty state.
4. Expand a two-fleet stopped snapshot while preserving both apps; approve a third
   app and verify its new state does not inherit either previous fleet's data.
5. Compare two and three fleets with the same per-app paced read workload, recording
   cold/restarted and warm observation history, VM constraints, and shared overhead.
   Report restore/disk costs and limitations without claiming production density.

Keep M10 open until these gates have evidence. Do not weaken recovery or bypass
TLS to get the third app running.
