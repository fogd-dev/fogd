# Platform review response

Claude and Gemini completed independent source-grounded reviews with 15-minute
limits and streaming progress. Their original responses and the original proposal
are preserved beside this response. Both selected the custom deploy gate.

Accepted: fixed slot prefixes; conditional bucket ownership fences; validation of
all uploaded paths, identifiers, nested config, and exact artifact digests; rejection
of client release metadata; static workerd service bindings; digest plus CSRF on
every admin mutation; and durable activation checkpoints with explicit retry.

Migration recovery reconciles celld's applied ledger against the attempted immutable
artifact before accepting another release. Applied hashes remain immutable; failed,
unapplied SQL can be corrected. If reconciliation is unavailable, activation stops.
Lost controller metadata quarantines occupied slots instead of reassigning them.

The reviewers differed on when to pause an existing route. Choose the conservative
sequence: persist paused before any migration or publication. Failures stay paused
until explicit admin retry succeeds. This avoids an assertion that arbitrary approved
SQL is backward compatible and makes outage behavior predictable. No route cache:
a controller outage is 503. Slots are single-app trusted-code boundaries, not a
hostile tenant sandbox. Shared local bucket credentials remain a documented gap.

The controller authenticates every API; no unauthenticated control endpoint is
available to fleet networks. Network membership alone is never authorization.
Additional interface filtering is deferred because trusted code and separate API
credentials are the explicit v0 boundary. No Docker socket is mounted.
