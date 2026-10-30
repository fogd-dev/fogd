# fogd application lifecycle

These terms distinguish execution authority, retained data and capacity rights.
The [lifecycle contract](docs/application-lifecycle.md) records capability status;
a definition alone does not establish implementation support.

## Language

**HTTP pause**:
Withholding of new HTTP requests for an application. Background-work permissions
and capacity rights remain separate.
_Avoid_: Stop, archive

**Stopped installation**:
An installation with its writers confirmed stopped and its application assignments
retained.
_Avoid_: Empty installation, free capacity

**App archive**:
An inactive, recoverable application state whose retained identity and data carry
explicit restoration rights.
_Avoid_: Retirement, pause

**App retirement**:
Permanent loss of application-name rights within an installation. Retained recovery
material is separate from a right to restore that app independently.
_Avoid_: Archive, deletion

**Preview expiry**:
The end of a preview's execution authorization, with data retention and restoration
rights determined separately by its expiration policy.
_Avoid_: Artifact pruning

**Fleet capacity**:
The installation's application ownership allocations. A retained assignment consumes
capacity even when its HTTP routing is paused.
_Avoid_: Free disk space, artifact quota
