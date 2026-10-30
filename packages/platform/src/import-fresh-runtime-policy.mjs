import { hasDurableRuntimeMode, decodeRuntimePolicy, RUNTIME_POLICY_MAX_BYTES, RuntimePolicyError } from './runtime-policy.mjs';
import { writeRuntimePolicy } from './runtime-policy-file.mjs';

// Fresh durable installations only: a durable policy into the fixed empty /data mount,
// never replacing or repairing a retained policy.
let size = 0; const chunks = [];
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > RUNTIME_POLICY_MAX_BYTES) throw new RuntimePolicyError();
  chunks.push(chunk);
}
const policy = decodeRuntimePolicy(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
if (!hasDurableRuntimeMode(policy)) throw new RuntimePolicyError();
console.log(JSON.stringify(await writeRuntimePolicy('/data', policy, { createOnly: true })));
