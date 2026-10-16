The design is sound in its core bets: workerd's pinned schema has `https` sockets with `tlsOptions.keypair`, celld v0.6.2 (the pinned image) has `--trust-forwarded-headers` with last-value semantics, and Void hardcodes `secure: true` on its cookies, so HTTPS at the edge is what makes those cookies survive on a non-localhost origin. Below are the problems I found, ranked, then the simplest implementation I'd accept.

## Findings

**1. The forwarded-header contract with celld is right but incomplete in the gateway.** The gateway at `packages/runtime/src/gateway.js:24` strips only `x-void-`, `x-fogd-`, and `cf-` prefixes. For celld's trusted read to be safe the gateway must also delete every `x-forwarded-*` header and the RFC 7239 `Forwarded` header, then set exactly one `X-Forwarded-Proto` from `url.protocol` and one `X-Forwarded-Host` from `url.host` (host with port, since the local test port will not be 443). celld's `well_formed_host` accepts a port, so this works. The design says "strip and replace", which is correct, but the acceptance test should assert both a spoofed `X-Forwarded-Proto: https` over the plaintext local profile and a spoofed `X-Forwarded-Host` over the TLS profile land as the gateway's values. One subtlety: with the flag on, celld prefers `X-Forwarded-Host` over `Host`, so if the gateway ever forgets to set it, a client header would be trusted. Make the gateway set it unconditionally, in both profiles, so the flag can also be on in both profiles and local and shared differ only by the socket type. That removes a config fork.

**2. The flag on celld must be a compose-level change, not an env toggle.** `--trust-forwarded-headers` goes into each slot's `command:` array. `inventory.checkContainer` compares running `Cmd` to Compose, so an M8a backup restored and then upgraded will correctly flag the command drift until the operator restarts with the new config. Document that ordering explicitly in the upgrade procedure, otherwise the upgrade step "deliberately" trips the recovery guard.

**3. `embed` in the generated capnp will not reach the volume by absolute path.** In `serve.mjs` the config lives in `/tmp/fogd-gateway` and `embed "/x"` resolves against capnp import paths, not the filesystem root. Copy the two PEMs into that directory next to `gateway.js` (the file already does this for the worker module) and use relative `embed "key.pem"`. Set the runtime dir and copies to mode 0600 since the key now lives in a tmpfs path too. Inlining the key as a text literal in the config would work as well but leaves key material in a generated file, so prefer the copy.

**4. Certificate shape is the most likely qualification blocker.** Apps route by hostname under `FOGD_BASE_DOMAIN`, so the workerd keypair must be a wildcard or multi-SAN cert for `*.base-domain`, and the admin endpoint needs its own SAN. The design does not say this. For the local test certificate, do not rely on `*.localhost`: browser wildcard rules around single-label and reserved names are inconsistent. Enumerate explicit SANs for the fixture hosts, or use a test base domain like `fogd.test` with `/etc/hosts` or a Docker-side resolver. Record which one you pick as the qualification constraint.

**5. Node cannot mint certificates.** The stdlib has `X509Certificate.checkPrivateKey()` and `validTo` for import validation, which is exactly what the import helper needs and avoids an `openssl` dependency there. But generating the local test cert needs the host `openssl` binary, so the "generated only inside the repo" script is a host-side script with gitignored output, not something the runtime image can do. Say so in the doc.

**6. Recovery: the strict manifest and topology checks need one deliberate relaxation.** `verifyBundle` requires `manifest.files` keys to equal the six tar names exactly, and `validateTopology` requires the volume set to equal the six. The optional TLS volume breaks both. Keep format `fogd-stopped-v1`, and make `tls` the only permitted optional extra in both checks: when present in Compose it must be a managed local volume, when present in the manifest its tar is verified and restored, otherwise skipped. Also widen the hardcoded `volumes` list in `docker.mjs` carefully, since `backup.mjs:18` derives the slot stop order from it by prefix. A bind mount instead of a volume would be simpler for cert renewal but fails `validateTopology` and conflicts with the stated goal of carrying TLS state through restore, so the volume is the right call given that goal.

**7. Listener split: do it in both profiles, one code path.** Rather than "local keeps one listener, shared gets two", always run an internal HTTP listener that serves only `/internal/route` and a public listener that serves everything else. The public one is `node:http` in local and `node:https` in shared. `server()` in `http.mjs` already takes options, so a `{ role: 'internal' | 'public', tls }` option and one `if` per role is the entire change. Compose publishes only the public port. Honest caveat for the doc: every container on `control`, `fleet-1`, and `fleet-2` can still reach the internal listener, including celld nodes running tenant code. The gateway token is still the real boundary there, same as today. The split removes `/internal/route` from the published port, nothing more.

**8. Bind-address policy is a guard, not a boundary.** Passing `FOGD_BIND_ADDRESS` into the controller lets startup refuse non-loopback plus plaintext, but the container only sees what `.env` says, not what Docker actually published. State that plainly. Also the check belongs in `main.mjs`, next to the existing fail-closed slot validation, not in `server()`.

**9. Legacy token refusal has two halves.** Controller side: in shared mode, non-empty `FOGD_DEPLOY_TOKEN` is a startup error. CLI side: `up()` at `packages/cli/src/platform.mjs:11` appends a fresh `FOGD_DEPLOY_TOKEN` whenever it is missing, so a shared startup path must skip that name. Simplest: `fogd up --shared` reads a `FOGD_PROFILE=shared` from `.env`, generates only admin and gateway secrets, and adds `-f compose.shared.yaml`. Using a Compose override file for the shared profile is more reversible than threading conditionals through `compose.yaml`, and the backup already records the resolved merged config.

**10. Teammate CLI trust is already correct in shape.** `fetch` in `platform.mjs` uses Node's default TLS store, which honors `NODE_EXTRA_CA_CERTS`. No code change is needed there beyond documenting it and testing rejection without the variable. Make sure the test does not set `NODE_TLS_REJECT_UNAUTHORIZED`, which would be the global bypass the design forbids.

## Minor

- Cookie semantics: Void sets `Secure` unconditionally, so the origin check that matters is `validRedirectUri` requiring `https:` for non-localhost redirects. The acceptance test for "correct HTTPS origin" should exercise a redirect or absolute link, since a cookie alone will not distinguish http from https at celld.
- No HTTP to HTTPS redirect listener in shared mode. Fine, but list it as a limitation alongside renewal and single-admin.
- `FOGD_CONTROLLER` for workerd stays pointed at the internal port. If you renumber the public port, update the `.env.example` comment for `FOGD_SERVER`.

## Simplest reversible implementation

- gateway.js: strip `forwarded` and `x-forwarded-*`, set proto and host from the URL. Always on.
- compose.yaml: add `--trust-forwarded-headers` to the four slot commands. Always on.
- http.mjs: `role` option, two `createServer` calls in `main.mjs`, `https` when a keypair is configured.
- serve.mjs: copy PEMs into the runtime dir when `FOGD_TLS_DIR` is set, emit an `https` socket instead of `http`.
- compose.shared.yaml: TLS volume, read-only mounts, public TLS ports, `FOGD_PROFILE=shared`.
- CLI: `fogd tls import`, `fogd up --shared`, and the optional `tls` volume in the three recovery checks.
- One host-side `openssl` script for the test cert, output gitignored.

Everything above is additive and deletable by removing the override file and the `tls` branch in recovery. No upstream version moves.
