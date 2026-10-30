# Prepare a proposed app for preview

`fogd preview prepare` downloads and verifies an exact proposed release without
executing it or changing production. Live preview launch is still under
[issue 2](https://github.com/fogd-dev/fogd/issues/2). Preparation gives that work a
private, identifiable input; it does not provide a running URL or grant execution
permission.

## Prepare an exact submission

Use the operator CLI with the source controller's administrator credentials and
TLS trust configured, as for [artifact review](artifact-review.md):

```sh
fogd preview prepare SUBMISSION_UUID \
  --runtime celld-archive-v9-linux-arm64 \
  --lifetime-seconds 900 \
  --output /private/new-preview
```

Choose a fresh directory whose parent already exists. The command refuses existing
output and uses only administrator GET requests. A deploy credential alone does
not grant access. It downloads the proposed artifact and any current active
baseline, verifies their app/digest and canonical contents, then checks that source
state stayed unchanged throughout the review. Failures retain partial output without a success report. No application code, SQL or Docker operation runs.

The directory contains `review.json`, the `proposed/` artifact, an `active/` baseline
when present, and `preview.json`. Directory permissions are `0700`; metadata files
use `0600`. Application artifacts can contain sensitive source and literal
configuration, so retain the whole directory privately.

`preview.json` records a new preparation UUID, source controller/app/submission and
digest, the review fingerprint, the intended qualified runtime family and its
catalog-entry fingerprint. Standard output includes the preparation SHA-256.
Fingerprints identify bytes; they do not authenticate a publisher or grant access.
A later source submission does not replace the selected artifact.

## Execution policy and remaining work

Preparation records the intended execution policy. Enforcement and launch remain
unavailable. The lifetime is an integer from 60 to 3600 seconds, measured from a
future authorized launch rather than from download time. This initial profile
accepts HTTP applications; queue and cron declarations refuse preparation.
Required secret names are recorded, but source vault values and credentials are
never copied into the preparation.

Live launch must use fresh empty storage and separate native/resource identities,
preview-only credentials and secrets, an authenticated URL, and no external network
egress. Existing production data, secrets, fleet capacity and activation decisions
must remain untouched. Preview data cannot become production data implicitly.
Resource limits and capacity refusal must be enforced before launch is available;
a container CPU budget does not establish a per-worker CPU quota.

Expiry or explicit teardown must deny new requests and stop preview writers.
Expiry alone cannot report capacity free: fencing and completed reclamation still
need separate confirmation. Interrupted operations must retain their resources and
uncertainty. Production activation remains its own exact-artifact decision.

The current `prepared` result explicitly reports `executionAuthorized: false` and
`capacityReserved: false`. These policy fields are requirements for the remaining
implementation, not evidence that an executing preview is isolated or time-limited.

## Internal deadline component

An [internal supervisor check](evidence/operator-preview-supervisor.json) exercises
expiry, cancellation, forced termination and missing child-exit observations.
Expired deadlines refuse startup, and retries keep the original absolute deadline.
The child environment defaults to empty application configuration and copies only
explicit own properties; Node can add platform process metadata.

Two current-source, network-disabled, read-only container cases distinguish direct
child exit from verified container stop, including a descendant process. The host
clock and operating-system scheduling remain trusted prerequisites. This is a
launcher component, not a preview execution permission or an application sandbox.
The integration must still bind exact authorization, isolate resources and network
access, protect the URL, and enforce expiry for every service. No preview launch
command is available yet.
