# Start a shared installation with HTTPS

Use this procedure for a controlled installation running trusted apps. You need
Docker Compose, the checkout's dependencies, DNS for the app subdomains, and a PEM
server certificate/key valid for the admin hostname and each app hostname. The local
qualification uses a private CA; it does not establish a two-host deployment.

## Prepare and start

1. Copy `.env.example` to a private installation file inside `.fogd/`, set a unique
   `COMPOSE_PROJECT_NAME`, and retain the bucket credentials, replica identities,
   prefixes, and ports for that installation. Set `FOGD_BASE_DOMAIN` to the app domain.
   Choose `FOGD_BIND_ADDRESS` for the intended interface; its default is loopback.
   Set `FOGD_PROFILE=shared`, `FOGD_TLS=1`, and `FOGD_DEPLOY_TOKEN=`. Set a private bucket
   password before initial startup. Shared CLI startup and TLS import refuse missing
   storage credentials or the development password before writing generated settings.
   Keep this file mode 0600.
2. Select that installation and import the certificate while it is stopped:

   ```sh
   export FOGD_ENV_FILE="$PWD/.fogd/shared.env"
   pnpm exec fogd tls import /path/to/server-chain.pem /path/to/server-key.pem
   pnpm exec fogd up --shared
   ```

   Import builds the checkout's runtime image and recreates stopped containers using
   its Compose configuration. This is also a configuration upgrade; take a backup
   before using a newer checkout with an existing installation. Import never starts
   the containers. `up --shared` persists TLS/shared settings and clears the legacy
   installation-wide deploy credential. It generates missing admin/gateway secrets.
3. Trust the issuer in each client. For a private CA, set `NODE_EXTRA_CA_CERTS` before
   starting the Node CLI; use your organization's browser trust procedure for people.
   Set `FOGD_SERVER` to the certificate-valid HTTPS admin endpoint, including its port.

   ```sh
   export NODE_EXTRA_CA_CERTS=/path/to/issuer-ca.pem
   export FOGD_SERVER=https://admin.example.test:8788
   pnpm exec fogd admin issue-token teammate demo
   ```

   Give the teammate the returned scoped token and endpoint. Their CLI needs
   `FOGD_SERVER`, `FOGD_DEPLOY_TOKEN`, and private-CA trust if applicable; no cluster or
   admin credentials. Follow the [approval workflow](deploy-access.md). App URLs use
   `https://APP.BASE_DOMAIN:PORT`; port defaults to 8787.

`FOGD_ENV_FILE` selects the CLI's installation file; process environment values take
precedence. CLI Compose calls suppress implicit `.env` loading, so another checkout
configuration cannot supply missing settings. Direct `docker compose` calls do not
read `FOGD_ENV_FILE`; pass `--env-file "$FOGD_ENV_FILE"` explicitly.

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

## Rotate a certificate or upgrade from HTTP

Take a [stopped backup](recovery.md) before upgrading an existing installation.
Keep the same project name, credentials, replica IDs, prefixes, and volume names.
Use the new checkout's Compose configuration, stop the installation, import the new
certificate, then run `fogd up --shared`:

```sh
docker compose --env-file "$FOGD_ENV_FILE" stop
pnpm exec fogd tls import /path/to/new-chain.pem /path/to/new-key.pem
pnpm exec fogd up --shared
```

A pre-TLS restored configuration pins old images and has no TLS volume. Keep that
configuration as recovery evidence; switch to the current `compose.yaml` and an
installation file preserving its private settings before importing. Clear any old
`FOGD_CONTROLLER=controller:8082` override: gateway routing now uses the private
8083 listener. Recreate all replicas so they receive trusted-forwarding configuration.
Never remove volumes to perform this upgrade.

Expired certificates fail startup validation and can leave services restarting.
Stop the project explicitly before importing a replacement. Running processes retain
the loaded certificate until restart; fogd does not renew certificates or watch
expiry. Operators own issuance, renewal, DNS, network policy, and client trust.

## Reproduce local qualification

Generate an isolated seven-day test CA/server certificate with the host's existing
OpenSSL. No system trust-store changes are made:

```sh
node scripts/local-certificate.mjs .fogd/local-certificate
export NODE_EXTRA_CA_CERTS="$PWD/.fogd/local-certificate/ca.pem"
```

Use a fresh installation file/project with the settings above and default localhost
ports, import its `server.pem`/`server.key`, and start it. Then run:

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
