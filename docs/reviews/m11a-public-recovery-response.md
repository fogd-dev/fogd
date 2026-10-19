# Canonical recovery probe review response

Claude reviewed the recovery probe and shared helper and found no blocking
correctness issue. The completed run subsequently passed; the review's statement
that evidence was still in progress describes its inspection time.

- The result-row assertion tests the app's database idempotency, including its unique
  key and conflict handling. It does not prove an external effect executes once.
  Added a bounded attempts assertion (one or two for two submitted messages); the
  recorded run has one attempt. Kept the completed-job early-return behavior.
- Removed the unverified `ordinaryCliArtifact` boolean. Evidence now records the
  active deployment ID/digest. Its ID was checked against `retriedPinnedApproval`
  in the preceding public-history evidence, whose probe uses the normal scoped CLI.
- Corrected the `down` comment: containers and network are removed, volumes retained.
  This frees a Docker address pool for the fresh target; stopped project networks
  retain address pools even though they release host ports.
- Documented the required disposable fixture and restored Compose selection.
- Retained the optional job inspection for existing helper callers. Defaults remain
  the same; both private and public recovery now require the queue to fully drain.

The subsequent browser probe connects Chromium directly through workerd with a
local hostname resolver rule, rather than intercepting requests to private celld.
It passed submission, reload, retry and result checks. This browser addition was
locally inspected and executed; it was not part of Claude's review brief.
