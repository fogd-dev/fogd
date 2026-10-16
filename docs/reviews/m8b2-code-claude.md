Unit tests pass (runtime transport/gateway, platform 20/20). Review below.

## Verdict

Transport design is sound and matches the spec: forwarding headers are stripped and replaced from the actual request URL, the internal listener is the only one serving routing, the public listener 404s every internal path, shared mode fails closed on missing TLS or a legacy token, and the seventh volume is admitted without breaking six-volume bundles. Two blockers, both operational rather than code defects, plus a handful of should-fixes.

## Blockers

1. **Operator documentation for shared mode does not exist.** The spec's acceptance explicitly requires documenting certificate import, app domain and admin endpoint, scoped token issuance, and startup. Outside `docs/m8b2.md` nothing mentions `fogd up --shared`, `fogd tls import`, `FOGD_ENV_FILE`, `FOGD_BIND_ADDRESS`, or `NODE_EXTRA_CA_CERTS`. The CLI help line is the only operator-facing text. Add a shared-profile section to the README covering the sequence, the private-network and renewal limitations, and the crash-loop behavior below.

2. **CLI policy and container policy read different configuration sources.** `packages/cli/src/local.mjs:30` runs Compose with `--project-directory stackRoot` and no `--env-file`, so Compose interpolates from `stackRoot/.env` for any key absent from the process environment, while the CLI evaluates `transportPolicy` on `FOGD_ENV_FILE`. I confirmed with `docker compose config` that an absent shell variable falls through to the project `.env`. Scenario: `stackRoot/.env` holds a shared installation, `FOGD_ENV_FILE` points at a local test file with no profile keys. The CLI reports local, skips the installed-TLS check, prints an http admin URL, and the containers start shared. The container side still fails closed, so this is not a silent downgrade, but it violates the "without rewriting other installations" claim in the response doc and makes `fogd up` output lie. Fix is one flag: pass `--env-file configPath()` in the `compose` helper so the file the CLI read is the file Compose reads. Test: start a shared stack from `stackRoot/.env`, then run `FOGD_ENV_FILE=/tmp/local.env COMPOSE_PROJECT_NAME=other fogd up` and assert the started controller has `FOGD_PROFILE=local`.

## Should fix

- **Certificate expiry becomes a crash loop with no obvious exit.** `loadTLS` rejects an expired certificate at startup in both `main.mjs` and `serve.mjs`. Both services use `restart: unless-stopped`, so an expiry plus any restart leaves controller and gateway restarting forever. `importTLS` then refuses because `State.Running` flips true during restarts. Document `docker compose stop` before `fogd tls import`, or have `importTLS` stop the project itself. Also note that a running process keeps serving past expiry since validity is checked only at load.

- **`fogd tls import` is also an implicit upgrade step.** `packages/cli/src/tls.mjs:21-22` runs `compose build` and `compose create`, which rebuilds the image and recreates any container whose definition changed. On an M8a installation this is the moment the replicas pick up `--trust-forwarded-headers` and the controller gets the new ports. That is probably what you want, but it should be stated, since the response doc frames upgrade as a deliberate separate action. Test: from an M8a project, run `fogd tls import` and diff `docker inspect` of a slot container before and after.

- **Import generates a legacy token it then has to clear.** `importTLS` calls `prepareEnvironment()` with shared false, so a fresh shared install gets a random `FOGD_DEPLOY_TOKEN` written to the private file, then `fogd up --shared` appends an empty override. `parseEnv` is last-wins so the result is correct, but the dead secret stays in the file. Call `prepareEnvironment(true)` from import, since importing a certificate only makes sense for shared.

- **Misleading failure message for the scoped-token case.** A teammate with a scoped `FOGD_DEPLOY_TOKEN` exported in their shell who runs `fogd up` on a shared installation gets "clear the legacy deploy token". Correct to fail, wrong diagnosis. Either mention the environment variable in the message or ignore the process environment for that key during startup.

- **Gateway drops client address entirely.** `x-forwarded-for` is stripped and never replaced. Acceptable for this milestone, but celld-side logs and any future rate limiting see only the gateway. Record it as a limitation.

## Verified as correct

- `packages/runtime/src/gateway.js:24-28` strips all `x-forwarded-*` and `forwarded`, then sets proto and host from `url`, port included. Unit test covers both schemes.
- `packages/platform/src/http.mjs:36-40` serves `/internal/route` only when `role === 'internal'` and 404s all `/internal/` on public. Only port 8082 is published; 8083 stays on Compose networks. Test covers all four combinations.
- `transportPolicy` rejects shared without TLS, shared with legacy token, non-loopback bind without shared, and malformed values. Compose sets `FOGD_DEPLOY_TOKEN` to empty string, which is falsy, so a cleared file value really clears it. I confirmed an empty shell variable overrides a `.env` value in Compose.
- No private material in error paths: `validateKeypair` swallows the original error, import rejects on parse with a fixed message, `docker()` discards stderr.
- Keypair write is `wx` temp plus fsync plus rename plus directory fsync. The 256 KiB input cap is fine.
- Recovery: `volumeNames(config)` gates the seventh volume on the config, `verifyBundle` cross-checks manifest files against config volumes, and `validateTopology` still accepts six-volume bundles. Sorted order holds since `tls` sorts after `slot-2-b`.
- Local certificate script writes only inside the repo, pins SANs explicitly, and leaves system trust alone. Browser trust is a single SPKI pin on the generated server key, not a global bypass.

## Additional tests worth adding

- Negative keypair test with a real mismatch: generate two keypairs with the local certificate script into temp dirs and assert `validateKeypair` throws on cert from one and key from the other, and on an expired cert produced with `-days -1`.
- `loadTLS` with `FOGD_TLS=1` and a missing file must throw the "import a certificate" message, and with `FOGD_TLS=0` must return null even when a file exists.
- Shared stack with `FOGD_BIND_ADDRESS=0.0.0.0`: assert the controller container refuses to start when `FOGD_TLS=0` is forced into the environment.
- Six-volume M8a bundle restored with the new CLI: assert `restored.json` is written and the restored config has no `tls` volume and `FOGD_CONTROLLER` still points at 8082.