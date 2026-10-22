# Run your application cloud

Use this path to install the qualified local Docker runtime, give developers
deployment access, approve releases, diagnose applications, and recover a stopped
backup. fogd is **Cloudflare you can control and touch**: you operate the cloud;
developers use it to run their applications.

This guide uses the selected Linux arm64 two-fleet family and trusted application
code. Local Docker behavior is qualified; a second machine and other image stores
remain open. You provide Docker Compose, Node.js 24.21 or newer, certificates,
networking, disk capacity, and exclusive access during maintenance. The selected
path uses cached images and does not build or pull replacements.

## Prepare the operator program and private configuration

Start with a trusted checkout and its qualified cached images, or follow the
[offline installation guide](offline-installation.md) to import an authenticated
operator bundle. App developers need their own prepared Void/Vite dependencies;
the operator program does not install them.

Work inside that operator directory. Keep one persistent `FOGD_HOME` for the
installation and its recovery relationships:

```sh
export FOGD_HOME="$PWD"
export FOGD_ENV_FILE=/private/fogd/operator.env
cp -n .env.example "$FOGD_ENV_FILE"
chmod 600 "$FOGD_ENV_FILE"
```

Use an existing private parent directory and a new profile filename. Edit that
profile before enrollment: choose a unique `COMPOSE_PROJECT_NAME` (the examples
below use `my-cloud`), unused admin/app ports, the app domain and bind address,
and explicit private bucket credentials. Set `FOGD_PROFILE=shared`, `FOGD_TLS=1`,
and `FOGD_DEPLOY_TOKEN=`. The CLI generates missing admin and gateway credentials;
retain the profile and the private `.fogd` directory. Never adopt existing data by
choosing its volume names. [Shared configuration](shared-installation.md) describes
storage credential requirements and the deliberate maintenance needed for old
development credentials.

## Enroll and start

Enroll a fresh project using the explicit runtime family:

```sh
node packages/cli/bin/fogd.js up --shared --runtime celld-cron-v2-linux-arm64
```

The first call creates stopped services and reports the missing TLS keypair.
Import a certificate/key covering the admin endpoint and app names, then start the
enrolled project:

```sh
node packages/cli/bin/fogd.js tls import /private/server-chain.pem /private/server-key.pem --installation my-cloud
node packages/cli/bin/fogd.js up --installation my-cloud
```

Record the printed runtime family and installation identity digest separately from
future backups. Keep the matching operator program, private profile and certificate
material. For a private CA, set `NODE_EXTRA_CA_CERTS` before starting Node. Set
`FOGD_SERVER` to the certificate-valid admin endpoint, including its configured
port. Confirm the admin page is reachable before issuing developer access.

```sh
export NODE_EXTRA_CA_CERTS=/private/issuer-ca.pem
export FOGD_SERVER=https://admin.example.test:8788
```

Replace these example paths and endpoint with your installation's values.

### Choose private subnets when needed

If Docker cannot allocate bridge networks, select unused subnets without editing
Compose or changing daemon settings. Write a regular JSON file with exactly three
distinct private `10.x.x.0/24` subnets; these example addresses are placeholders
until you check your Docker networks, host routes, LAN and VPN:

```json
{
  "control": "10.253.180.0/24",
  "fleet-1": "10.253.181.0/24",
  "fleet-2": "10.253.182.0/24"
}
```

Pass it on the initial enrollment command:

```sh
node packages/cli/bin/fogd.js up --shared --runtime celld-cron-v2-linux-arm64 \
  --network-plan /private/fogd/networks.json
```

Fresh enrollment and selected recovery check declared subnets against Docker's existing IPv4 subnets before
reserving enrollment or creating installation resources. It does not inspect host
routes or reserve addresses against concurrent Docker changes. A later create
failure can leave a fenced partial installation: retain its state and resources,
and use a fresh project for another attempt. Never prune existing volumes to make
room for enrollment.

Placement becomes part of the installed policy. Repeating the same plan is
allowed; a different plan refuses instead of moving an existing installation.
Ordinary `up --installation my-cloud` uses the saved placement and takes no plan.
An explicit startup plan requires `--runtime`; default runtime admission is
unchanged. [Runtime selection](runtime-selection.md) describes the supported
family and recovery identity boundaries.

## Give a developer access and approve a release

Issue an app-scoped token and export the developer client:

```sh
node packages/cli/bin/fogd.js admin issue-token teammate my-app
node packages/cli/bin/fogd.js client export /private/fogd/new-developer-client
```

Give the developer that token, endpoint, CA certificate when needed, and the bundle
with its independently retained hashes. Follow the [developer client guide](developer-client.md)
for authentication and deployment. Operator and storage credentials stay with you.

The developer returns a submission ID and digest. Inspect its artifact, migrations
and declarations through the authenticated admin interface, then approve those
exact bytes:

```sh
node packages/cli/bin/fogd.js admin list
node packages/cli/bin/fogd.js admin approve SUBMISSION_ID SHA256
```

Applications requiring secrets also need an operator-supplied
[secret revision](m7c.md#secret-contract) in the approval command. A submitted
artifact remains inert until approval. The application URL uses
`https://APP.BASE_DOMAIN:APP_PORT`; DNS, certificate coverage and network access
must match your configuration. Approval pauses new HTTP routing during activation;
failed updates can leave the route paused. This is not a zero-downtime update path.

## Diagnose and retain

Start with recorded app state, then observe local native replicas separately:

```sh
node packages/cli/bin/fogd.js admin inspect my-app
node packages/cli/bin/fogd.js observe my-app --installation my-cloud
node packages/cli/bin/fogd.js admin capacity
```

[Inspection](application-inspection.md) connects releases, routing and held work.
[Observation](application-observation.md) reports native readiness and uncertainty;
it does not call an application's health endpoint. Developers use scoped
[`status`](submission-status.md). A healthy replica does not establish that the
application works, and controller loss currently interrupts gateway serving.
Check the application's own outcomes as well. Scoped application logs remain open.

Use [build retention](build-retention.md) to list, keep and review local build
copies before pruning. Controller artifact reclamation remains open; removing a
local copy does not free the controller's artifact quota or delete app data.

## Back up, restart, or recover

Take a private stopped backup before maintenance:

```sh
node packages/cli/bin/fogd.js backup /private/backups/new-snapshot --installation my-cloud
```

Backup stops the entire installation and leaves it stopped. It includes application
data, images, controller state, credentials and TLS keys; store it privately and
allow enough disk space. To resume the same installation after backup:

```sh
node packages/cli/bin/fogd.js up --installation my-cloud
```

To recover onto fresh storage, first keep the source and all related copies stopped
on every host. Retain the same `FOGD_HOME` and its recovery records. Select the
family and independently recorded source identity; choose unused recovery subnets
when needed:

```sh
node packages/cli/bin/fogd.js restore /private/backups/new-snapshot \
  --project my-cloud-recovered --output /private/fogd/new-recovery \
  --runtime celld-cron-v2-linux-arm64 --expected-identity RECORDED_SHA256 \
  --network-plan /private/fogd/recovery-networks.json
node packages/cli/bin/fogd.js up --installation my-cloud-recovered
```

The canonical recovered configuration lives under
`FOGD_HOME/.fogd/installations/my-cloud-recovered/`; `--output` contains a recovery
copy. Select the recovered project explicitly for later maintenance, even if the
profile still names the source:

```sh
node packages/cli/bin/fogd.js backup /private/backups/recovered-snapshot \
  --installation my-cloud-recovered
node packages/cli/bin/fogd.js tls import /private/new-chain.pem /private/new-key.pem \
  --installation my-cloud-recovered
node packages/cli/bin/fogd.js up --installation my-cloud-recovered
```

Certificate import requires a stopped installation; backup leaves it stopped.
Explicit maintenance reads the enrolled configuration and requires its retained
volumes. It refuses a missing enrollment instead of falling back to the profile's
project or template. Set `FOGD_SERVER` and client CA trust for the recovered endpoint;
background backup controls still use that endpoint.

Restore creates stopped services on fresh volumes with the original logical
identities; it is not a second active copy. Retain the original operator credentials
and TLS trust, and check the restored endpoint and saved app records. A snapshot
contains state only through its stopped recovery point. Older snapshots can also
restore old credentials and secret revisions. Queues and scheduled apps require
[recovery acknowledgment](runtime-selection.md#selected-recovery) and separate
resume; backup can leave background work paused even on the original installation.
Follow the [recovery guide](recovery.md) for those boundaries.

Runtime-family migration and cross-version restore are not qualified. Before
changing software, retain the matching program and a stopped backup; a new checkout
or image tag is not an upgrade procedure. Do not change the enrolled policy or
replace its pinned images manually. [Runtime selection](runtime-selection.md)
records the current same-family boundary; [offline transfer](offline-installation.md)
distributes software separately from data recovery.

The repeatable local workflow is
`node scripts/cron-probe/selected/operator-workflow.mjs .fogd/operator-native-NEW`.
It uses cached inputs, creates isolated projects, and retains every qualification
volume. It exercises commands and data recovery; it does not prove a fresh human
operator can complete setup unassisted or establish second-machine support.
