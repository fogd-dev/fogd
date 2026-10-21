import { decodeRuntimePolicy, RUNTIME_POLICY_MAX_BYTES, RuntimePolicyError } from './runtime-policy.mjs';
import { writeRuntimePolicy } from './runtime-policy-file.mjs';

let size = 0; const chunks = [];
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > RUNTIME_POLICY_MAX_BYTES) throw new RuntimePolicyError();
  chunks.push(chunk);
}
const policy = decodeRuntimePolicy(Buffer.concat(chunks));
console.log(JSON.stringify(await writeRuntimePolicy('/data', policy)));
