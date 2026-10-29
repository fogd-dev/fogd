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
| `tls-keypair` | Installed certificate/key match and are currently valid | Certificate hostname coverage and client CA trust |

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
volume. The private TLS bytes stay inside the reader; only validity is reported.
Unconfirmed storage/TLS reader cleanup fails the command.

A retained launch/shutdown marker remains an unverified finding. Keep ingress
stopped and inspect the original operation and container state before another
lifecycle decision. Keypair validity does not prove that the client trusts its CA:
retain the documented `NODE_EXTRA_CA_CERTS` and `FOGD_SERVER` settings for startup.
Doctor does not import certificates, install global trust or repair a failed launch.

These checks are observations, not an atomic snapshot or a global writer lock.
The [native evidence](https://github.com/fogd-dev/fogd/blob/main/docs/evidence/operator-installation-doctor.json) covers stopped and
partially started v5 services, injected observation failures, private-data
preservation and retained uncertain lifecycle state. Broader host-tool checks and
active-release resource comparisons remain separate work.
