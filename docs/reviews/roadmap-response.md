# Product roadmap review response

**Discussion draft.** Claude and Gemini completed an initial roadmap review and a
product-direction follow-up. Both recommended proving a useful application before
expanding bindings. Their audience rankings differed. Later user input identifies
a concrete team need: developers have demos without an easy persistent deployment
home. That supports a team pilot, subject to application and operational validation.

## Review record

- Initial [brief](roadmap-brief.md), [Claude review](roadmap-claude.md), and
  [Gemini review](roadmap-gemini.md).
- Follow-up [brief](product-direction-brief.md), [Claude review](product-direction-claude.md),
  and [Gemini review](product-direction-gemini.md).

The reviews ran through the external CLIs with streaming output and a 15-minute
deadline; both produced completed responses in both rounds. They did not review the
subsequent team-demo clarification, the private infra repository, or the proposed
Filecoin storage track. Their original output is preserved as review evidence,
including claims corrected below.

## Accepted recommendations

Choose a product scenario before adding bindings. Distinguish app authors,
approvers, and operators. Keep existing approval control while validating a second
developer's workflow. Qualify full browser/asset/auth behavior rather than inferring
it from API smoke tests. Prove backup/restore before placing valuable data here.

Separate source/API behavior, lifecycle/failure behavior, data migration, and
operations. Offline workerd/Miniflare tests cannot establish hosted service
equivalence. Backward-compatible migrations remain necessary while HTTP pause
does not quiesce in-flight requests and Durable Object alarms.

## Corrections and deferred recommendations

| Finding | Disposition |
| --- | --- |
| Team demand is unvalidated | The user subsequently identified a persistent demo-hosting need; actual app fit and adoption still need a pilot |
| Build an integration/benchmark dashboard | Rejected by the user as unenticing; qualify an existing team demo instead |
| Self-hosting has zero marginal cost or no limits | Not adopted; hardware, capacity, electricity, operations, and recovery have costs |
| Kubernetes always requires many per-app backend products | Overstated; compare actual team workflows and Coolify rather than assuming a baseline |
| Rollback is a small controller change | Artifact retention does not establish schema/resource compatibility; design and test the contract |
| Pause HTTP and copy storage for backup | Insufficient; drain/quiesce or a supported checkpoint protocol must cover every writer and required state component |
| Delay event safety until adding new background bindings | Existing Durable Object alarms and in-flight requests already matter |
| Add a generic export command during discovery | Start with a fixture-specific logical export/restore where useful; a generic format needs a separate design |
| Add KV, multi-D1, route caching, slot reuse, and backup together | Too broad for one pilot; each needs an application or operations requirement and its own validation |
| Deploy manifests establish multi-host reliability | Placement, identity, persistent storage, network failures, and recovery need actual drills |
| Prior direct-deploy helper remains a supported workflow | The current default is approval; the separate low-level Compose topology is an operator diagnostic path |

## Proposed direction after user discussion

The first candidate is a team application platform on owned infrastructure, with
the homelab as another installation target. Workers compatibility provides a useful
application contract; migration to Cloudflare need not be the primary purpose.
Coolify is a valid alternative whose broader container support may fit some demos
better. The pilot should test whether a supported Void template and declared
resources remove enough author work to justify operating fogd.

Optional Filecoin application storage and encrypted offsite recovery extend the
ownership goal. They are later design work. The user requested this direction;
neither reviewer has evaluated its storage semantics or encryption/ACL design.

See [product scenarios](../product.md), [roadmap](../roadmap.md), and
[compatibility policy](../compatibility-policy.md). No runtime changes are included
in this planning work.

## Correction after the audience and vision discussion

The earlier synthesis incorrectly promoted a candidate team pilot into fogd's
north star. The user corrected that framing. The subsequent phrase "Workers
programming model" also omitted the full-stack developer experience provided by
Void. The updated [vision](../vision.md) states the broader goal and distinguishes
Void's developer experience, runtime capabilities, portability, and fogd operations.
FilOz is a potential first use case. Filecoin stays a future possibility without
integration design. The next review evaluates the revised vision and capability
roadmap; it does not re-rank audiences as a substitute for product purpose.

The completed next round is recorded in [vision-response.md](vision-response.md),
with its frozen inputs and separate Claude/Gemini outputs. That response supersedes
the audience-first prioritization above while preserving the historical record.
