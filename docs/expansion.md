# Run three apps on Docker

Render a three-fleet installation for a fresh deployment, or expand a stopped
two-fleet snapshot into fresh resources. Each app retains its own two-replica
celld fleet. Kubernetes remains limited to the experimental two-fleet configuration.
Changing the rendered `FOGD_SLOT_N_A_HOST`/`FOGD_SLOT_N_B_HOST` defaults places
the installation outside the qualified local backup layout.

## Start a fresh installation

Set an explicit project name and render the Compose template from the checkout:

```sh
export COMPOSE_PROJECT_NAME=fogd-team
export FOGD_ENV_FILE="$PWD/.fogd/team.env"
pnpm exec fogd docker render .fogd/team-compose --fleets 3
export FOGD_COMPOSE_FILE="$PWD/.fogd/team-compose/compose.json"
pnpm exec fogd up
```

The local profile generates private credentials. For team access, use the
[shared installation guide](shared-installation.md) to configure TLS and scoped
credentials, import the certificate through the same template, and start with
`fogd up --shared`. The certificate must cover every app hostname, including future
replacement names. Rendering does not obtain a certificate.

The template preserves environment substitutions and uses the checkout's absolute
build context. It does not embed operator credentials. `compose.yaml` remains the
source definition; the renderer adds the third fleet from its replica settings.
Keep the selected project, environment file, and Compose path for later commands.
An existing output directory is refused.

## Expand an existing installation

Start from a two-fleet installation with saved controller metadata, such as an
installation with deployed apps. Select its environment and Compose file before
capturing it. Follow the [backup guide](recovery.md) for prerequisites and storage
requirements.

```sh
pnpm exec fogd backup .fogd/team-before-expansion
pnpm exec fogd expand .fogd/team-before-expansion --fleets 3 \
  --project fogd-team-expanded --output .fogd/team-expanded
```

Both installations remain stopped. Existing data, app assignments, credentials,
secret revisions, and replica identities are preserved in the target. The new
fleet receives distinct identities, an unused storage prefix, and empty replica
volumes. Expansion retains the original bundle and source volumes.

Require both `compose.json` and `restored.json` in the output directory before
starting the target. `expansion.json` records the added fleet and source manifest
fingerprint. The resolved Compose file contains credentials and pinned image
identities; keep the whole directory private.

```sh
export COMPOSE_PROJECT_NAME=fogd-team-expanded
export FOGD_COMPOSE_FILE="$PWD/.fogd/team-expanded/compose.json"
pnpm exec fogd up
pnpm exec fogd admin capacity
```

Use `fogd up --shared` when the selected environment uses the shared profile.
Keep these project and Compose selections in the operator's installation
environment for later commands. Existing apps retain their URLs; a teammate can
submit a third app with a scoped credential, and an admin approves its exact digest.

## Failure and recovery behavior

A running source, occupied target, invalid count, missing controller metadata, or
inconsistent layout causes refusal. An interrupted target cannot be reused; select
a fresh project and output directory. Partial output is not a completed restore.
Up and TLS import reject fleet-count changes when an existing project's containers
or retained replica volumes reveal a different layout. Direct Docker administration
can bypass that CLI guard.

Shrinking to two fleets is unsupported. To abandon an expansion before accepting
new writes, stop the target and restart the untouched source. Once target apps have
accepted writes, the source snapshot is stale: restarting it loses those later
changes from the served installation. Back up the active installation before making
another transition.

Three-fleet [backup/restore](recovery.md) and [retirement](retirement.md) use the same
layout checks. Retiring the middle fleet preserves both other fleets and permits a
different app name to use the freed capacity. Retired data and old recovery material
remain retained; retirement does not erase data or prune artifacts.

## Resource and upgrade boundaries

Default memory ceilings total 4608 MiB and CPU ceilings total 10 cores across the
nine long-running containers. These are ceilings, not reservations or requirements
that every app continuously consumes its allowance. Celld and MinIO environment
settings can change their limits. See the [measurement guide](capacity-measurement.md)
for observed workload costs and their limits.

Expansion and retirement copy the whole installation and require maintenance
downtime. Budget space for source volumes, target volumes, and snapshot archives.
Image archives are shared installation overhead; bucket data includes retained
namespaces and controller artifacts, so disk usage is not simply a fixed per-app fee.

Recovery output is image-pinned and has no build definitions. `fogd up` does
not rebuild those pinned images. A rendered template is buildable, but returning a recovered
installation to one requires preserving all private settings, fleet prefixes, and
node identities. There is no automated expanded-installation image-upgrade command;
do not substitute default identities for those in the recovery configuration.

## Reproduce qualification

`node scripts/compose-render.mjs` checks unresolved rendering, two-fleet equivalence,
three-fleet topology, resource-name isolation, and refusal to overwrite output.
`pnpm test` covers layout and transformation refusals without Docker.

On a disposable two-app shared fixture containing `accounts` and `replacement`,
with the notebook data fixture from the retirement drill, run:

```sh
export NODE_EXTRA_CA_CERTS=/absolute/path/to/installation-ca.pem
node scripts/expansion.mjs fogd-m10-expanded CERTIFICATE_PEM PRIVATE_KEY_PEM
```

Select the expanded project's environment and generated Compose file, then run:

```sh
node scripts/expansion-recovery.mjs fogd-m10-recovery CERTIFICATE_PEM
node scripts/expansion-negatives.mjs SOURCE_TWO_FLEET_BUNDLE fogd-m10-negative
```

These drills stop installations, create fresh resources, and preserve snapshots.
The recovery drill leaves a three-app installation with `accounts`, `third`, and
`fourth`; the middle app's former name is retired. The negative drill requires Python 3 for its Docker-command wrapper. It interrupts a
restore after copying controller state and verifies refusal to reuse the target.
The [implementation report](report.md) records completed runs and remaining gaps.

For a fresh three-fleet shared installation with no apps, select its environment
and Compose file and run `node scripts/three-app-smoke.mjs`. The disposable project
name must begin with `fogd-m10`; its certificate must cover `alpha`, `beta`, and
`gamma` app hostnames. This checks independently scoped submission, pending route
refusal, approval, migrations, and isolated D1/R2/DO writes for all three apps.
