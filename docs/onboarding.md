# Fresh-agent onboarding qualification

**M7a passed its fresh-agent onboarding gate on 2026-10-16.** A separate agent
completed the documented automated guestbook workflow without author hints or
product/documentation fixes. Human feedback remains optional; this result does
not establish human usability or manual admin-UI onboarding.

## Test conditions

| Item | Recorded condition |
| --- | --- |
| Participant | `gpt-6-luna`, low reasoning, fresh conversation with no inherited history |
| Revision | `24359a8` |
| Starting material | README, followed by linked user-facing guides; no implementation inspection or prior reports |
| Checkout | Clean local clone, without installed dependencies or generated project state |
| Application state | Separate Compose project `fogd-onboarding-r1`, fresh volumes and generated credentials |
| Shared environment | Existing macOS host, Docker, Node, pnpm, package cache, and Docker image/build cache |
| Author assistance | Environment/safety constraints and an assigned project name only; no procedural hints during the run |
| Objective | Install, start, deploy/approve guestbook, create a message, update the app, and verify retained data |

The participant could execute documented scripts and read/edit example application
source. It could not repair the product or inspect implementation internals to fill
missing instructions. This was isolation of checkout and application state, not an
operating-system security sandbox.

## Observed workflow

The participant selected the automated qualification path linked from README:

```sh
pnpm install --frozen-lockfile
COMPOSE_PROJECT_NAME=fogd-onboarding-r1 pnpm exec fogd up
PLAYWRIGHT_BROWSERS_PATH="$PWD/.fogd/browsers" pnpm exec playwright install chromium
COMPOSE_PROJECT_NAME=fogd-onboarding-r1 PLAYWRIGHT_BROWSERS_PATH="$PWD/.fogd/browsers" node scripts/fullstack-smoke.mjs
COMPOSE_PROJECT_NAME=fogd-onboarding-r1 docker compose ps
```

Every command succeeded. The qualification script rejected the first submission,
approved a release, created a message through the browser, generated an additive
schema/page update, approved the new release, verified retained data, and restarted
the controller and workerd. The participant reported no failures, missing
instructions, or assistance. It reported approximately 77 seconds from its first
logged command through the stack check; warm caches make this unsuitable as a
fresh-machine setup-time estimate.

After the participant finished, the author independently verified that the generated
credentials differed from the original stack and did not appear in the command log.
The controller showed rejected, superseded, and active submissions. The live API
returned both first-release and second-release messages with the migrated `visitor`
label. These checks corroborate completion; they were not assistance to the agent.

The ignored local evidence is under
`.fogd/onboarding/run-1/.fogd/onboarding/`: `run-1.log` contains command output and
`run-1-report.md` contains the participant's report. The test checkout remained clean. After recording the result, the disposable
Compose project and its volumes were removed and the original local stack resumed.
The participant's report says browser qualification covered the workflow; approvals
actually used the controller API through the documented script, not manual admin-UI
interaction. No claim of manual UI onboarding follows from this test.

## Gate for later runs

Give a new agent a clean checkout and fresh application state, the README entry
point, the objective, and environment/safety constraints. Allow documented
automation; record whether it replaced manual steps. Do not provide author hints
or let the agent repair missing instructions through implementation inspection.
Record commands, outcomes, failures, and assistance. If the documentation needs a
fix, rerun with a fresh agent after the fix. Human feedback can supplement this
qualification without becoming a dependency for progress. See
[ADR 010](decisions.md#adr-010-use-fresh-agent-onboarding-as-the-reproducibility-gate).
