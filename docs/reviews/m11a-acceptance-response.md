# M11a acceptance audit response

Accept Claude's recommendation to keep Docker admission at 0 and treat the bounded
profile as supported opt-in after the two missing checks pass. Both now pass:

- The complete retirement rerun used a backend-seeded post, verified through HTTP
  before backup and after retirement/replacement. The replacement returned an empty
  list. Added an explicit empty-list assertion and checked the recorded result.
- Added imports to the verifier and ran it in Docker with `--network none`. Ordinary
  Void and fogd builds, typechecking, identical queue declarations, and canonical
  staging passed. The public evidence records the image and build artifacts.

Accept the weaker-but-relevant evidence boundaries: native runtime process-loss
qualification and private three-fleet isolation are separate from canonical CLI
acceptance. The acceptance table states that distinction. No general side-effect
idempotency, arbitrary policies, hosted execution, or stronger drain is claimed.

Current operator guides and the imports README now describe the actual opt-in.
Historical evidence and review records keep their original scope statements.
The older exit-143 failed-claim bundle remains an explicit unqualified variant;
later successful restoration does not retroactively qualify it.
