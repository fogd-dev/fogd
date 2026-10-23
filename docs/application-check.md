# Request an application through its gateway

`fogd check` sends one owner-requested GET through an enrolled installation's
gateway and reports its HTTP status and time to response headers. Choose a public
application path deliberately: a GET executes application code and can have side
effects. The command has no default path.

```sh
fogd check guestbook --installation YOUR_PROJECT --path /health
```

Use Docker-owner access, the installation's private enrollment files, and its
cached qualified runtime image. The command selects that installation directly;
`FOGD_SERVER` and deploy credentials do not select or authorize the request.
The implementation supports the qualified legacy Docker layout. Native acceptance
of this command remains open; host tests use temporary HTTP/TLS servers and a
mocked Docker boundary. It does not qualify another runtime or topology.

## Read the result

`ingressResponse.state: observed` means the selected gateway returned response
headers while its inspected process and the selected controller record matched at
the observation boundaries. `httpStatus` includes redirects and error responses.
`headersMs` measures connection, TLS when enabled, and receipt of response headers
from inside the gateway's Docker network.

An observed 503 is a response to investigate, not a successful health check. A
response can come from the gateway itself. `applicationExecution: not-proven`
and `applicationHealth: not-observed` describe that boundary: no particular app
handler, business result, completed response body or durable write is established.
Use [`fogd observe`](application-observation.md) separately for native replica
readiness and [`admin inspect`](application-inspection.md) for recorded activation
and routing state.

`not-requested` means selection or scope checks prevented the networked helper
from starting. Unknown applications refuse. A recorded paused, pending-only,
retired or unresolved application does not receive a request. Pending controller
artifact pruning also prevents a request. Completed pruning does not withhold the
retained active application.
`uncertain` means a request might have been sent but the command could not confirm
its result or observation boundaries. The report withholds sampled status and
timing when those boundaries change. A timeout does not establish that application
execution stopped. No request is replayed automatically.

The command's normal exit means it produced a diagnostic report. It does not mean
the app returned 200 or passed a health policy. Automation must inspect the report.
These reads do not fence deployments or prove the record stayed unchanged between
boundaries. External DNS, the host's published port, an external proxy, browser
sessions, and Internet reachability are outside this network-local observation.

## Paths and TLS trust

Paths use an explicit `/path` without a query, fragment, credentials or URL origin.
The conservative ASCII grammar permits percent-encoded path characters but rejects
malformed encoding, dot segments, repeated slashes, backslashes, controls and
reserved internal routes at every decoded layer. Native health and internal Void
paths cannot be requested through this command. Supply an ordinary public endpoint
owned by the application.

TLS uses the app hostname from the enrolled base domain for both Host and SNI.
Certificate verification remains enabled. For a private certificate authority:

```sh
fogd check guestbook --installation YOUR_PROJECT --path /health --ca public-ca.pem
```

The CA input accepts public PEM certificates only and refuses private keys. It is
bounded and read without following a file link. A CA file requires a TLS
installation; there is no insecure mode. Application credentials, cookies, custom
headers and alternate methods are outside this interface.

## Disclosure and resource policy

The report contains selected release identity, fixed outcome reasons, HTTP status
and header timing. It never contains response headers, body contents, arbitrary
runtime errors or process logs. Redirects are reported without following them.
Response streams are closed after headers; neither a large body nor a stream that
never finishes extends the check. The request has an absolute header deadline.
An unconfirmed result can reflect TLS, connection or helper failure, as well as an
unavailable gateway.

A transient read-only helper joins the inspected gateway network and targets the
inspected gateway address. Before use, the command checks its pinned image, launch
configuration, mounts, network ownership and running state. After the request it
checks the gateway process and controller record again. The helper receives only
the selected address, app hostname, path, TLS setting and optional public CA. It
has no data mounts, Docker socket, storage credentials, owner credentials or app
secrets. Its exact nonce label and name bound error cleanup; an unconfirmed cleanup
fails the command. Existing services and installation storage remain untouched.

This is an explicit request diagnostic. Scoped application logs, authenticated user
journeys and application-specific health assertions remain separate work under the
[operator-readiness contract](operator-readiness.md#3-diagnose-an-application).
