# Vision and roadmap review response

**Keep the vision; narrow the next implementation.** Claude and Gemini both support
the separation between product purpose, Void's developer experience, runtime
capabilities, and candidate pilots. Both find the original M7 too broad and resource
growth too late. The revised roadmap splits M7 into full-stack qualification,
resource growth, and private configuration/app identity before shared hosting.

This is a planning result, not authorization to start a new implementation. The
user's enthusiasm establishes the vision as the planning anchor; proposed defaults
and milestone scopes remain reviewable.

## Evidence and review record

The [frozen brief](vision-brief.md) includes the exact vision, roadmap, scenarios,
compatibility policy, and prior triage presented to both reviewers. Read the
[Claude review](vision-claude.md) and [Gemini review](vision-gemini.md) separately.
Both external CLIs completed successfully with read-only repo inspection and
streaming output under a 15-minute deadline. Gemini took more than five minutes;
progress was verified during execution. No private infrastructure or Filecoin
research formed part of this round.

## Accepted changes

| Recommendation | Result |
| --- | --- |
| Preserve the broad north star and name Void's benefits | The vision retains the user's preferred wording; it names full-stack composition and the generated contracts that need qualification |
| Distinguish fogd from unmodified Void Platform | The vision explicitly says fogd currently replaces the deployment backend; it does not claim upstream roles, usage reporting, or full feature parity |
| Make the next slice smaller | M7a proposes one native Void React pages fixture, typed client/API/D1 behavior, two local releases, deploy status, and an offline target build |
| Move resource growth before a shared pilot | M7b qualifies one compatible addition and a bounded logical export/restore fixture; retirement remains separate |
| Treat private configuration/auth as real SDK integration work | M7c names required secrets and native app-auth migration behavior, separately from platform identity and infrastructure access |
| Begin portability immediately | M7a's exit gate includes an offline second-target build; M7b begins logical data evidence; broad import tooling remains later |
| Start recovery with a consistent stopped/quiesced procedure | M8 should first prove a documented cold recovery point and fresh-storage restore; it does not promise live snapshots |
| Keep background and collaboration qualification separate | M11 has separate event-lifecycle and live-session gates; existing DO alarms are included in the event contract |
| Use a decision filter | Each admitted idea needs a goal/scenario, reduced manual work, maintenance ownership, test evidence, and baseline/portability compatibility |

Gemini identified four useful Void integration contracts: source-inferred bindings,
typed clients, validated environment schemas, and SSR/pages asset manifests. The
relevant source is pinned in [compat.md](../compat.md). Local inspection confirmed
that [artifact validation](../../packages/runtime/src/artifact.mjs) rejects nonempty
`secrets.required`, [build configuration](../../packages/cli/src/build.mjs) adjusts
only `void_worker`, and [HTTP authorization](../../packages/platform/src/http.mjs)
does not currently provide submitter-readable deployment status. These are gaps
to address, not proof of supported browser/auth behavior.

## Recommendations not adopted as written

Both reviewers suggest an optional approval shortcut for solo operators. Keep the
current exact-artifact approval default. The original user requirement explicitly
values admin control, and a solo operator can fill both roles. Approval ergonomics
can be measured later; no bypass or new mode belongs in M7a.

Gemini's smallest-slice recommendation still combines UI, secrets, auth, and several
bindings. Split that scope rather than immediately admitting all of it. Preserve
Void's native auth as a later qualification goal instead of claiming a hand-built
session implementation proves the same experience. App authentication and platform
identity are separate concerns.

Do not adopt universal numbers from the review. Recovery must meet a declared
checkpoint/loss boundary; a periodic backup cannot guarantee every later write.
Compatibility coverage is measured against a stated profile, not a percentage of
the entire Cloudflare ecosystem. Zero application-source changes is a proposed
fixture test; target configuration differences remain documented.

The review's contrast with container hosting overstates manual work: Coolify also
automates database deployment. Measure actual author/operator steps before claiming
an advantage. Neither a homelab nor Kubernetes is inherently the cheaper second
target; choose based on available operators and infrastructure.

Several review comments treat future acceptance conditions as existing promises.
The vision and scenarios explicitly describe goals. Current status remains in
[features.md](../features.md) and [report.md](../report.md). In particular, private
application secrets are not supported through a dedicated secure injection path;
plain `vars` are not a secret store. No current credential-isolation guarantee is
inferred from the proposed U2 acceptance condition.

Native compute and customer extensions remain possible long-term exploration,
not near-term scope and not reasons to change the vision. Preview isolation needs
resource and effect boundaries; it does not inherently require a dynamic scheduler.
The first preview design, if justified, could use bounded preallocated capacity.

## Proposed defaults and open design work

The [M7a proposal](../next-milestone.md) chooses native Void React pages, localhost,
disposable data, and existing approval. These reversible defaults resolve the
review's starter/access questions without narrowing the platform to one framework.
Record operator effort and per-app resource use during later installation drills.

Before implementation, confirm the pinned starter/build behavior and design the
submitter-status authorization boundary. M7c needs a separate secret lifecycle and
auth-migration contract; don't expose internal migration endpoints to solve it.
M8 needs a recovery contract covering required metadata, bucket data, replica
identities/logs, and reproducibly generated routing configuration. M9's environment
selection remains conditional on pilot/operator readiness.

The strongest exploration candidates are local development parity, actionable
preflight/portability diagnostics, and reproducible installation/recovery artifacts.
These reinforce G1–G4 without creating a separate app-generation or storage product.
Filecoin remains a deferred possibility with no integration design in this roadmap.
