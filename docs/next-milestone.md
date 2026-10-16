# M7a: one complete Void app, twice

**Implementation qualified locally; independent onboarding remains open.** Demonstrate Void's full-stack developer
experience on fogd through two releases of one local application. This advances G1
and G3 in the [vision](vision.md), starts G4 portability evidence, and qualifies part
of scenarios U1/U2/U4. It does not establish shared production hosting or complete
support for every Void feature. The [guestbook guide](../examples/guestbook/README.md) reproduces the implemented
qualification; [report.md](report.md) records results. The original proposal is
preserved in the vision review snapshot.

## Scope and defaults

Use one small native Void React `pages/` fixture (not a separate React Router
framework adapter) with a browser UI, client assets, a typed
server route, and one D1 table. React is a reversible test-fixture choice, not a
platform-wide framework restriction. Confirm the pinned starter and tooling before
implementation; if that path is incompatible, document the failure and choose the
smallest upstream-supported alternative.

Use localhost and disposable fixture data. Retain exact-artifact approval; a solo
operator may submit and approve using the existing separate roles. Do not add an
approval bypass. App authentication and private configuration belong to M7c. Named teammate
identities, TLS/DNS, backups, and remote shared operation belong to M8/M9 before
sharing valuable data.
A second developer can run the same local procedure without needing infrastructure
access to the author's machine.

## Acceptance conditions

| Requirement | Validation |
| --- | --- |
| One source tree supports the normal Void local loop and fogd deployment | Run the fixture's documented development workflow and the fogd deployment workflow; compare supported route/data behavior; record backend/config differences |
| Void's typed client and server paths remain connected | Type-check a UI change against the route/data contract; a deliberately incompatible client use fails compilation; the deployed browser flow returns and renders the expected data |
| Rendered pages and client assets work through fogd | Browser test covers initial navigation, asset loading/hydration where applicable, record creation, and reload |
| A second release preserves data | Apply an additive SQL migration and UI/API update; verify existing and new records after approval; the migration is not replayed after an interrupted activation |
| Approval remains authoritative | Pending/rejected artifacts are unreachable; the approved digest is the active release; test the browser flow against that release |
| Submitters can diagnose their submission without admin credentials | Inspect status and a bounded failure reason for an authorized submission; unauthorized access is rejected; no runtime/admin credentials appear in the response |
| Portability work begins now | Produce the offline managed-target build from the same app logic with network access disabled during the build; record configuration and bundle differences; mark hosted execution unverified |
| Results are reproducible | A second developer follows the written steps; record setup/update steps, assistance, and failures rather than assuming an effort reduction |

Reuse existing migration fault tests where they cover the required behavior. Add
new tests only for newly qualified paths. Type correctness is a build-time check;
browser and HTTP tests separately establish deployed behavior.

## Constraints and implementation questions

The current adapter disables code splitting only for the native `void_worker`
environment, rejects required-secret declarations, resolves migrations separately,
and blocks reserved runtime routes at ingress. Preserve and document those boundaries
unless evidence supports an upstream-compatible change. Do not promise arbitrary
Vite chunks, all framework adapters, or access to reserved migration handlers.

A read-only submitter status path needs explicit authorization and redaction. Choose
the smallest interface that reveals only authorized deployment information; do not
turn this milestone into a platform identity rewrite or unrestricted log streaming.

HTTP route pause does not drain existing requests or Durable Object alarms. This
fixture uses backward-compatible SQL and no background events. Future admission of
background work or incompatible migrations requires a stronger lifecycle design.

No new binding families, resource renames/deletions, Kubernetes packaging, general
rollback, Filecoin integration, or Cloudflare API calls belong in this slice. A
logical data export fixture follows as part of M7b, not as a generic migration tool.

## Following slice

M7b qualifies one compatible resource addition, such as adding file attachments,
without abandoning existing records. It includes the required export/restore fixture
for that supported data profile. This addresses ordinary app growth before a shared
pilot; retirement and capacity reuse remain separate. M7c qualifies required secrets and a native Void auth path. M8 establishes
recovery and platform access controls needed for shared installations. See [roadmap.md](roadmap.md).
