# Give a teammate scoped deploy access

An administrator can issue a credential that submits deployments for named apps.
It cannot approve releases, read private artifacts, change app secrets, or inspect
another credential's submissions. This slice qualifies local access controls;
HTTPS and shared-network operation are still M8b2 work.

## Issue and use a credential

From the fogd checkout, using the existing administrator configuration:

```sh
pnpm exec fogd admin issue-token 'Demo builder' hello,notebook
```

The response includes an opaque credential ID, app scopes, and the token. The token
is shown only during issuance. Deliver it privately and keep it out of source code,
logs, and screenshots. The controller stores its hash, not the original token.

The teammate configures `FOGD_SERVER` and `FOGD_DEPLOY_TOKEN` privately, then runs
`fogd deploy` inside an allowed app. Use the workspace CLI with `FOGD_HOME` pointing
at the checkout; this version has not been published to npm. The app name comes from
`fogd.json` or `--name`. An administrator still approves the exact deployment digest.
`fogd status ID` reports only submissions made with that credential.

## Inspect and revoke

```sh
pnpm exec fogd admin list
pnpm exec fogd admin revoke-token CREDENTIAL_ID
```

Listing shows credential names, scopes, issue/revocation timestamps, deployment
submitter IDs, and retained artifact usage. It never returns token values or hashes.
Revocation blocks subsequent submission and status access, including after controller
restart or restoration. It does not remove already approved apps or pending review
records. Scopes are immutable: issue a replacement credential and revoke the old one.
There is one bootstrap administrator in this slice; SSO and multiple administrator
identities are not implemented.

The legacy installation-wide deployment token remains available when configured.
To disable it at the server, omit or clear `FOGD_DEPLOY_TOKEN` when starting Compose.
`fogd up` currently generates a legacy token for the local examples, so use direct
Compose startup when intentionally disabling it. M8b2 must make the shared-mode
policy explicit rather than relying on this local bootstrap behavior.

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
reconciling mismatched controller metadata. Ask an operator to inspect capacity;
safe retirement/pruning belongs to M10. Artifact quotas exclude filesystem overhead,
controller metadata, secret revision history, transient activation copies, and app
D1/R2 growth. Runtime limits and storage monitoring remain separate responsibilities.

## Reproduce the local check

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
