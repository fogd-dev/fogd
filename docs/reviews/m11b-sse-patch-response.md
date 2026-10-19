# SSE patch review response

Both code reviews approve the server logic. The final review also independently
reproduces the generated installed file byte-for-byte and confirms that topic
registration serialization cannot deadlock with its bounded `/check` callbacks.
The patch note records the resulting queueing cost at full topics and the uncertain
state after control errors.

The installed JavaScript is the default regression target, its resolved path is
printed, and the suite imports the real module before testing the modelled seams.
The generator checks the source revision and diff against the retained patch and
rejects missing packaged imports. Twelve tests include a registration held during
publication/unsubscribe and competing capacity checks; the latter now waits for
the second request to reach transport before releasing the first check. A negative
control without the registration chain still admits two rows into one slot.

The browser update probe records successful control responses and requires the v2
snapshot after the post-error reopen and registration response. Its final passing
record supplies the evidence that was not yet available when the review began.
The checked runtime setting is five seconds; no cancellation-latency guarantee is
made. The nested original-socket WebSocket update test also passes.

Upstream's 25-test live-server suite, package typecheck and full lint pass. Terminal
exit statuses, rather than quiet log banners alone, are recorded in the evidence.
The initial typecheck needed the upstream workspace dependencies built first.
Fault probes identify the checklist's class specifically because live notification
objects also appear in runtime residency. The updated owner/gateway loss and idle
checks pass with both classes present.

SSE stays experimental pending a real publication-failure drill and cross-app SSE
isolation. Modelled registration tests are not represented as proof of celld's
scheduling semantics or generalized background activation.
