# Transfer a qualified runtime without a registry

This path packages the existing qualified Linux arm64 runtime, its storage image,
and the matching operator CLI. It creates a fresh installation rather than copying
another installation's applications, credentials, or identity. Cross-machine
acceptance remains open until this procedure is exercised on another supported
Docker engine.

You need a trusted fogd checkout with its cached operator dependency and qualified
images to export. The receiving machine needs Node.js satisfying the bundled root
package's engine requirement, Linux arm64 Docker using the classic `overlay2` image store, Docker Compose, `tar`, and
`sha256sum`. Containerd image-store qualification remains open. App
builders keep their own declared Void/Vite dependencies; the operator bundle does
not install an application SDK. No registry access, dependency install, or image
build is performed by transfer commands.

## Export and authenticate the transfer

From the trusted source checkout:

```sh
node packages/cli/bin/fogd.js runtime export /path/to/transfer \
  --runtime celld-cron-v2-linux-arm64
```

The output reports manifest and bootstrap SHA256 values. Retain both independently
and transfer them through a trusted channel. Copy the complete directory to the receiving machine.
The directory contains `manifest.json`, `verify-transfer.mjs`, `images.tar`, and a
public `program` tree.
The program includes the [operator workflow](operator-guide.md) and the
[packaged operating guides](operator-package.md), authenticated by the same
manifest. Import retains these instructions under the new operator directory's
`docs/` folder. Older bundles can have a smaller documentation inventory.
The image archive has content IDs rather than mutable image tags. Failed exports
retain their incomplete directory; choose a new destination for another attempt.

First authenticate the standalone verifier with the receiving host's checksum tool.
It uses only Node built-ins and does not load bundled modules. Substitute the two
independently retained values below:

```sh
export RETAINED_BOOTSTRAP_SHA=RETAINED_BOOTSTRAP_SHA256
export RETAINED_MANIFEST_SHA=RETAINED_MANIFEST_SHA256
printf '%s  %s\n' "$RETAINED_BOOTSTRAP_SHA" /path/to/transfer/verify-transfer.mjs | sha256sum --check -
node /path/to/transfer/verify-transfer.mjs /path/to/transfer "$RETAINED_MANIFEST_SHA"
```

Only after both commands succeed, run the authenticated bundled CLI:

```sh
node /path/to/transfer/program/packages/cli/bin/fogd.js runtime import /path/to/transfer \
  --runtime celld-cron-v2-linux-arm64 --expected-manifest "$RETAINED_MANIFEST_SHA" \
  --output /path/to/new-fogd
```

The expected digests must come from the trusted exporter, not a file received beside
the bundle. These checks detect transfer corruption; they do not establish publisher
identity or protect against a hostile exporter. An existing trusted CLI can also run
`runtime verify` with the retained manifest digest, without contacting Docker.

Verification checks the complete inventory without contacting Docker. Import checks
the host and archive, loads the two images, verifies the qualified native programs,
and copies the operator CLI and unresolved Compose template into the fresh output.
It reads from a private verified snapshot during import; allow temporary disk space
for another copy beside the installation output directory. Keep the received bundle
and installation directory private and prevent concurrent changes while verifying or
running their code. It creates no application containers, networks, volumes, runtime policy, or storage
identity. Existing output directories refuse; keep partial outputs after failure.

Loaded images have no tags. Keep them until enrollment creates referencing
containers; pruning unused images between import and enrollment can remove them.
Import records the receiving engine's storage mode. Different Docker image stores
have different behavior and visible images; see
[Docker's image-store documentation](https://docs.docker.com/engine/storage/containerd/).
This command does not change daemon settings or qualify another storage mode.

## Enroll fresh storage

Inside the new directory, copy `.env.example` to a private operator file outside the
transfer directory, set its mode to 0600, and choose a unique Compose project name,
ports, app domain, and explicit private storage credentials. Set
`FOGD_PROFILE=shared`, `FOGD_TLS=1`, and `FOGD_DEPLOY_TOKEN=`. Retain that file and the
installation's private `.fogd` state. Do not point fresh enrollment at existing data.

```sh
cd /path/to/new-fogd
export FOGD_ENV_FILE=/private/operator.env
node packages/cli/bin/fogd.js up --shared --runtime celld-cron-v2-linux-arm64
```

If Docker needs explicit bridge placement, supply
[`--network-plan FILE`](operator-guide.md#choose-private-subnets-when-needed) on
this first call. Use unused subnets; the CLI refuses overlap with existing Docker
networks before enrollment writes. It does not check host routes or migrate an
installed network plan. The [operator guide](operator-guide.md) connects this
installation path with developer access, diagnosis and stopped recovery.

The first call creates stopped services and refuses the missing TLS keypair. Import
a certificate/key valid for the admin and app names, then start the enrolled project:

```sh
node packages/cli/bin/fogd.js tls import /private/server-chain.pem /private/server-key.pem --installation PROJECT
node packages/cli/bin/fogd.js up --installation PROJECT
```

Use the project name from your operator file in place of `PROJECT`.
Clients of a private CA need `NODE_EXTRA_CA_CERTS` pointing at the issuer. Set
`FOGD_SERVER` to the certificate-valid admin endpoint. Issue an app-scoped submitter
credential, then use the ordinary build/deploy and exact digest approval workflow:

```sh
node packages/cli/bin/fogd.js admin issue-token builder APP
```

The application author deploys from their prepared application project with
`FOGD_SERVER`, `FOGD_DEPLOY_TOKEN`, and CA trust. The operator approves the returned
ID and exact digest; applications declaring secrets also need an explicit secret
revision. Keep operator and storage credentials out of submitter environments.

This transfer is software distribution, not a data backup or an upgrade migration.
Back up retained application state separately. Existing shared installations using
development storage credentials need deliberate maintenance; import does not rotate
or repair them. The frozen runtime's existing topology, recovery, and approval
boundaries still apply.


## Candidate distribution evidence

The [candidate distribution drill](evidence/operator-candidate-transfer.json) covers
an authenticated bundle loaded into an empty, independent classic-overlay2 engine.
The received operator code runs outside the checkout, enrolls fresh HTTPS storage,
and exports a standalone developer client. Scoped deployments, pending-code
isolation, exact approval, fresh application data and retained restart pass.
Application authors still supply their prepared projects and SDK dependencies.

Maintainers use the [transfer module](../packages/cli/src/distribution/bundle.mjs)
with explicit internal selection of a known catalog candidate to run these checks
before promotion. The manifest and installed catalog retain candidate status;
ordinary `fogd runtime` commands and public enrollment still refuse the candidate.
No public candidate flag or image override is available. This evidence uses separate engines
on one physical machine and does not complete released-family or separate-machine
acceptance.

The [v5 proposed-release rehearsal](evidence/operator-v5-release-rehearsal.json)
uses the public commands with a private copy of the proposed catalog admission
change. Received operator/client deployment, an exact update, pending-code
isolation, restart, stopped backup and fresh recovery pass on another existing
engine on the same physical host. That rehearsal used a private catalog. The
[actual v5 admission check](operator-v5-acceptance.md) verifies the repository
catalog without modification through public transfer, received-client update,
restart, stopped backup and fresh recovery. Both checks use separate engines on
the same physical machine; separate-machine installation remains unqualified.
