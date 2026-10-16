# Claude architecture review

Review complete. Findings below, grounded in the pinned `.upstream` checkouts.

## Verdict

The baseline (full app on celld, workerd as stateless ingress) holds up against source. One-fleet-per-app is confirmed necessary. No blocker to passing the architecture gate, but four items need adjusting before milestone 2 work starts, and one is a security gap.

## Must fix before milestone 2

1. **Drop esbuild from the deploy container and set `no_bundle: true`.** celld's deploy code says running esbuild over a Vite build "is what corrupts it" and reads the entry file as-is when `no_bundle` is set (`.upstream/celld/crates/celld/deploy.rs:301-304`, `630-634`). The proposal's "invokes celld deploy from a container with esbuild" is both unnecessary and a correctness risk. Asset-only or `no_bundle` projects do not need esbuild on PATH at all.

2. **Block `/__void/*` at the workerd gateway.** Void's migration runner is baked into the deployed worker at `/__void/migrate/*` and is guarded only by the `x-void-internal` header matching the `__VOID_PROXY_TOKEN` var (`.upstream/void/packages/void/src/runtime/migration-handler.ts:56-60`). Void's basic-auth middleware explicitly skips those paths (`runtime/handler.ts:374-377`) because the Cloudflare proxy worker fronts them. fogd has no such proxy. The gateway must reject `/__void/*` and strip `x-void-internal` from external requests, and the deploy controller must call the migrate endpoint from inside the Compose network. Since celld stores vars in the plaintext deploy manifest, treat the token as bucket-equivalent, which the proposal already does.

3. **Strip `version_metadata` in the adapter, and say so in the plan.** Void's build plugin auto-injects a `version_metadata` binding (`plugin-worker-bindings.ts:504-505`). celld rejects any key outside `SUPPORTED_KEYS` with a hard error (`deploy.rs:42-64`, `1298-1307`). Stripping is safe: the runtime only reads it to add an optional `versionId` to the `/__void/ready` response (`routing-worker.ts:231-236`). Same check applies to `observability`, `routes`, `workers_dev`, and `account_id` if the generator emits them. The adapter should diff the generated config against the allowlist and fail loudly, which the proposal states but should name these keys.

4. **Pick one migration runner, not two.** Both exist and they keep separate bookkeeping. `celld d1 migrations apply` reads `migrations_dir` from the Wrangler config, which Void already fills (`wrangler.ts:863`, `1329`), and uses celld's own `migrations_table` (`d1_cli.rs:267-297`). Void's `/__void/migrate/app` uses its own attempt and plan-hash tables. Running both double-applies. Recommendation: use Void's endpoint, since it is what the app's own deploy tooling expects and it runs with the app's D1 binding. Note that `celld d1` requires reaching a live node's internal listener via the fleet HMAC (`d1_cli.rs:108-121`), so neither option works from outside the Compose network.

## Adjustments, not blockers

- **workerd has no health checking or load balancing.** `ExternalServer` is one address (`workerd.capnp:864-896`). "Forwards HTTP to healthy replicas" has to be gateway-worker JavaScript: two service bindings, fail over only on connection errors before the body is sent. Simplest alternative to test first: a single Compose service with two replicas and Docker DNS round-robin, since any celld node accepts public traffic and routes to the owner over peer HTTP (`celld/README.md:21-24`). Whether KJ re-resolves DNS per connection is unverified.
- **Fleet pointer claim confirmed.** `deploy/current.json` is "the sole application selector" and moves last (`deploy.rs:936-946`). One fleet per app is the correct call. celld also says "Routes are not [supported]; use Wrangler" (`deploy.rs:241-243`), so hostname routing is entirely fogd's gateway job.
- **Peer traffic is authenticated, not encrypted.** Cell fetch and RPC use the fleet HMAC in `fleet/peer-auth.json` with a 30-second replay window (`peer_auth.rs:17-28`). README requires advertised addresses on a trusted private network or encrypted overlay. Fine inside one Compose network. The two-machine homelab needs WireGuard or Tailscale between internal listeners. Record this for milestone 5.
- **Script name constraint.** celld requires lowercase ASCII, digits, and internal hyphens for `name` (`deploy.rs:1314-1318`). The adapter should slug the Void project name.
- **`cloudflare:workers` is covered.** celld stubs it with `DurableObject`, `RpcTarget`, `WorkerEntrypoint`, and a live `env` getter (`harness.js:9521-9573`). Void's `durable.ts` and `env-raw.ts` imports resolve. `cloudflare:email` does not, consistent with the matrix.
- **Assets config is already celld-shaped.** Void deletes `not_found_handling` and `run_worker_first` from the assets block (`plugin-worker-bindings.ts:161-163`), so that passes celld's parser.

## Compat matrix

Accurate as a source audit. Two rows deserve one extra qualifier: "SQL migration runner: celld Yes" should note the two-runner conflict above, and "Vars and secret text bindings: celld Yes" should note the plaintext manifest, which the matrix body already implies.

## Unverified

I did not trace where the Void build writes the generated Wrangler config inside `dist/ssr/` or `dist/rsc/` (`build-output-dir.ts:51`). Milestone 2 will surface that immediately. I also did not test WebSocket proxying through workerd, consistent with the proposal's own caveat.
