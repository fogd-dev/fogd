# Inspect an enrolled Docker installation

A local Docker owner can run installation doctor before starting services or
changing an application. Use a current operator program with this command and
retain the installation's `FOGD_HOME` and Docker context:

```sh
node packages/cli/bin/fogd.js doctor --installation my-cloud
node packages/cli/bin/fogd.js doctor --installation my-cloud --json
```

This owner-only mode reads the saved configuration and independently installed
policy. It verifies cached runtime programs, then observes the durable-routing
installation's Docker configuration, storage and TLS keypair. It does not need an
HTTP deploy token. The earlier prepared `0.1.0` release artifact predates this
command; existing artifacts keep their authenticated original CLI features.

## Interpret the findings

| Finding | What it establishes | What remains unverified |
| --- | --- | --- |
| `client-node`, `client-tar`, `client-checksum` | Client Node meets the declared minimum; tar has a recognized GNU/BSD banner; sha256sum hashes known stdin correctly | Full archive compatibility, publisher identity or installation readiness |
| `installation-policy` | Saved configuration, verified cached programs and installed policy agree | Permission to start, app health or available capacity |
| `lifecycle-fence` | Whether a retained launch/shutdown marker was observed | The outcome of an interrupted operation; doctor never clears it |
| `network-and-ports` | Owned networks, subnets, attachments and published-port declarations match sealed containers | Non-Docker listeners, external routes, firewalls and client reachability; stopped ports are not reserved |
| `storage-space` | Owned local backing filesystems were sampled at matching inventory boundaries | Storage health, per-volume usage, per-app allocation or a reservation |
| `tls-keypair` | Installed certificate/key match and are currently valid | Endpoint reachability or chain trust |
| `tls-hostname` | Installed certificate covers the explicit `--server` hostname/IP | Chain trust, routing or app health |
| `tls-client-trust` | With `--online`, current Node trust verifies the endpoint and its leaf matches the installed certificate | Application health, revocation status or future trust |

The report includes configured listeners, observed service counts and filesystem
byte counters. Running services do not establish application health. Follow
[`fogd observe`](application-observation.md) and
[`fogd check`](application-check.md) for separate native and endpoint observations.
The detailed network/listener inventory targets the qualified durable-routing
family. Legacy families retain the separate `doctor --runtime FAMILY` metadata
check and authoritative startup validation.

A missing data volume is unsupported. Inaccessible, inconsistent or changed
observations stay unverified. Reports omit private values and raw Docker output.
The command exits `1` for an observed unsupported condition or an unconfirmed
helper cleanup, and `2` when readiness remains unverified. It does not return a
complete-readiness verdict or reserve resources.

## Inspect endpoint certificates

Supply an HTTPS origin to check the installed certificate's hostname coverage
without opening a network connection:

```sh
node packages/cli/bin/fogd.js doctor --installation my-cloud --server https://fogd.example.test:8443 --json
```

Add `--online` to request one TLS handshake from the current Node client. For a
private certificate authority, set `NODE_EXTRA_CA_CERTS` before launching Node:

```sh
NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem node packages/cli/bin/fogd.js doctor --installation my-cloud --server https://fogd.example.test:8443 --online --json
```

The connection uses normal certificate verification, checks the endpoint leaf
fingerprint against the installed certificate, then closes without HTTP,
application requests or credentials. It has a five-second deadline and never
installs trust or changes certificates. `--server` accepts an HTTPS origin with
no credentials, path, query or fragment; `--online` requires it in installation
mode. The default command and `--server` alone remain offline.

A known hostname mismatch or certificate-verification refusal is unsupported.
Connection failures remain unverified. A different leaf certificate is
unsupported even when its chain is trusted; inspect certificate rotation or the
selected endpoint. A TLS-terminating proxy presenting its own certificate is
reported as a mismatch. A stopped endpoint can still have supported offline keypair
and hostname findings while client trust remains unverified. These observations
use [Node's TLS verification](https://nodejs.org/api/tls.html#tlscheckserveridentityhostname-cert)
and do not establish application health or revocation status.

The [native TLS receipt](evidence/operator-doctor-tls-endpoint.json) records default,
offline and online cases with unchanged QA fixture metadata and zero application
bytes sent. A separate stalled loopback handshake verifies the timeout path.

## Read-only scope

Client prerequisite probes use bounded `tar --version` output and hash known
stdin without touching installation files. Unknown or failing tools stay
unverified; raw process output is omitted. The
[client-tool evidence](https://github.com/fogd-dev/fogd/blob/main/docs/evidence/operator-doctor-client-tools.json)
records the real and negative cases.

Installation inspection uses short-lived restricted helpers from cached verified images.
Application services are not started, images are not pulled and installation
configuration is not rewritten. Filesystem sampling and TLS reads use existing
read-only backing-path bind mounts, so a missing source cannot create a new named
volume. The private TLS bytes stay inside the reader; only validity, hostname coverage
and a leaf fingerprint used for endpoint comparison leave it.
Unconfirmed storage/TLS reader cleanup fails the command.

A retained launch/shutdown marker remains an unverified finding. Keep ingress
stopped and inspect the original operation and container state before another
lifecycle decision. Without an explicit online check, keypair validity does not prove client trust:
retain the documented `NODE_EXTRA_CA_CERTS` and `FOGD_SERVER` settings for startup.
Doctor does not import certificates, install global trust or repair a failed launch.

These checks are observations, not an atomic snapshot or a global writer lock.
The [native evidence](https://github.com/fogd-dev/fogd/blob/main/docs/evidence/operator-installation-doctor.json) covers stopped and
partially started v5 services, injected observation failures, private-data
preservation and retained uncertain lifecycle state. Client prerequisites and
local candidate comparisons have separate bounded checks.

## Compare an existing build with installation records

Use the operator program to compare a generated build before submission:

```sh
node packages/cli/bin/fogd.js doctor --project ./my-app --name my-app --against-installation my-cloud --json
```

This mode stages and validates existing worker, asset and migration bytes without
running build plugins or uploading. It verifies the selected installation's saved
configuration and installed policy, then invokes that cached image's controller
compatibility rules through a restricted read-only reader. The controller does not
need to be running. `--against-installation` requires `--project` and excludes
`--online`; the standalone developer client keeps its separate scoped HTTP checks.

The `resource-changes` finding compares retained resource identities, including
identities from failed activations, applied migration names and digests, retired
names, quarantined slots and configured queue admission. Compatible candidates
report the count of R2 additions and pending migrations. Missing or incomplete
controller records stay unverified; known incompatible changes are unsupported.
Only classified reasons and counts leave the helper. Private controller records,
SQL text and diagnostic output do not appear in the report.

The comparison observes one metadata read. It does not reconcile SQL, inspect
live resources, establish credential permissions or reserve a slot. Source files
may be newer than the generated build. Secret values, native behavior and capacity
remain unverified, and submission and exact approval repeat their checks. No
operation marker is cleared. The prepared `0.1.0` artifact predates this command.

The [native comparison receipt](evidence/operator-installed-application-comparison.json)
records five comparisons on a stopped v5 QA installation, including incompatible
migration and resource changes. Full fixture metadata, controller-state hashes
and the retained operation-marker hash match before and after each case.
