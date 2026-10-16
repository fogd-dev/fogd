# Compatibility goals and evidence

**Discussion draft.** Aim for portable application behavior on owned infrastructure,
with explicit differences and tested lifecycle guarantees. “Full Cloudflare
compatibility” needs a bounded definition before it can guide engineering work.
The proposed target includes the supported Void SDK experience and the Workers
application platform used by selected scenarios. It does not cover every Cloudflare
networking, security, media, or commercial product. See the [vision](vision.md) for
the product purpose; compatibility is one of its promises.

## Separate the promises

| Dimension | Proposed question to answer | Evidence needed |
| --- | --- | --- |
| Source and configuration | Can this project build and declare its resources without rewriting application logic? | Pinned fixture apps; config import/preflight tests; explicit rejected keys |
| Full-stack SDK experience | Do supported Void features compose from typed UI/API code through local development and deployed pages? | Type checks and browser flows covering rendering, assets, resource APIs, app authentication where promised, and an update |
| API behavior | Do calls produce the promised results, errors, metadata, and streaming behavior? | Contract tests linked to official documentation and upstream source |
| Lifecycle and failure | Does acknowledged state survive the stated failure model, and what happens on deploy/retry/reconnect? | Fault injection, deployment/event admission tests, recovery drills |
| Developer workflow | Can a developer inspect, submit, debug, and migrate an app without operating infrastructure? | Scenario tests through the supported CLI and UI |
| Control plane | Which deploy/routing/identity/resource operations does fogd provide? | Tests of fogd's own contracts; do not imply Cloudflare REST API compatibility |
| Operations | What availability, capacity, backup, and recovery properties are actually demonstrated? | Measured drills on the declared topology and documented limits |

Passing configuration validation proves only the first step. A method with the same
name is insufficient if retry, ordering, persistence, isolation, or error behavior
changes the application's meaning. Keep a per-capability status for each dimension;
do not turn a percentage of recognized binding names into a compatibility score.

## Proposed application profiles

Profiles group useful application scenarios. A release can support one profile
while retaining gaps in another; the profile names are proposed, not current claims.

| Profile | User outcome | Principal scenarios | Boundary |
| --- | --- | --- | --- |
| Web application | Pages, assets, sessions, records, attachments, ordinary updates | U1–U4 | Qualify current D1/R2/DO path and app-auth choices first |
| Recoverable team hosting | Approvals, scoped access, incident diagnosis, verified restore, owned hosts | U2, U4–U6, U9 | Required before describing the stack as dependable hosting |
| Background application | Imports, scheduled tasks, durable long-running work | U7 | Event activation, retries, drains, and idempotency are release gates |
| Collaborative application | Live sessions and reconnectable shared state | U8 | Socket continuity is distinct from durable state preservation |
| Portable Workers application | Bring supported non-Void Workers projects and compose applications | U10 | Explicit loader/config adapter and service/RPC semantics required |

The upstream audit in [compat.md](compat.md) remains the inventory. The current
support table in [features.md](features.md) remains the product truth. Profiles and
the roadmap must never upgrade either table until implementation evidence exists.

## Routes to broader compatibility

| Work class | Examples to investigate | What completion means |
| --- | --- | --- |
| fogd adapter and lifecycle work | KV; admission of Queues/cron/Workflows; additive resources; project import | Native upstream behavior passes contract plus scenario tests through fogd |
| Upstream gaps or fixes | R2 multipart recovery; specific Node/RPC/session differences | A minimal reproduction, explicit limitation, and an upstream fix or clearly tracked patch |
| Additional self-hosted services | AI inference, connection pooling, analytics, mail delivery | Service operation plus a documented compatibility contract; no silent hosted fallback |
| Platform behavior we own | Approval, identity, previews, placement, audit, resource lifecycle | Useful fogd workflow; matching Cloudflare provisioning endpoints is a separate decision |
| Properties outside the hardware promise | Global edge footprint, provider-managed capacity and identical hosted quotas | Document the difference; do not label a two-host alternative equivalent |

These are investigation classes, not estimates that the work is easy. An AI client
shape does not reproduce model identifiers, model behavior, streaming, or provider
quotas. A database proxy does not establish Hyperdrive semantics. Dynamic worker
loading does not establish the Workers-for-Platforms namespace contract.

## Evidence without Cloudflare calls

Use official published contracts, pinned upstream source/tests, offline fixtures,
and fogd integration/failure tests. workerd or Miniflare may provide useful local
comparators, but only for behavior they actually implement; neither is automatically
an oracle for hosted D1, Queues, R2, or distributed failure semantics. Mark behavior
that cannot be verified offline as documented or unverified, not hosted-tested.

For example, Cloudflare Queues documents at-least-once delivery. A fogd scenario
must tolerate duplicate delivery and test its idempotency contract; it should not
invent an exactly-once guarantee. Workflows also has explicit retry/sleep behavior
that belongs in contract tests. Sources: [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
[Workflows retries and sleeps](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/).

Each capability needs a record containing the target version/date, supported
methods/options, semantic differences, failure expectations, isolation boundary,
contract/scenario test links, and unresolved upstream issues. Run the relevant
suite before runtime upgrades and keep upgrade results with the pinned revisions.
Cloudflare's [binding catalog](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
provides inventory input, not a promise that each item belongs in the first release.

## Admission rule

A new capability becomes supported only after the product scenario, resource/secret
ownership, activation behavior, failure/retry semantics, resource limits, and test
evidence are defined. Preflight should reject unsupported behavior before deployment
and distinguish an upstream gap from a fogd adapter restriction.

Background execution deserves a separate activation design before any parser
allowlist change. Preview environments must also isolate state, credentials, and
external effects, not only use another hostname. Neither mechanism is implemented
by merely pausing workerd's HTTP route.
