# Native imports qualification review response

The [Claude review](m11a-native-claude.md) identified a false-positive risk in the
first crash probe: its delay exceeded the handler budget. That run does not qualify
kill-caused exhaustion. The revised probe uses a 12-second delay below the
20-second budget, first completes an identical-delay control, records observation
and stop times, and requires prompt interruption. Exhausted work must have a null
error as well as unfinished status, proving neither attempt recorded a failure.

Accepted assertion improvements: enqueue duplicate work while paused and verify
both messages settle with one processing attempt; require zero attempts before
resume; require one attempt per old/new migration job and an empty settled queue;
assert the full Void consumer policy at staging. Uploads now use unique directories
so stale files cannot merge into a later staged release. The guide specifies probe
order and the v2 dependency.

The native example intentionally uses explicit retry as reconciliation. Automatic
stuck-job detection and sweeping remain product work, not a claim of this fixture.
Fault-injection options clear on retry; real application input remains immutable.
The existing build environment filter was extracted without changing its policy.
It is not a sandbox: local application builds execute with the developer's file
access, including readable environment files. A hosted untrusted build service
would require a separate isolation and credential policy.

The reviewer also suggested offline tests for native queue policy and additive
migration. Exact emitted-policy checks and the live old/new handler probe cover
those semantics here. No hosted Cloudflare execution or queue admission is enabled.
The browser probe added after review checks page reload against the real private
backend through a test transport, without making a gateway-routing claim.

The [follow-up review](m11a-native-final-claude.md) found no remaining blockers
in the fixes. Its additional browser suggestion is implemented: the saved job must
record two attempts, not merely finish. The revised initial, additive-update, and
crash probes passed on a fresh second fleet. Committed evidence uses that run,
including the successful control and both stop timings; the superseded 30-second
crash run is not used as qualification evidence.
