# Prepare and receive a fogd release

A release directory combines a versioned operator/runtime bundle and a standalone
developer client. The operator bundle contains the qualified runtime and storage
images, matching CLI code, its dependencies and operating guides. The client can
be distributed separately to developers without Docker or operator images.

Release verification requires Node.js 24.21.0 or later and an independently retained
manifest SHA256. Runtime import additionally requires a Linux arm64 Docker engine with the
classic `overlay2` image store, Docker Compose, `tar` and `sha256sum`. The selected
[runtime boundary](https://github.com/fogd-dev/fogd/blob/main/docs/operator-v8-acceptance.md) still applies. Application builders
provide their own Void/Vite dependencies; the release is not an application SDK.

The [empty-engine onboarding check](https://github.com/fogd-dev/fogd/blob/main/docs/evidence/operator-v8-versioned-pruned-recovery.json) uses
three virtual CPUs, 6 GiB RAM and a 16 GiB data disk. This is a tested fixture, not
a minimum-size or capacity guarantee. The artifact occupies about 924 MB before
import; Docker images, temporary verified copies and application data need
additional space. Container CPU budgets are not per-worker CPU quotas.

## Prepare the release

V8's matching source checkout is commit
`3638a46fa69ee47b1864aea6c45f40a52fb1d4d2`. Current `main` includes unreleased
archival runtime code and refuses v8 export because its source inventory differs.
Received v8 bundles retain their original sources and remain usable. The archival
family needs separate implementation and qualification before release preparation.

From the matching v8 checkout, with its qualified images and declared operator
dependency available:

```sh
node packages/cli/bin/fogd.js release export /releases/fogd-0.2.0-linux-arm64 \
  --version 0.2.0 --runtime celld-approval-v8-linux-arm64
```

Versions have three numeric components. The release version identifies this
assembled artifact, independently of the individual JavaScript package versions.
The command refuses candidates, existing output directories and destinations
inside public source directories. It starts no installation services. Failed
exports remain available for inspection; choose a fresh destination to retry.

Output reports the outer manifest and verifier SHA256 values, plus the nested
operator and client manifest digests. Retain the outer manifest and verifier
digests through a trusted channel. The complete directory contains:

- `manifest.json`: version, selected runtime, nested manifest digests and complete file fingerprints.
- `verify-release.mjs`: standalone verifier using Node built-ins.
- `operator/`: the existing immutable runtime transfer format.
- `client/`: the existing standalone developer client format.

Copy the whole directory to the recipient. Release preparation does not publish
to a registry, npm or a public download service. Publishing an artifact and its
independent integrity information is a separate release action. No public download
location is implied by the example path.

## Authenticate the received release

Use digests received independently from the trusted producer, not values read from
the received directory:

```sh
export RELEASE=/downloads/fogd-0.2.0-linux-arm64
export RELEASE_VERIFIER_SHA=INDEPENDENTLY_RETAINED_VERIFIER_SHA256
export RELEASE_MANIFEST_SHA=INDEPENDENTLY_RETAINED_MANIFEST_SHA256
printf '%s  %s\n' "$RELEASE_VERIFIER_SHA" "$RELEASE/verify-release.mjs" | sha256sum --check -
node "$RELEASE/verify-release.mjs" "$RELEASE" "$RELEASE_MANIFEST_SHA"
```

The verifier checks the complete outer inventory, both nested manifests and files,
the release version and the operator runtime identity without contacting Docker.
It refuses changed files, unexpected members and symlinks. It does not execute the
bundled CLI. These checks detect corruption relative to the trusted digests; they
do not establish publisher identity or protect against a hostile producer. Keep
the directory private and prevent concurrent modifications while verifying or
running its code.

The result includes `runtimeManifestSha256` and `clientManifestSha256`. After
verification, use the runtime digest with the existing import command:

```sh
export RUNTIME_MANIFEST_SHA=VERIFIED_RUNTIME_MANIFEST_SHA256
node "$RELEASE/operator/program/packages/cli/bin/fogd.js" runtime import "$RELEASE/operator" \
  --runtime celld-approval-v8-linux-arm64 --expected-manifest "$RUNTIME_MANIFEST_SHA" \
  --output /opt/new-fogd
```

Import verifies and loads the exact images and installs the matching operator. It
creates no application containers or storage identity. The receiving machine needs
no source checkout, package installation or private image seed. Allow space for
the release, a temporary verified image-archive copy and imported Docker images.

Follow [fresh enrollment](offline-installation.md#enroll-fresh-storage) for private
credentials, TLS import/trust, the app URL, scoped deployment and exact approval.
Use the [operator guide](operator-guide.md) for ordered stop/start and recovery.
Import does not adopt an existing installation or migrate another runtime family.

Developers can receive just `client/` together with its independently retained
manifest and verifier digests. Follow the [developer client guide](developer-client.md)
for verification, application dependencies and deployment. The client requires no
operator images or Docker to upload an already built supported application.
