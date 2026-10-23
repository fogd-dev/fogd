# Start a shared installation with HTTPS

Use this procedure for a controlled installation running trusted apps. The selected
path needs Node.js 24.21 or newer, Linux arm64 Docker with Compose, a matching
[operator package](offline-installation.md) or prepared checkout with qualified
cached images, DNS for app subdomains, and a PEM certificate/key covering the admin
and app hostnames. Local qualification uses a private CA and does not establish
operation on another machine. The [operator workflow](operator-guide.md) connects
setup with deployment, maintenance and recovery.

## Prepare and start

1. From the operator directory, set a persistent installation home and create a
   private profile in an existing private directory:

   ```sh
   export FOGD_HOME="$PWD"
   export FOGD_ENV_FILE=/private/fogd/shared.env
   cp -n .env.example "$FOGD_ENV_FILE"
   chmod 600 "$FOGD_ENV_FILE"
   ```

   Choose a fresh `COMPOSE_PROJECT_NAME` such as `my-cloud`, unused ports, and
   `FOGD_BASE_DOMAIN`. Set `FOGD_BIND_ADDRESS` for the intended interface; the
   default is loopback. Set `FOGD_PROFILE=shared`, `FOGD_TLS=1`, and
   `FOGD_DEPLOY_TOKEN=`. Supply explicit `FOGD_BUCKET_USER` and a private
   `FOGD_BUCKET_PASSWORD` before first startup. Never select existing data by
   reusing its volume names. Retain the profile and private `.fogd` state.
2. Enroll the qualified family on fresh storage:

   ```sh
   node packages/cli/bin/fogd.js up --shared --runtime celld-cron-v2-linux-arm64
   ```

   When needed, add `--network-plan FILE` using unused subnets in the
   [documented format](operator-guide.md#choose-private-subnets-when-needed).
   Enrollment uses cached verified images and creates stopped services. The first
   call reports the missing TLS keypair. Record the printed runtime family and
   installation identity digest independently, then import the keypair and start:

   ```sh
   node packages/cli/bin/fogd.js tls import /private/server-chain.pem /private/server-key.pem --installation my-cloud
   node packages/cli/bin/fogd.js up --installation my-cloud
   ```

   Use the actual project name from the profile. Shared bootstrap generates missing
   admin/gateway credentials and clears the installation-wide deployment token.
   Selected certificate import does not build or pull images. Later startup reads
   the saved enrollment rather than adopting changed profile credentials or images.
3. Trust the issuer in each client. For a private CA, set `NODE_EXTRA_CA_CERTS`
   before starting Node; use the organization's browser trust procedure for people.
   Set `FOGD_SERVER` to the certificate-valid HTTPS admin endpoint and port:

   ```sh
   export NODE_EXTRA_CA_CERTS=/private/issuer-ca.pem
   export FOGD_SERVER=https://admin.example.test:8788
   node packages/cli/bin/fogd.js admin issue-token teammate demo
   ```

   Give developers the endpoint, scoped token, client trust and an authenticated
   [developer bundle](developer-client.md). Keep operator and storage credentials
   private. Follow the [approval workflow](deploy-access.md). App URLs use
   `https://APP.BASE_DOMAIN:APP_PORT`; the app port defaults to 8787.

`FOGD_ENV_FILE` selects the private operator profile; process environment values
have precedence. CLI Compose calls suppress implicit `.env` loading. Direct Docker
commands bypass these CLI controls and do not read `FOGD_ENV_FILE` automatically.

## Existing development storage credentials

The CLI does not rotate storage credentials. A shared installation using the
example development password is refused by startup and TLS import; its environment
and stored data remain unchanged. This includes startup through
`fogd up --installation PROJECT`, which checks the installed configuration.

Keep the installation stopped and retain a private stopped backup and the original
configuration. Migrating an existing account requires a deliberate storage maintenance
procedure that updates the storage server and every consumer together. fogd does not
yet provide that procedure. Changing only `FOGD_BUCKET_PASSWORD` in an environment
file does not update every consumer or an enrolled installation's saved credentials.
Backups preserve the original credentials. Restoring such a backup does not bypass
the startup refusal; fogd has not qualified a maintenance procedure for restarting
it with changed credentials. Retain the original backup and configuration.
Use a fresh installation with explicit private credentials for new shared work.
Direct Docker commands bypass these host CLI checks.

## Rotate a certificate

For a planned rotation, take a [stopped backup](recovery.md) using a new private
destination. Backup leaves the installation stopped. Import a valid replacement
for the same hostnames and resume the same enrolled project:

```sh
node packages/cli/bin/fogd.js backup /private/backups/before-certificate --installation my-cloud
node packages/cli/bin/fogd.js tls import /private/new-chain.pem /private/new-key.pem --installation my-cloud
node packages/cli/bin/fogd.js up --installation my-cloud
```

Point clients at the intended endpoint and update issuer trust if the issuer
changed. Persistent background pause controls are separate: backup can leave work
paused and require explicit resume. Rotation interrupts serving; existing sockets
are not promised to survive.

Expired certificates fail startup validation and can leave services restarting.
Use `fogd stop --installation PROJECT` before importing a replacement; retain
existing backups and saved configuration. Running processes keep the certificate
loaded at startup. fogd does not renew certificates or watch expiry. Operators own
issuance, renewal, DNS, network access and client trust.

## Legacy checkout setup and HTTP upgrade

The older, unenrolled checkout workflow builds from its Compose template. With its
original private profile and the stack stopped, its commands are below. Existing
enrollment, orphaned project networks or an image tag resolving to a catalog image
can refuse legacy fallback. Keep resources stopped rather than removing policy or
enrollment records or retagging qualified images to force this path.

```sh
node packages/cli/bin/fogd.js tls import /private/server-chain.pem /private/server-key.pem
node packages/cli/bin/fogd.js up --shared
```

Unlike explicit enrolled import, this can build images and recreate stopped
containers from the checkout. Keep the original credentials, replica IDs, prefixes,
volume names and backup. A newer checkout is not a qualified selected-family upgrade.
Do not apply this path to an enrolled installation or remove volumes to upgrade it.

The bounded earlier HTTP-to-TLS drill uses an unenrolled snapshot with old images
and no TLS volume. It retains that snapshot, selects the newer checkout template,
removes an old `FOGD_CONTROLLER=controller:8082` override, and recreates replicas
with trusted-forwarding configuration. Its evidence does not authorize changing a
selected runtime's pinned image or launch configuration.

## Checkout-only legacy qualification

These scripts exercise the older checkout path and require its source, dependencies
and build inputs. They are not packaged operator commands or a selected-family
migration procedure.

Generate an isolated seven-day test CA/server certificate with the host's existing
OpenSSL. No system trust-store changes are made:

```sh
node scripts/local-certificate.mjs .fogd/local-certificate
export NODE_EXTRA_CA_CERTS="$PWD/.fogd/local-certificate/ca.pem"
```

Use a fresh, unenrolled checkout project/profile with the shared settings above
and default localhost ports. Import its `server.pem`/`server.key` using the legacy
commands, then start it. Then run:

```sh
node scripts/tls-smoke.mjs .fogd/local-certificate/server.pem
```

The drill deploys accounts, checks native Secure sessions and forwarded-header
rejection, then stops and restores the installation into a new project. To qualify
an upgrade from the earlier six-volume accounts/notebook snapshot, stop anything
occupying the default ports and run:

```sh
node scripts/tls-upgrade.mjs /path/to/m8a-backup fogd-m8b2-upgrade .fogd/local-certificate
```

The upgrade drill requires that snapshot's pending accounts release and default
service hostnames. It retains the source snapshot and verifies records, account
login, secrets, and pending approval after upgrading.

## Boundaries

Public app and admin traffic use native workerd/Node TLS. Private Docker traffic
remains HTTP. The public listener cannot serve gateway routing; the private listener
requires a gateway token. Trusted app code can reach private networks, so this is
not hostile-tenant isolation. The bind policy checks declared configuration, not
host firewall rules or manually changed Docker port publications. Forwarded client
addresses are discarded; applications do not receive an authenticated end-user IP.

The managed TLS volume contains the server chain and private key. Physical backups
include it and need private storage. They do not include an external CA issuer's
private key. One admin identity, manual renewal, and the two-slot capacity remain.
