**Verdict: no blocker.** I inspected the amended refusal set, controller guards, CLI retire/restore/volumes, both qualification scripts, and the added tests, read-only. The implementation matches the amended response document, and the scripts test what the evidence claims say they test. I make no claim about fixture 3.

**Confirmed against the amendments**

- `retirementApp` now admits route active or paused, still requires a known `active` deployment with status active, no quarantine, null uncertain, and no activating request. Never-activated and ambiguous apps fail closed (`packages/platform/src/retirement.mjs:21`). The paused case is covered in the platform unit test.
- `retireState` marks pending, failed, and the former active deployment retired, and the tombstone keeps digest and deployment id. The response doc now says this, so the earlier spec deviation is closed.
- Mutation guard precedes the status check and reject branch; submit, approve, reject, secrets, and credential issuance all hit `assertLiveName`. Non-array credential scopes fall through to `credentials.issue`, which rejects them anyway.
- Retired prefix and node identity changes touch only the two replica services. `FOGD_SLOTS` `nodes` are hostnames used by the gateway and readiness probe, and the plan leaves them alone while rewriting `CELLD_NODE`, so the freed fleet still resolves. The generated prefix satisfies `main.mjs` slot validation.
- Added tests exist as claimed: historical prefix overlap and malformed tombstones in the CLI plan test, HTTP approve and secrets PUT refusal in the platform test, corrupt skipped replica tar rejected via `verifyBundle` before any Docker call. Capacity copy updated.
- Scripts: fixture 1's cause is fixed. Backup and all retire calls use the pre-token operator env, and the browser check waits for an actual accounts HTTP 200 before driving the page. The negative wrapper matches the exact controller volume mount and tar extraction string, falls through everything else to the real binary via execv, and the group kill works because the child is detached. Same-target retry hits `requireFresh` before `mkdir`, and the old-image probe runs before `compose create`, so the asserted "no containers" holds. If the wrapper never matches, the poll fails loudly rather than passing.

**Minor, not blocking**

1. `docs/retirement.md:82` says the negative script interrupts "after one archive copy." The volume order restores bucket first, then controller, and the wrapper pauses after the controller archive. Say "after the controller archive copy."
2. In the optional old-bundle path, images load and the output directory is created before the capability probe refuses. The script only asserts no containers and no compose.json, which is accurate, but the leftover directory is worth a sentence in the doc or the receipt-less convention note.
3. Top-level test count in platform plus CLI is 54 by grep. The stated 70 presumably spans the whole workspace. Not a contradiction, just make sure the evidence log names the scope.

Nothing in the evidence claims overreaches into erasure or in-place retirement. The remaining drill-only assumptions from the previous review (host tar member naming, celld bootstrap on an empty prefix, no cached gateway route) can only be closed by the fixture 3 log.