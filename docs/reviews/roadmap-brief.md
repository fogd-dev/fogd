# fogd product and compatibility roadmap review brief

Status: discussion input, not an implementation decision. The user wants independent
Gemini and Claude recommendations, documented product/user scenarios, and a roadmap
toward as much self-hosted Cloudflare compatibility as is practical. Do not start
the next large implementation until this discussion has happened.

## Existing product and constraints

fogd v0 is implemented in this repository. Read `docs/report.md`, `docs/features.md`,
`docs/compat.md`, `docs/platform.md`, and relevant code before recommending work.
It builds Void apps locally, submits immutable artifacts, requires admin approval,
runs each entire app in a two-replica celld fleet, and uses workerd for ingress.
MinIO is the bucket backend. Two fixed app slots, shared team deploy token, Basic
admin auth, stable replica IDs/disks, paused activation, and authoritative SQL
migration reconciliation are current choices. Two sample apps and failure/restart
checks pass. Source pins and qualifications are documented; full fidelity is not claimed.

The user owns the hardware. Docker local development comes first; a two-node homelab
is the intended next deployment environment. Preserve a self-hosted path: no
Cloudflare credentials or API calls, no npm publication, no global host changes.
Any patches to upstream should be explicit and suitable for upstreaming. We do not
promise hostile tenant isolation. The current plan is open to challenge where
source/runtime behavior or product needs justify it.

The user's exact new request: "can we peer-review with gemini and claude and see
what they think we should build next? we should keep working on improving this and
probably need a roadmap to full (or as full as we can get) cloudflare compatibility..
and we should have documented use-cases and scenarios we want to support
(product/user focused). help me hash all this out before we start on the next
large chunk of work"

## Review requested

Give your independent recommendation, not a code style review. Ground findings in
this checkout and pinned upstream sources where useful. Do not edit files, change
running stacks, access credentials, or call external service APIs. Avoid exhaustive
upstream scanning; inspect specific files to resolve a concrete question.

1. Define the product promise and intended users. Separate app developers, deployment
   approvers, operators, and end users. Identify assumptions needing user validation.
2. Propose 6–10 concrete user scenarios with success/failure expectations: real app
   launch, app changes, approval/rejection, background work, real-time interaction,
   incidents/recovery, app growth, and any better scenario you identify. Prioritize
   by user value; do not present binding names as use cases.
3. Define practical compatibility tiers. Distinguish source/config acceptance,
   observable API semantics, lifecycle/failure behavior, platform/control-plane
   compatibility, and operational properties that two owned hosts cannot duplicate.
   Identify likely upstream gaps vs adapter work vs a dedicated service/fork.
4. Recommend a sequenced roadmap with exit criteria and dependencies. Explicitly
   compare: operational reliability/backup/identity first; broader bindings first;
   homelab deployment first; larger architectural changes (dispatch/resource model).
5. Pick ONE coherent next milestone with a measurable user outcome, included/excluded
   scope, acceptance scenarios, and a short list of decisions for the user. Explain
   the opportunity cost and what evidence would change your recommendation.
6. Flag architectural traps: immutable resource declarations, identity+volume coupling,
   background events bypassing HTTP pauses, rollback/schema safety, runtime API vs
   backend fidelity, cross-app services, resource isolation, bucket/controller failure,
   and conformance testing without Cloudflare API calls. Do not claim a generic
   local surrogate is a hosted Cloudflare correctness oracle.
7. Offer a product-focused alternative if your recommendation assumes the wrong users.

Please stay concise enough to compare the reviews (roughly 1,000–1,800 words), cite
specific files for material claims, distinguish verified behavior from proposals,
and avoid invented dates or precision in effort estimates.
