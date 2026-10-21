# Early native runtime identity

The [identity patch](../../patches/celld-0.6.2-runtime-identity.patch) provides
read-only process metadata before celld loads its first deployment. It does not
enable cron admission or enforce a qualified-runtime policy in fogd.

Application deployment versions do not identify the runtime executable. Existing
`/state` also waits for an initial deployment. Checking cron status is unsuitable
for discovering an unknown runtime: older cron implementations can arm a timer
while handling an info request. This endpoint uses a separate startup listener and
never calls the application actor, cron cell or bucket client.

Apply the patch to celld commit `90b43017241f81189453d326d05948f388b34652`, after
the attachment, cron retry and cron control patches. Set
`CELLD_RUNTIME_IDENTITY_LISTEN` to a private socket address to opt in. An unset
variable starts no listener. Invalid addresses and local development storage are
refused. Keep the listener off public ingress; no authentication is provided.

`GET /runtime/identity` returns schema 1 with SHA-256 digests of the running Linux
`/proc/self/exe`, the resolved node ID, and the normalized S3 bucket/prefix. The
namespace form is `s3://bucket/prefix`, or `s3://bucket/` without a prefix. Empty
path segments and trailing prefix slashes are normalized by celld's bucket parser.
The storage endpoint and region are not included. These hashes identify inputs;
they do not make guessable names confidential or certify runtime capabilities.

Responses prohibit caching and close the connection. Other paths, methods and
queries are refused. Connections and header-read time are bounded; transient accept
errors are logged and retried. Dropping the startup guard closes the listener and
its active connections. Native startup can write its ordinary storage-format
record; identity requests themselves perform no storage operations.

## Qualification and reproduction

The [accepted metadata profile](../evidence/m11c-runtime-identity.json) records a
successful Linux arm64 Docker run, four passing new Rust tests, Clippy with
warnings denied and 467 passing repository tests. Independent verification matches
all 179 native source files inside the checked image to the applied patch stack.
It also matches the image artifact to both reported running executables and checks
the final retained volumes after container removal.

The native driver creates a fresh private Docker network, bucket and node disks.
It publishes no host ports and issues no deploy or cron commands. Its two enabled
nodes must report their actual executable hashes, distinct node hashes and the
same normalized namespace. Separate default-disabled and older-runtime instances
must refuse the identity connection while their processes remain running.
Malformed-address and local-store instances must exit with the identity setting
named in their errors. The driver checks protocol rejection, a stalled connection,
a concurrent healthy request and exact bucket-content preservation across reads.
Cleanup removes its containers and retains every volume.

Build the patched source using the [native Dockerfile](../../docker/celld-cron-build.Dockerfile)
with the `test` target and the `lab` profile, then supply the resulting image:

```sh
node scripts/cron-runtime-identity.mjs \
  .fogd/identity-evidence fogd-celld-identity-checks2:local
```

The driver also needs the observer, older native and MinIO images named in its
[fixture](../../scripts/cron-probe/identity/fixture.mjs). It resolves every tag to
an image ID before starting containers. Its default subnet is reserved for this
local qualification; select another available subnet with
`FOGD_IDENTITY_PROBE_SUBNET` if necessary. The output directory must be new and
contains private configuration. Inspect raw results and the final cleanup receipt
before accepting a printed pass.

The patch adds four Linux tests that run without celld's external internal-test
harness. They cover executable and namespace identity, disabled/invalid context,
protocol and guard shutdown, and bounded slow connections with recovered capacity.
They do not execute the upstream internal Rust suites.

## Remaining release binding

The [caller policy foundation](../cron-runtime-policy.md) verifies a supplied
binary profile before bootstrap and every cron command, including info. Its
bounded native profile covers app-free bootstrap and an empty held cron cell.
A supplied profile is policy, not qualification of scheduled applications.
Storage endpoint binding, immutable topology/runtime lifecycle and host-side
preboot recovery checks remain open. A read-only observation is not an atomic
fence against process replacement or a new fleet member.

The `lab` metadata profile does not transfer previous cron lifecycle evidence to
this new binary. Shipped-image packaging, release-build qualification and the
ordinary scoped admission gates in [M11c](../m11c.md) remain open.
