# Give a teammate scoped deploy access

An administrator can issue a credential that submits deployments for named apps.
It cannot approve releases, read private artifacts, change app secrets, or inspect
another credential's submissions. Use the [shared installation](shared-installation.md)
procedure for HTTPS and private operator configuration. Local qualification does
not establish operation on another host.

## Issue and use a credential

From the operator directory, using the existing administrator profile and TLS trust:

```sh
node packages/cli/bin/fogd.js admin issue-token 'Demo builder' hello,notebook
```

The response includes an opaque credential ID, app scopes, and the token. The token
is shown only during issuance. Deliver it privately and keep it out of source code,
logs, and screenshots. The controller stores its hash, not the original token.

Give the teammate a [standalone developer client](developer-client.md), the
endpoint, token, and CA certificate when needed. They configure `FOGD_SERVER`,
`FOGD_DEPLOY_TOKEN`, and client trust privately, then invoke the client inside their
prepared application project:

```sh
node /path/to/client/fogd.mjs deploy
node /path/to/client/fogd.mjs status SUBMISSION_ID
```

The app name comes from `fogd.json` or `--name`. An administrator still approves
the exact deployment digest. Status reports only submissions made with that
credential. The client needs the app's existing SDK/build dependencies; it needs
no Docker or operator credentials.

## Inspect and revoke

```sh
node packages/cli/bin/fogd.js admin list
node packages/cli/bin/fogd.js admin revoke-token CREDENTIAL_ID
```

Listing shows credential names, scopes, issue/revocation timestamps, deployment
submitter IDs, and retained artifact usage. It never returns token values or hashes.
Revocation blocks subsequent submission and status access and persists across
controller restart. A backup retains the credential state at its snapshot boundary:
restoring a backup taken before revocation can make the token valid again. Review
and revoke restored credentials before reopening deployment access. Revocation
does not remove already approved apps or pending review records. Scopes are
immutable: issue a replacement credential and revoke the old one.
There is one bootstrap administrator in this slice; SSO and multiple administrator
identities are not implemented.

Shared bootstrap with `fogd up --shared` clears the installation-wide deployment
token and requires app-scoped credentials. Normal enrolled startup preserves the
saved configuration. Local development bootstrap can still generate a legacy
installation-wide token; use the shared installation path when giving teammates
access. Do not change an enrolled policy or invoke raw Compose to bypass it.

## Capacity limits

The [example environment](../.env.example) lists the configurable limits. The
controller refuses malformed numeric limits at startup. Global and scoped-credential
pending limits count both pending and failed requests. The legacy team token retains
the global limit. Retained artifact capacity
counts decoded file bytes across every artifact, including rejected and superseded
releases. Restart reconstructs usage from disk. Concurrent authenticated uploads
have a separate limit; excess requests return 429 and can be retried later.

Capacity refusal preserves existing data and does not silently prune artifacts.
Orphan directories are counted conservatively because they may be useful when
reconciling mismatched controller metadata. Operators can inspect usage with
`fogd admin capacity`. Local build-copy pruning does not reclaim controller
artifacts; controller artifact collection remains open. Artifact quotas exclude
filesystem overhead,
controller metadata, secret revision history, transient activation copies, and app
D1/R2 growth. Runtime limits and storage monitoring remain separate responsibilities.

## Reproduce the local check

The following reproduction scripts require the source checkout and its declared
inputs; they are not operator-package commands.

Run `node scripts/scoped-deploy-smoke.mjs` against a fresh disposable stack. It uses
the real CLI to issue credentials, deploy hello and notebook with distinct scopes,
approve both, revoke a credential, and restart the controller. It checks scope,
status, and admin separation, redacted metadata, revocation, and byte accounting. It
then disables legacy access, tests capacity refusal, and restores the installation
to fresh volumes to verify those controls persist.
Unit tests exercise queued revocation, concurrent quota admission, and upload limits.

`node scripts/upload-capacity.mjs` uses an approved hello app on a disposable stack
with capacity for two additional maximum-size artifacts. It submits both concurrently,
checks accounting, rejects them, revokes its drill credential, and reports the
controller memory peak. The retained rejected artifacts still consume quota.
