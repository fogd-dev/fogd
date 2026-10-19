# M11b acceptance audit response

The [first audit](m11b-acceptance-claude.md) identified three closure conditions:
preapproval evidence, publication wording, and current offline builds.

The corrected approval probe passes twice. The final run checks each scoped
submitter, actual allocated slot, exact wrong-digest error, empty deployment and
cell prefixes before approval, native browser refusal, independent HTTP upgrade
404, and the native 101/edit roundtrip after exact approval. Chromium does not
report refused handshake status through the CDP event used here; the raw upgrade
request supplies that status without treating missing browser events as proof.
The original failing run is retained privately; its failure is not acceptance evidence.

[Approval evidence](../evidence/m11b-approval.json) records the final probe source
hash. Cleanup restored the original two-app stack; fresh target volumes remain.
[Offline evidence](../evidence/m11b-offline-builds.json) records five completed
build/staging pairs, the pinned image, source commit and log hash. Networking was
disabled. No hosted Cloudflare execution occurred.

Requirement 6 and the acceptance record distinguish application call order from
network delivery order. Hints follow the committed transaction and native send
call; they may arrive before the acknowledgment. GET output gating is a source
inference. Lower-revision-only recovery and anonymous-fixture limits remain.

The [follow-up review](m11b-closure-claude.md) found all three conditions met and
no new blocker. M11b closes only within the documented local Docker scope.
