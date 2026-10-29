import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandJson } from './commands.mjs';
import { buildEnvironment } from '../../../packages/cli/src/build-env.mjs';

export async function localTerminalBuild(host, project, capabilities) {
  const env = { ...buildEnvironment(host.env), FOGD_HOME: host.env.FOGD_HOME };
  delete env.FOGD_SERVER;
  const code = `import assert from'node:assert/strict';import{readFile}from'node:fs/promises';
import{buildArtifact}from${JSON.stringify(new URL('../../../packages/cli/src/local.mjs', import.meta.url).href)};
import{manifest}from${JSON.stringify(new URL('../../../packages/runtime/src/manifest.mjs', import.meta.url).href)};
import{artifactDigest}from${JSON.stringify(new URL('../../../packages/runtime/src/artifact.mjs', import.meta.url).href)};
assert.ok(!Object.keys(process.env).some(k=>/^(AWS_|MINIO_|CLOUDFLARE_|CF_)/i.test(k)||/^FOGD_.*(TOKEN|PASSWORD|SECRET)/i.test(k)));
const capabilities=${JSON.stringify(capabilities)},release=await buildArtifact(${JSON.stringify(project)},'refresh',capabilities),native=JSON.parse(await readFile(release.outputDir+'/wrangler.json','utf8'));
assert.equal(await artifactDigest(release.outputDir),release.digest);assert.deepEqual(native.triggers,{crons:['*/3 * * * *']});
console.log(JSON.stringify({payload:await manifest(release.outputDir,release),verification:{release,native,capabilities,credentialsAbsent:true,networkIsolated:false}}));`;
  const built = commandJson(await host.run(process.execPath, ['--input-type=module', '-e', code], { env }));
  await writeFile(join(host.output, 'local-build.json'), JSON.stringify(built, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return built;
}
