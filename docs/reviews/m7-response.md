# M7a review response

Claude and Gemini independently reviewed the implementation and both recommended
approval with targeted fixes. Their original [brief](m7-brief.md),
[Claude findings](m7-claude.md), and [Gemini findings](m7-gemini.md) are preserved.
Both processes exited successfully with final review responses. Claude completed
in about eight minutes and Gemini in about ten; the commands had 15-minute limits
and produced file-inspection events throughout.

## Accepted findings

| Finding | Resolution |
| --- | --- |
| Unfiltered worker output can upload preview secrets and unused host-path config | Stage only the JavaScript entry and Wasm files celld loads; test that preview secrets, maps, and raw config stay out of the artifact |
| Asset defaults omit `.dev.vars` variants and can be negated | Enforce secret-file and OS metadata exclusions independently of user ignore patterns; test negation and nested files |
| Asset ignore rules can discard celld metadata | Preserve root `_headers` and `_redirects` even when ignored as public assets |
| Asset privacy only tested before upload | Check excluded paths return 404 through workerd/celld after approval |
| Worker output options overwritten | Preserve existing output settings while forcing a single output; this was corrected during the review |
| Symlinks rejected even when ignored | Document the stricter artifact boundary |
| Two target builds overwrite the evidence | Snapshot both outputs, print their config/file differences, and stage the fogd artifact offline |
| Offline verification relies solely on the run command | Require a container with only loopback network interfaces before verification begins; execute with Docker `--network none` |
| Browser test can race hydration after reload | Reuse the read-only client readiness check after both navigation and reload |
| History check no longer verifies migrated data | Remove SSR comments before asserting the rendered default label and original message |
| CLI status exit code does not prove its output | Parse the JSON and assert active status, completed step, null error, and exact approved digest |
| Admin diagnostics retention and local secret-file hygiene | Assert raw errors remain admin-visible, ignore `.dev.vars` variants in Git/Docker, and remove the nonexistent TypeScript include |

## Boundaries retained

Workflow reproducibility does not mean byte-identical builds across machines.
Removing unused host-path config reduces unnecessary artifact disclosure, but
neither the tests nor the report promise deterministic builds across toolchains.
Independent teammate onboarding remains unverified.

The asset policy deliberately goes beyond upstream negation semantics for secret
files. [ADR 009](../decisions.md#adr-009-stage-runtime-modules-and-enforce-secret-file-exclusions)
records that tradeoff and the loss of uploaded worker source maps. The team-token
status boundary remains shared; individual ownership and secret injection belong
to later milestones. These are author-applied fixes following the reviews, not a
claim that the reviewers reran the final tests.
