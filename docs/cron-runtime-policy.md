# Experimental cron runtime policy

Cron commands and bootstrap require explicit runtime identity verification.
Missing verification refuses the operation. Ordinary cron admission remains
closed, and the default backend does not install a cron transport.

The [native profile](evidence/m11c-runtime-policy.json) qualifies caller checks on
an app-free two-node Docker fleet. It covers refusals before any CLI call, guarded
bootstrap and an empty held cron cell. It does not qualify scheduled applications,
restored startup or the shipping release build.

## Explicit composition

`backendCronRuntime` in the [backend adapter](../packages/platform/src/backend-runtime-identity.mjs)
composes the [identity policy](../packages/platform/src/runtime-identity.mjs) with
`CronRuntime`. A private qualification caller supplies its expected profile:

```js
backend.crons = backendCronRuntime(backend, profile);
```

The profile has schema 1, an independently verified `binarySha256`, the S3 bucket
name and a `fleets` array. Each fleet declares its `id`, canonical `prefix` and
`nodes`, with a separate `host` and stable native node `id` for each replica. The
hosts and prefix must match the selected controller slot. A root prefix is the
empty string. The profile is copied when the policy is constructed.

A supplied profile expresses the caller's policy. It does not certify a binary or
make it eligible for ordinary admission. The accepted metadata candidate still
needs cron lifecycle and release qualification; do not substitute a hash from an
unrelated image or treat a self-reported version as proof.

The adapter expects the [early identity listener](patches/celld-runtime-identity.md)
on each node's private port 8082. The controller's own port 8082 is on a different
host. Set `CELLD_RUNTIME_IDENTITY_LISTEN` on the qualified native nodes explicitly;
the default Compose stack leaves it disabled. The controller reads and executes
`/usr/local/bin/celld`, using the same absolute path for digest verification and
CLI invocation.

## Checks and outcomes

Every command, including info and confirmation reads, performs fresh verification.
The policy checks the CLI digest and each expected native process's exact identity
payload: binary, node and normalized bucket/prefix digests. It inventories all
persisted node leases before and after those reads. Each lease must identify an
expected node, its matching object key and advertised `host:8081` address, and a
nonempty process probe key. A changed inventory or process key refuses the check.
Unknown expired leases are also refused. Leases may be absent, including before
first bootstrap; every present lease must be expected.

Each inventory pass and identity request has a five-second deadline and bounded
bodies. Verification can span roughly fifteen seconds plus local hashing.
Truncated inventories are refused. Policy errors omit remote diagnostics and credential values.
`CRON_RUNTIME_UNVERIFIED` means the current command was refused before dispatch.
If verification of a confirmation fails after a mutation was sent, the transport
reports `CRON_OUTCOME_UNKNOWN` and does not retry. Snapshot checks retain their
`CRON_SNAPSHOT_UNCONFIRMED` result when identity cannot be verified.

Cron bootstrap verifies before reading the artifact or publishing its app-free
configuration. The native drill supplies valid artifacts to refusal cases, then
checks a successful guarded bootstrap, two-replica adoption, held empty status,
pause and refusal to resume an empty schedule. Its five pre-bootstrap refusal cases leave the bucket unchanged after removal
of the deliberately injected foreign lease. After deployment, the drill records
both real leases with nonempty process-key digests, refuses an additional foreign
lease before any command, and verifies those process keys remain stable.

Run the [driver](../scripts/cron-runtime-guard.mjs) with a new private output
directory, checked native build image, guarded observer image and verified native
binary digest. The observer must contain the current platform sources and that
binary. Inspect raw evidence, the actual runner exit and retained-resource checks
before accepting a pass. The shared fixture removes only its owned containers and
network and retains every volume.

## Qualification still required

These observations are not an atomic fence. Runtime or CLI replacement between
verification and use, and a new lease appearing after inspection, require a
separate lifecycle boundary. The metadata does not bind a node's storage endpoint
or region. Startup and restore must validate images and topology before active
timers can boot. A shipped binary registry, release build, scheduled application
lifecycle and ordinary scoped admission remain open [M11c gates](m11c.md).

Older native qualification receipts identify their executed source versions.
Their controllers omit this verifier and refuse commands on the current tree.
Reproduce those historical profiles with their pinned sources; they do not qualify
the new guarded path or the new native binary.
