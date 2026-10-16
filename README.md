# fogd

Run Void apps on hardware you own: workerd handles ingress, celld runs each app
and its durable bindings, and MinIO stores fleet state. The local stack runs in
Docker. This is an experimental platform for trusted application code.

## Requirements

Use Docker with Compose, Node.js 24.21 or newer, and pnpm 10.16.1. Dependencies
install inside the workspace. No Cloudflare account or credentials are required.
Nothing in this repository publishes npm packages.

```sh
pnpm install --frozen-lockfile
pnpm test
```

Configuration defaults are in [.env.example](.env.example). Copy it to `.env` to
change ports, bucket settings, peer addresses, or resource limits. The HTTP port
binds to loopback by default. The first Docker build compiles a pinned MinIO source
release because upstream's published images are unavailable.

## Milestone 1: source audit and architecture

Read [compatibility](docs/compat.md), [architecture](docs/architecture.md), and
[decisions](docs/decisions.md). [Peer review](docs/reviews/architecture-response.md)
records the reviewed proposal and accepted corrections. No binding objects cross
between workerd and celld: complete apps run in celld.

## Milestone 2: Void starter with D1

The example was generated with `npx void init`. Build and stage it, then publish
through upstream celld inside Docker:

```sh
node scripts/build-app.mjs examples/hello
node scripts/stage.mjs examples/hello hello .fogd/hello-release
FOGD_ARTIFACT_DIR=./.fogd/hello-release docker compose run --build --rm deployer deploy /artifact --json
docker compose up -d --build
FOGD_ARTIFACT_DIR=./.fogd/hello-release docker compose run --rm deployer d1 migrations apply hello-db /artifact
curl -H 'Host: hello.localhost' http://127.0.0.1:8787/api/posts
```

Wait for both replicas to become healthy before applying migrations. The response
is an empty JSON array. Staging uses a new output directory so an existing release
cannot be overwritten accidentally. See [build artifacts](docs/build-output.md)
for the Vite-to-celld mapping and single-module constraint.

```sh
docker compose run --rm deployer diagnose
docker compose logs --tail=30 celld-a celld-b workerd
```

`docker compose down` preserves data volumes. Deleting volumes destroys local data.
The bucket is one local point of failure; two celld replicas do not make it highly
available. Remaining milestones are being implemented in order.
