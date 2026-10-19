# Physical failure review response

All three blocking findings have corresponding assertions and passing evidence.
Docker inspection verifies the killed target is stopped immediately after SIGKILL;
for the owner leg it is still stopped after the next acknowledgment. A direct read
of the survivor's runtime state then verifies the room is resident and published
there before the original owner restarts.

Each leg records kill initiation, the first subsequent close (required), native
open events, the first subsequent authoritative snapshot (required), and the time
the new acknowledgment is observed. The documentation distinguishes snapshot
recovery from acknowledgment latency. The fresh-snapshot assertion prevents the
old Connected label from satisfying the recovery gate.

The single new resident candidate must occur exactly once across both nodes. The
fixture requires no concurrent clients; this probe does not derive the opaque cell
ID from the room name. Evidence includes workerd's configured image and explicitly
states that the owner leg's ingress is unknown and may equal the owner. A separate
non-owning ingress test remains open. Removed the redundant visibility assertion
after owner restart; no claim that the original owner resumes serving this room.

The strengthened run passed at `.fogd/m11b-process-reviewed`; public evidence is
[the process failure record](../evidence/m11b-process-failure.json). Earlier runs
remain local diagnostic evidence and do not supply the published qualification.
