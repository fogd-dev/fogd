import { decodeRuntimePolicy } from '@fogd/platform/runtime-policy';
import { volumeHelper } from '../recovery/volumes.mjs';

// The host authorizes and verifies the image before reading this independent
// volume. Match controller privileges and never send credentials to the reader.
export async function readPolicyVolume(image, name, env) {
  const binding = Object.fromEntries(['FOGD_BUCKET', 'S3_ENDPOINT', 'AWS_REGION', 'FOGD_SLOTS'].map(key => [key, env[key]]));
  const code = "import{readRuntimePolicy}from'./packages/platform/src/runtime-policy-file.mjs';let input='';for await(const part of process.stdin)input+=part;console.log(JSON.stringify(await readRuntimePolicy('/data',JSON.parse(input))));";
  try {
    const output = await volumeHelper(image, name, ['--input-type=module', '-e', code], {
      entrypoint: '/usr/local/bin/node', capabilities: [], inputText: JSON.stringify(binding),
    });
    return decodeRuntimePolicy(output, env);
  } catch { throw new Error('Installed runtime policy could not be read; keep the installation stopped'); }
}
