# Retire an app and reuse its fleet

Retirement creates a fresh Docker installation from a stopped snapshot. The retired
name becomes permanent history; a differently named app can use its freed fleet.
The other app keeps its data and native sessions. Plan whole-installation downtime
and enough disk for a full restore. Kubernetes retirement is not supported.

## Prepare and retire

Upgrade to a runtime with retirement support before taking the snapshot. The command
refuses older images. Record the retiring app's active deployment digest from
`fogd admin list`. An app may be active or paused, but needs a known active deployment
and reconciled migrations. Quarantined, uncertain, never-activated, and already-retired
apps are refused.

Use operator configuration for backup, without overriding its deploy token with a
teammate token. Keep the source stopped and perform no concurrent operator mutations.

```sh
FOGD_ENV_FILE=/path/to/installation.env pnpm exec fogd backup .fogd/before-retirement
pnpm exec fogd retire .fogd/before-retirement \
  --app notebook --digest ACTIVE_ARTIFACT_SHA256 \
  --project fogd-after-retirement --output .fogd/after-retirement
```

Both compose.json and restored.json must exist before starting. retirement.json
records the old and replacement fleet identities. These files are private.

```sh
docker compose -f .fogd/after-retirement/compose.json \
  -p fogd-after-retirement up -d --pull never
```

The generated Compose file is self-contained and pinned to snapshot images. Keep
using it for the recovered installation. Configure the CLI's server URL and admin
credentials for that installation; ordinary deploy/approval works as before. Issue
a credential scoped to the replacement app's different name and deploy it normally.

## What remains and what changes

The new fleet receives empty replica volumes, new node identities, and a disjoint
bucket prefix. Old prefix objects stay retained in the copied bucket. Original
source volumes, snapshots, secret revisions, artifacts, and approval history remain
private recovery material. Retirement does not erase data or reclaim artifact bytes.

A permanent tombstone blocks routing, submissions, approvals, rejection mutations,
secret changes, and new credentials for the retired name. Existing multi-app tokens
still work for their other scopes. Revoke obsolete tokens separately. The replacement
must use a different name and appropriately scoped authority.

Restoring an older backup can resurrect the app, credentials, and secrets that
existed at its snapshot boundary. Keep old installations stopped. This workflow
assumes trusted application code and an exclusive operator; it does not establish
hostile-tenant isolation through shared bucket credentials.

## Failure handling

A source with running containers or a live consumer of its volumes is refused.
Wrong digests, corrupt bundles, old runtime images, and occupied targets are refused.
Old-image refusal can leave a private output directory and loaded images, but creates
no target containers or start file.
The entire bundle is verified even though two replica archives are not extracted.

Failed attempts retain any compose.pending.json and stopped resources they created
for inspection. Do not start them with raw Docker commands. Automatic resumption is not
supported: choose a new project and output directory for another attempt. Neither
retirement nor restore deletes source data or partial targets.

## Reproduce qualification

Use a fresh disposable shared/TLS Docker installation whose project starts with
fogd-m10, and select its operator .env through FOGD_ENV_FILE. Supply the certificate
and the issuing CA used for that installation:

```sh
FOGD_ENV_FILE=/path/to/test.env NODE_EXTRA_CA_CERTS=/path/to/ca.pem \
  node scripts/retirement.mjs /path/to/server.pem
FOGD_ENV_FILE=/path/to/test.env NODE_EXTRA_CA_CERTS=/path/to/ca.pem \
  node scripts/retirement-negatives.mjs
```

The first script creates accounts and notebook, enrolls an account, writes D1/R2/DO
state, retires notebook, and deploys replacement into the empty fleet. The second
interrupts a private child process after the controller archive copy, verifies safe refusal and
fresh-target retry, and checks ordinary restore before returning to the retired
installation. It can also take an older complete Docker bundle as an argument to
check runtime-capability refusal. It retains all fixture volumes and snapshots.
