# fogd

Run Void apps on hardware you own. workerd routes requests; celld runs each app
with D1, R2, and Durable Objects; MinIO stores fleet state. Teammates submit builds
with `fogd deploy`, and an admin approves the exact artifact before it runs.

This local Docker prototype supports two apps with two celld replicas each. It is
for trusted, reviewed application code. Read [the report](docs/report.md) for tested
behavior, limitations, and the decisions behind it.

## Start from a clean checkout

Requirements: Docker with Compose, Node.js 24.21 or newer, and pnpm 10.16.1.
Dependencies stay in the workspace. No Cloudflare account, credentials, or API calls
are needed; nothing here publishes npm packages.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm exec fogd up
cd examples/hello
pnpm exec fogd deploy
```

`fogd up` builds the images and creates private admin, submitter, and gateway secrets
in the ignored `.env` file. The first build compiles a pinned MinIO source release
because its upstream images are unavailable. See [.env.example](.env.example) for
ports, bucket endpoints, replica addresses, and resource limits. `docker compose up
-d --build` also works once the three required secrets are configured.

Open **http://localhost:8788**, sign in as `admin` with `FOGD_ADMIN_PASSWORD` from
`.env`, inspect the artifact and migrations, and approve. Then:

```sh
curl -H 'Host: hello.localhost' http://127.0.0.1:8787/api/posts
```

The response is `[]`. Pending and rejected code does not run. Ports bind to loopback;
stop with `docker compose down` to preserve data. Do not delete volumes containing
data you want to keep.

## Milestone 1: compatibility and architecture

[Compatibility](docs/compat.md) maps the Void SDK and Platform to source-backed
workerd/celld support. [Architecture](docs/architecture.md) explains the runtime
boundary. [Decisions](docs/decisions.md) and [architecture review](docs/reviews/architecture-response.md)
record why complete apps stay in celld. No native binding objects cross HTTP.

## Milestone 2: Void starter and D1

`examples/hello` was generated with `npx void init`, selecting D1 and demo code.
The clean-checkout commands above build, submit, approve, and serve it. fogd maps
Vite output to celld's `no_bundle` config and generates workerd capnp service
bindings. See [build output](docs/build-output.md) for the single-module adjustment.

For low-level experiments without the approval controller, `compose.local.yaml`
preserves the original single-app topology. Use a separate Compose project and
port; it is an operator-only diagnostic path. The default stack always uses approval.

## Milestone 3: storage, Durable Objects, migrations, recovery

Deploy the second example and approve its digest in the admin page:

```sh
cd examples/notebook
pnpm exec fogd deploy
cd ../..
curl -H 'Host: notebook.localhost' -H 'Content-Type: application/json' \
  -X PUT http://127.0.0.1:8787/api/entries \
  -d '{"id":"first","title":"Hello","body":"Stored in R2"}'
curl -H 'Host: notebook.localhost' http://127.0.0.1:8787/api/entries
node scripts/recovery.mjs
```

The example stores metadata in D1, bodies in R2, and operation IDs in a Durable
Object. It includes two SQL migrations. Its writes are idempotent across repeated
operation IDs; they are not a transaction across the three bindings.

The recovery check force-stops both replicas in turn, verifies acknowledged data
on the survivor, writes between failures, waits for rejoin, and restarts workerd.
It defaults to `slot-2-a`/`slot-2-b`, assuming hello was approved first. Override
`FOGD_REPLICA_A` and `FOGD_REPLICA_B` if notebook occupies slot 1. Also configurable:
`FOGD_URL`, `FOGD_APP_HOST`. Replica identities, peer addresses, and log volumes must
stay together; [ADR 005](docs/decisions.md) explains why.

## Milestone 4: CLI

`fogd up` starts the stack. `fogd deploy [--name app]` builds with app-local Vite,
validates the supported binding subset, packages SQL and assets, and submits an
immutable digest. `fogd.json` supplies the app name and optional `buildOutput` and
`migrationsDir`; otherwise the package name supplies the app name.

From an external project, set `FOGD_HOME` to this checkout and invoke its
`packages/cli/bin/fogd.js` with Node. Teammates need only `FOGD_SERVER` and
`FOGD_DEPLOY_TOKEN`. Keep admin and bucket credentials out of teammate environments.
The CLI scrubs runtime credentials from its build child process. App builds execute
local project code, so a teammate must trust the project they build.

## Milestone 5: platform choice

[Platform design](docs/platform.md) compares four approaches and records the chosen
approval controller with fixed app fleets. Claude and Gemini reviewed it independently;
[the response](docs/reviews/platform-response.md) records accepted changes. This
avoids a Void Platform fork, a binding bridge, and a privileged Docker socket.

## Milestone 6: two apps and admin approvals

After approving both examples, `hello.localhost:8787` and `notebook.localhost:8787`
serve independently. The admin can also use the CLI:

```sh
pnpm exec fogd admin list
pnpm exec fogd admin approve <deployment-id> <sha256>
pnpm exec fogd admin reject <deployment-id> <sha256>
```

Approval pauses the app, runs migrations, publishes through celld, and verifies both
replica versions before routing resumes. Failures remain paused with a visible step
and error. Reapprove the same digest to retry, or submit a correction. Applied SQL
hashes and resource identities are immutable. There is no automatic schema rollback.

Run the end-to-end acceptance script on a **fresh stack** (before manually approving
apps). It submits both examples, rejects a deployment, verifies auth and digest
checks, approves both, tests D1/R2/DO, deliberately fails a SQL migration, recovers,
and restarts the controller and workerd:

```sh
node scripts/platform-smoke.mjs
pnpm check
pnpm test
pnpm build
```

CPU, memory, V8 heap, resident-cell, request-body, upload, and pending-request limits
are enforced where the runtimes support them. These are not per-request CPU quotas.
MinIO and the controller remain single points of failure. Public/homelab deployment
still needs TLS, private peer networking, scoped storage credentials, coordinated
backups, and an operator-provisioned slot on each host.
