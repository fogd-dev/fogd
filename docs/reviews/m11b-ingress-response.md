# Non-owning ingress review response

The initial close-on-kill test could not rule out the owner reacting to peer loss.
A direct-owner control socket now sees revision one before the kill, stays open,
sees revision two after browser recovery and answers an explicit semantic rejection
probe. The browser's selected socket must close within five seconds of ingress
kill with code 1006. The control connection, rather than that close code alone,
supplies the evidence that the owner remains available.

The selected socket must have opened after the new gateway process started and
remain open immediately before the kill. Owner and workerd start times must remain
unchanged. The ingress remains stopped with the same start time after acknowledgment.
Runtime state identifies the owner immediately before the kill and after recovery.

Cleanup attempts every step independently and runs Compose operations sequentially.
It removes the private override, stops the control connection, restarts the ingress,
waits for health and restores the original gateway. Manual recovery after signal
interruption is documented in the example guide. The control process has a bounded
lifetime and removes its state file on normal stop.

The follow-up review accepts the strengthened evidence. Its suggested revision-two
assertion, close-latency bound, scope correction and cleanup ordering are included
in the final passing run at `.fogd/m11b-ingress-qualified`. The public record contains
only the selected evidence, not the private Compose configuration.
