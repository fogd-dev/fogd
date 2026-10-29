# Deploy with the standalone developer client

Use the developer bundle to submit a supported Void application to an existing
fogd installation without a fogd checkout or Docker. You need Node.js 24.21 or newer,
your application's existing Void/Vite dependencies, the controller endpoint, and a
deploy token issued by its operator. An operator must approve each exact artifact
before it runs. The client cannot install, administer, or approve applications.

## Get a bundle from the operator

The operator exports public client code and its cached JavaScript dependency:

```sh
node packages/cli/bin/fogd.js client export /absolute/path/to/new-client
```

The destination's parent must exist; export refuses an existing destination.
The bundle contains no runtime images, installation configuration, environment
files, credentials, or application state. No dependency installation, Docker
command, or registry access occurs during export or verification.

Transfer the entire directory. Retain the printed `manifestSha256` and
`bootstrapSha256` through a trusted channel separate from the bundle. Before
running any transferred JavaScript, check the verifier's bytes against that
independently retained bootstrap hash:

```sh
shasum -a 256 /absolute/path/to/client/verify-client.mjs
```

Only after the hashes match, verify all bundle members using the retained manifest
hash:

```sh
node /absolute/path/to/client/verify-client.mjs /absolute/path/to/client MANIFEST_SHA256
```

A verifier and manifest received together cannot establish trust by themselves.
Alternatively, an already trusted operator checkout can verify the bundle with
`fogd client verify DIRECTORY --expected-manifest SHA`. Corrupt, missing,
unexpected, and linked members refuse verification. Keep a verified bundle read-only
and under your control after verification; the launcher does not reauthenticate
its files on every invocation.

## Check JSON declarations without building

Run configuration preflight on an existing regular JSON file. For a previously
built app, use its generated configuration:

```sh
node /absolute/path/to/client/fogd.mjs doctor \
  --config /absolute/path/to/your-void-app/dist/ssr/wrangler.json \
  --name my-app --json
```

This offline check needs no credentials, Docker, build toolchain or client state
directory. It uses fogd's shared configuration translator and reports declaration
counts and the hash of the JSON it read. It never evaluates Vite, JavaScript,
TypeScript or JSONC configuration and never builds or submits an artifact. You can
check plain JSON declarations before building, but that cannot establish what a
plugin will generate. Existing generated JSON can also be stale.

With an explicit endpoint and scoped deploy token configured as described below,
add `--online` to query that controller's advertised capability for the named app:

```sh
node /absolute/path/to/client/fogd.mjs doctor \
  --config /absolute/path/to/your-void-app/dist/ssr/wrangler.json \
  --name my-app --online --json
```

Capability negotiation currently reports cron admission; the other declaration
checks use the local translator. Offline or failed negotiation leaves target
admission unverified. Native cron grammar, worker/asset/SQL files, changes against
the active release, private secret values and operating capacity remain unverified.
Online checking makes read-only requests and reserves no capacity. Deployment and
exact operator approval retain all authoritative checks.

Both output formats classify findings as `supported`, `unsupported` or
`unverified`. Exit code `1` means an observed condition is unsupported; code `2`
means compatibility remains unverified. Neither application-check scope reports
full application readiness or exit code `0`. Missing, unreadable, malformed,
linked or oversized configuration JSON produces an unverified file finding. Raw configuration
values and transport diagnostics stay out of reports. Omit `--json` for readable
text. The operator CLI accepts the same application-check arguments.

## Inspect an existing build before upload

Use project preflight when generated worker output already exists:

```sh
node /absolute/path/to/client/fogd.mjs doctor \
  --project /absolute/path/to/your-void-app --name my-app --json
```

This reads the existing `dist/ssr` output and `db/migrations`, honoring the same
`fogd.json` `buildOutput` and `migrationsDir` settings as deployment. It runs neither
Vite nor application code and never uploads. Missing output stays unverified;
the command does not build it automatically.

The `application-build` report uses the shared staging and server artifact
validators to check worker/module layout, assets, migration ordering and hashes,
canonical configuration and receiver limits. It reports the observed artifact
digest, file count, bytes and migration count. Its `configSha256` identifies the
canonical staged configuration; the configuration-only mode hashes its original
JSON input. Disposable private temporary staging is removed on completion;
project files and client build-cache state remain untouched.

Add `--online` to query the scoped target capabilities with a read-only GET.
The build can be stale relative to source files. JavaScript/Wasm execution, SQL
execution, active-release resource changes, private secret values and capacity
remain unverified. Deployment still rebuilds and validates, and exact approval
remains required.

Local Docker owners can also [compare a generated build with installation records](installation-preflight.md#compare-an-existing-build-with-installation-records)
using the operator program's `--against-installation PROJECT`. This requires local
installation access; it is separate from the standalone client's scoped HTTP
capability negotiation.

## Submit your application

Set the installation endpoint and your scoped deploy credential in your shell.
The operator supplies these values and the trusted certificate when required.
For a private certificate authority, set `NODE_EXTRA_CA_CERTS` before starting Node;
putting it in a client profile alone does not configure Node's TLS trust.

```sh
export FOGD_SERVER=https://fogd.example.test
export FOGD_DEPLOY_TOKEN=YOUR_SCOPED_TOKEN
# For a private CA:
export NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem

cd /absolute/path/to/your-void-app
node /absolute/path/to/client/fogd.mjs deploy --name my-app
node /absolute/path/to/client/fogd.mjs status SUBMISSION_ID
```

These are example endpoint and credential values; replace them with your
installation's values. You can instead put `FOGD_SERVER` and `FOGD_DEPLOY_TOKEN` in
a private file selected by `FOGD_ENV_FILE`. Process environment values take
precedence. The client requires an explicit endpoint and deploy token, even when
you also have operator credentials. [Submission status](submission-status.md)
describes the public fields and failure explanations available to that credential.

The application builds with its own installed toolchain and offline Void target.
Deploy credentials and the recognized operator, storage, and Cloudflare credential
environment variables are filtered from the build subprocess. This is a convenience
boundary for trusted application code; it does not sandbox build plugins or stop
them reading files accessible to your account. Application dependencies are a
separate prerequisite; the developer bundle does not install or contain them.

## Keep your local builds

The bundle can remain read-only. Local artifact copies and submission receipts go
under `FOGD_CLIENT_HOME`, defaulting to `$XDG_STATE_HOME/fogd-client` or
`~/.local/state/fogd-client`, with the cache inside `.fogd/build-cache` there.
Operator `FOGD_HOME` is ignored by this client. An optional default profile lives
at the client home's `.env`; `FOGD_ENV_FILE` selects another file. Help and status
do not create a state directory.

An interrupted upload can leave a build marked uncertain. Retain its files and
inspect the controller before resubmitting; upload failure does not prove the
server rejected the request. No build copies are pruned automatically. The
operator CLI's [build retention commands](build-retention.md) can inspect a client
cache when explicitly pointed at its home with `FOGD_HOME`.

The repeatable local scenario is
`node scripts/cron-probe/selected/client-bundle.mjs .fogd/client-native-NEW`.
It uses cached images and application dependencies, a fresh local project, and
private credentials; it retains all qualification volumes. Its scope is local
Linux arm64 Docker runtime behavior, not second-machine or hosted execution.
