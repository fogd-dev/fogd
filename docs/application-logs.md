# Capture private replica logs

`fogd logs APP --installation PROJECT --output NEW_DIRECTORY` captures bounded
process output from the selected app's replica containers into private local files.
This is a Docker-owner diagnostic interface. It is not a developer or submitter log
API, and its files are not redacted for sharing.

The interface is implemented in the host CLI with temporary-process/filesystem
and mocked-Docker checks. Native acceptance remains
open. It does not enable logging in a runtime, change log drivers, or qualify a new
runtime family. Follow the [operator-readiness contract](operator-readiness.md)
for the remaining runtime and two-application acceptance gates.

## Collect a capture

Use the installation's private enrollment files, Docker-owner access and cached
qualified image. Choose a new directory under a private, existing parent:

```sh
fogd logs guestbook --installation YOUR_PROJECT --output /private/guestbook-logs
```

The collector verifies the enrolled configuration, the selected fleet's actual
container images, launch settings, data mounts and private network. It also checks
that the fleet's stored owner names the requested app before reading process logs.
It selects exact container IDs. Controller, ingress, object-store and other app
containers are excluded. An unassigned, retired, quarantined, unsupported or
unverified app/fleet refuses before log collection.

Paused or failed applications with a verifiable assigned fleet can be diagnosed.
A stopped controller can still be diagnosed when its retained app record and
fleet ownership remain verifiable. Stopped replicas can supply retained Docker logs; no replica or application is
started to make collection succeed. Missing containers or an unavailable owner
record leave scope unconfirmed. A deploy token or remote administrator password
does not provide the local Docker and enrollment authority this command requires.

The command requests a finite tail and limits each log process by bytes and time.
Scope readers and filesystem operations have separate execution bounds; this is
not an end-to-end deadline. It does not follow
a stream, replay an application request, observe background controls, reload code,
run SQL, or change the installation. The optional `--tail COUNT` selects a bounded
line count; byte limits still apply independently.

## Read the files and result

The new directory is private. Each selected replica has separate `stdout.log` and
`stderr.log` files, named by its fleet service. A final `capture.json` describes the
requested app, recorded release identity, selected containers, collection outcomes
and scope checks. The terminal prints a fixed summary and file locations, never
stream contents or raw Docker errors.

A `captured` result means the selected finite log commands completed and scope
matched at the observation boundaries. It does not mean the application's full log
history is available. Docker rotation, unavailable log drivers, runtime drops and
the selected tail can omit events. Log lines can span multiple releases of the
same app. The recorded active digest does not attribute each line to that release.

Per-capture `exitCode` and `signal` describe the Docker log command, not the
application or replica process. A partial or unconfirmed capture retains private
files for inspection and exits nonzero. A byte limit, timeout, failed log command, changed controller record,
changed container or unverifiable owner cannot produce a confirmed capture. An
interruption or collector failure can leave an incomplete directory without a final
manifest. The
collector never overwrites or deletes an earlier capture.

Controller and ownership reads bracket collection; they are not a live fence.
Concurrent changes can make the capture unconfirmed. This interface assumes the
qualified one-app-per-fleet assignment and cooperative operation; it does not
establish isolation against privileged Docker, storage or filesystem mutation.

## Handle disclosure deliberately

Replica process streams combine app console output and runtime diagnostics. They
can contain app data, secret values, stack traces, storage details and terminal
control bytes. This interface keeps those bytes private rather than classifying or
redacting them. Do not publish the directory or treat its files as safe for a team
channel. Inspect raw files with tools appropriate for untrusted content.

The scope claim identifies the process sources, not the origin or sensitivity of
every value those processes printed. It does not filter lines by an app name or
replace a known list of secrets. The collector has no shared-controller-log or
public log endpoint. A future submitter-facing surface needs its own structured
record format, disclosure policy, app attribution, authorization and qualification.
