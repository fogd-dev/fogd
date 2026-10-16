# M8b2 transport review amendments

Claude's [design review](m8b2-claude.md) supports native workerd and Node TLS with
explicit origin handling. The [original spec](../m8b2.md) remains unchanged.

Both profiles use the same private/public listener split. The private HTTP listener
serves only authenticated routing; the public listener cannot serve internal routes.
The gateway strips every forwarding header and sets scheme/host from its actual
request URL, including the port. All celld commands enable trusted forwarding.
The gateway token remains the private routing authorization boundary; listener
separation alone does not isolate trusted app code from the private Docker networks.

A managed TLS volume is mounted read-only by controller and gateway in the base
Compose topology. Local mode leaves it unused. This avoids a second merge/override
path in every CLI and recovery command; removing TLS support later would remove
that volume and its two optional runtime branches. Recovery admits only this optional
seventh volume and still accepts the original six-volume bundles.

The imported keypair is one atomically replaced private JSON file. Import validates
PEM, key match, and current certificate validity, and requires the project stopped.
workerd copies PEMs into its private runtime directory and uses relative capnp embeds.
The profile guard validates declared host binding; Docker/operator configuration
must still enforce the actual published interface and firewall policy.

The local test certificate uses the host's existing OpenSSL command, writes only
inside a gitignored repo directory, and names fixture hosts explicitly. No wildcard
localhost assumption or system trust-store modification. Node clients use an explicit
private CA; the test browser trusts only the generated server key through a scoped
SPKI exception. The test separately proves Node rejects that CA without opt-in trust.
It checks a native app-generated absolute URL as well as Secure session cookies.

`fogd up --shared` records shared/TLS settings, clears the legacy token, and skips
legacy-token generation. Installed TLS is checked before services start. Local
bootstrap remains available. `FOGD_ENV_FILE` selects an installation-specific private
configuration file for testing and operator use without rewriting other installations.

Upgrade must recreate the replicas with the new trusted-forwarding command before
claiming the new configuration matches running containers. Same-version restore
keeps image IDs pinned; an intentional fogd upgrade is separate from restore and
must preserve identities and volumes. TLS does not qualify upstream runtime upgrades,
public hostile tenancy, certificate renewal, or encrypted multi-host peer traffic.

## Implementation review response

Claude's [code review](m8b2-code-claude.md) found an implicit Compose `.env`
fallback and missing operator instructions. CLI Compose invocations now supply an
empty environment file and interpolate exclusively from the environment fogd already
resolved. This also works when restoring a self-contained snapshot without an
installation file. The [shared installation guide](../shared-installation.md) covers
import, upgrade, expiry recovery, credentials, private networks, and trust.

Import remains usable for local TLS as well as shared TLS, so it does not silently
select shared mode. Operators can set the shared profile before import to avoid
creating a temporary legacy credential. The startup error names FOGD_DEPLOY_TOKEN,
including scoped tokens accidentally exported in an operator shell. Client address
forwarding is deliberately absent and documented. Added tests cover missing TLS
material and the optional seventh archive; the upgrade drill exercises an actual
six-volume snapshot.
