# Observe an application's native replicas

Run `fogd observe APP --installation PROJECT` to check the native replicas of an
approved app in an enrolled Docker installation. This adds a current native check
to the recorded release information from [`admin inspect`](application-inspection.md).

```sh
export FOGD_HOME=/private/fogd-owner
node packages/cli/bin/fogd.js observe guestbook --installation YOUR_PROJECT
```

Use the home containing that installation's enrollment files and select its Docker
context. Docker-owner access and the private enrollment files authorize this local
operation; a deploy token or remote administrator password does not provide that
access. The command uses the enrolled configuration directly, not `FOGD_SERVER`.
The currently supported runtime family must be independently qualified and cached.
It does not enroll, start, upgrade, or repair an installation.

## Interpret the report

`recorded` identifies the on-disk route and active submission ID/digest. `replicas`
contains each selected node's native state and health HTTP status, plus whether its
published `version` matches the approved release. This compares release versions;
it does not compare per-process generation counters. Private version strings and
native state bodies are omitted.

`nativeReadiness: confirmed` requires both expected replicas to answer native state
and health checks, serve the approved version, and pass signed runtime identity and
fresh fleet-membership verification. The selected controller record, required
capabilities and artifact-pruning state must match before and after probing, and
its controller container must be running at both boundaries. `controllerRecord: matched-at-boundaries` does not establish an atomic
snapshot or prove that nothing changed between those reads.

An unreachable replica, an unverified identity, changed metadata, stopped controller,
or failed observer makes readiness `uncertain`. Pending-only apps are `not-observed`.
A recorded pause, quarantine, unresolved hold/recovery, retirement, or unsupported
state prevents a confirmed result. Pending controller artifact pruning also
prevents a native probe, with reason `controller-artifact-prune-pending`. Completed
pruning of terminal history does not withhold the retained active release. These
findings describe recorded state and native readiness. They do not authorize retry,
resume or metadata replacement.

Use `reason` to distinguish local scope, observer timeout/unavailability, controller
uncertainty, identity failure, and replica readiness.

A null HTTP status means no usable response was confirmed. It can reflect observer
failure or a timeout as well as an unreachable node. Uncertainty does not itself
establish an application outage. Unknown versions remain unknown. The command does
not copy arbitrary native errors or response contents into its report.

## Native readiness is separate from application availability

`applicationOutcomes` and `controllerStorageHealth` always remain `not-observed`.
A healthy native process can host an app that returns errors. This command does not
request an application route, check gateway behavior, or establish current
controller API health. Controller-process liveness is a Docker observation.

On-disk routing can lag a controller whose metadata writes failed: a controller can
pause routing in memory while disk still says active. This command cannot detect
that memory-only condition. Use the authenticated controller view and the app's
own endpoint/results separately. The explicit [gateway request check](application-check.md)
can sample a chosen public path without copying its response contents. A confirmed native observation does not establish
that the app is reachable through ingress or that its writes persist correctly.

Observations are a bounded series of reads, not continuous monitoring, a live fence,
or a guarantee of future availability. Autonomous application work may continue.
No reload, SQL, app request, background-control observation, acknowledgment, pause,
or resume operation is requested by this command.

## Scope, permissions, and cleanup

The command reads existing controller metadata and independent runtime policy with
network-isolated, read-only helpers. It checks volume existence before mounting;
missing data is refused. It compares the enrolled configuration with the qualified
profile and checks the selected fleet's network and actual container images.

A separate transient observer joins only the selected fleet network. It has no
installation/data mounts, capabilities, or Docker socket. Its root filesystem is
read-only. The matching storage credentials and validated profile go through stdin
to read fleet membership and verify signed process identity. Storage credentials
retain their existing authority; trusted observer code performs reads only. App
secrets and administrator, gateway, and deploy credentials are not passed to it.

Helpers remove themselves on normal completion. Error cleanup targets only the
new observer's exact name and nonce label. An unconfirmed cleanup is a command
failure naming the helper to inspect; it is never reported as a healthy result.
Docker preflight uses the existing CLI execution limits; the observer deadline is
not an end-to-end command deadline. The command leaves installation files, data
volumes, and existing containers intact.
A successful diagnostic read can report uncertainty with a normal exit; automation
must inspect `nativeReadiness`.

## Repeat the local check

The [local receipt](evidence/operator-observation-local.json) covers a pending app,
an active release, one stopped replica, a stopped controller, and recovery. Every
observation attempt is retained and checked against unchanged controller snapshots.
A controlled app returns HTTP503 but records a hit if its handler receives the
reserved native-health path. Its counter remains zero while both native health
checks return200, demonstrating the separation from application health.

With the qualified images and ordinary guestbook build dependencies cached, choose
a new private output directory:

```sh
node scripts/cron-probe/selected/observation.mjs .fogd/native-observation-NEW
```

The probe creates its own installation, preserves volumes and diagnostic files,
and removes its scoped containers/networks. It does not install dependencies,
build runtime images, or contact Cloudflare. Evidence is limited to one local Docker
engine. Remote Fogd API observation, Kubernetes, and scoped app logs remain open.
