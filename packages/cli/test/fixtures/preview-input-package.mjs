import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { previewPlanFixture } from './preview-plan.mjs';
import { artifact } from './artifact-review.mjs';
import { hash, jsonBytes } from '../../src/build-cache/paths.mjs';
import { createPreviewPlan, previewPlanTarget } from '../../src/preview/plan.mjs';
import { issuePreviewExecution } from '../../src/preview/execution.mjs';
import { previewExecutionSha256 } from '../../src/preview/execution-authority.mjs';
import { previewServiceCommands } from '../../src/preview/container-plan.mjs';

export async function previewInputFixture(t, source = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-input-package-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = previewPlanFixture(), body = source.artifact || artifact(true), preparation = structuredClone(source.preparation || f.request.preparation);
  preparation.source.app = body.app; preparation.source.digest = body.digest;
  const hostname = `${body.app}.${preparation.id.replaceAll('-', '')}.preview.test`;
  async function tls(role) {
    await promisify(execFile)('openssl', ['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',join(root,role+'.key'),'-out',join(root,role+'.crt'),'-days','1','-subj','/CN='+hostname,'-addext','subjectAltName=DNS:'+hostname]);
    return { cert: await readFile(join(root,role+'.crt'),'utf8'), key: await readFile(join(root,role+'.key'),'utf8') };
  }
  const gatewayTLS = await tls('gateway'), ingressTLS = await tls('ingress'), secrets = {}, accessKey = 'd'.repeat(64);
  const request = { ...f.request, image: source.image || f.request.image, preparation, preparationSha256: hash(jsonBytes(preparation)), origin: `https://${hostname}:49443`, fingerprints: {
    ...f.request.fingerprints, artifact: hash(jsonBytes(body)), previewSecrets: hash(jsonBytes(secrets)), gatewayTLS: hash(jsonBytes(gatewayTLS)), ingressTLS: hash(jsonBytes(ingressTLS)), viewerAccessKey: hash(accessKey),
  } };
  const plan = createPreviewPlan(request), release = { app: body.app, digest: body.digest, requiredSecrets: [], resources: { script: body.app, durable: { bindings: [] }, d1: [], r2: [] } };
  const envelope = issuePreviewExecution(preparation, { expectedPreparationSha256: request.preparationSha256, release, target: previewPlanTarget(plan), privateKey: f.authority.privateKey });
  const options = { publicKey: f.authority.publicKey, expectedGrantSha256: previewExecutionSha256(envelope), secretValues: { storagePassword: f.storagePassword, gatewayToken: f.gatewayToken } };
  const bundle = { envelope, artifact: body, secrets, gateway: { tls: gatewayTLS, gatewayToken: f.gatewayToken }, ingress: { tls: ingressTLS, accessKey, upstreamCA: gatewayTLS.cert } };
  const commands = previewServiceCommands(plan, envelope, options);
  return { root, plan, request, envelope, bundle, options, signer: f.authority, authority: JSON.parse(commands['input-installer'].configuration.command[2]) };
}
