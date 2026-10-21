# Experimental signed runtime identity

The [binding patch](../../patches/celld-0.6.2-runtime-binding.patch) lets a private
caller challenge celld's startup identity using the key advertised in its node
lease. The [release-profile receipt](../evidence/m11c-runtime-binding.json)
qualifies app-free checks and held empty cron controls on Linux arm64. Scheduled
applications and ordinary cron admission remain unqualified on this binary.

Apply this patch after the attachment, retry, controls and
[early identity](celld-runtime-identity.md) patches to the upstream revision pinned
in the receipt. The listener remains an explicit
`CELLD_RUNTIME_IDENTITY_LISTEN` opt-in. It starts before first deployment, after
installing the peer-probe signer. Local development storage and control-plane
startup are refused when the listener is requested. Keep it on a private network.

## Wire identity

A plain `GET /runtime/identity` returns schema 2 and five SHA-256 digests: the
running Linux executable, node ID, normalized bucket/prefix namespace, storage
tuple and process public key. Schema 1 is historical; the current caller has no
fallback to it.

The storage tuple is compact UTF-8 JSON containing the normalized namespace,
canonical HTTP(S) origin and effective region, in that order. An example is:

```json
["s3://fogd/slots/one","http://storage:9000","us-east-1"]
```

The namespace is `s3://bucket/` for a root prefix. The origin normalizes case,
default ports and a root slash. Credentials, non-root paths, queries and fragments
are refused. The native endpoint follows resolved settings and then the existing
`AWS_ENDPOINT_URL`/`AWS_ENDPOINT` environment resolution. Native region resolution
can use `AWS_REGION`, `AWS_DEFAULT_REGION`, then `us-east-1`; the controller profile
requires an explicit region. Storage credentials, account identity and other S3
client options are outside this tuple.

`GET /runtime/identity?challenge=` with a 64-character lowercase hexadecimal nonce
returns the base fields plus the decoded challenge, public key and Ed25519
signature. The parser accepts one logical decoded challenge parameter; duplicate
or unknown parameters fail. Percent encoding and empty query pairs follow the URL
form parser. The native signature covers its fixed startup claims; the request
cannot supply claims to sign.

The signing domain and field order are defined in the
[native patch](../../patches/celld-0.6.2-runtime-binding.patch) and checked by the
[controller verifier](../../packages/platform/src/runtime-identity-proof.mjs).
The [independent fixture encoder](../../packages/platform/test/fixtures/runtime-proof.mjs)
and literal Rust/JavaScript vectors pin their encoding. The receipt additionally
records OpenSSL verification of four saved native proofs using a Python encoder,
and rejection after altering each challenge. This check does not call the
controller verifier.

Requests perform no actor, application or bucket operations. Existing connection,
header-time and response bounds still apply. No listener authentication is added.

## Authority and trust boundary

A fresh valid signature proves possession of the advertised lease key by whoever
answered through the metadata host. Caller policy compares the signed claims with
its supplied profile and matches every present lease key to that response. A
copied public key alone cannot answer a fresh challenge.

This is not remote attestation. A relay can forward a challenge to a genuine key
holder; the response does not independently bind the application port to that
holder. An operator with host access can replace executables, relay responses or
read key material. The existing re-exec mechanism preserves the signing key, so
it does not identify a unique PID. After re-exec, the original environment can
remain readable through Linux `/proc/<pid>/environ` even after the variable is
removed from the process environment. Protect host/process access accordingly.
Signed startup claims also do not independently prove the process's actual S3
traffic or storage-account identity.

## Qualification boundary

The receipt compares all 179 native inputs with a fresh five-patch application
and the packaged source, and all 57 production JavaScript files with the runtime
image. The actual release build uses fat LTO and runs nine native Rust tests (five new and four adapted),
all-target checks and Clippy with warnings denied. The upstream internal Rust
suites are not executed. Local packaging reuses a pinned dependency layer after
checking its unchanged manifests; the receipt describes the separate host-cache
Cargo runner rather than claiming compilation inside the artifact image.

The native drill verifies a second real S3 origin with the same bucket/prefix,
forged known-key refusal, complete live leases for commands, guarded bootstrap,
nonempty unchanged bucket inventories during refusal checks, and seven retained
volumes after cleanup. It runs no scheduled application. Earlier cron lifecycle
receipts use another binary and do not qualify this one. Follow the
[caller policy](../cron-runtime-policy.md) for bootstrap and command distinctions.
