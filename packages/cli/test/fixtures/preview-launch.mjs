import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from '../../src/build-cache/paths.mjs';
import { initializePreviewHost } from '../../src/preview/host-reservations.mjs';
import { previewRuntimeFamily } from '../../src/preview/runtime-catalog.mjs';
import { preparePreviewInputPackage } from '../../src/preview/input-package.mjs';
import { reviewFixture, id } from './artifact-review.mjs';
import { previewInputFixture } from './preview-input-package.mjs';
import { stoppedPreviewFixture } from './stopped-preview.mjs';
import { copyPreviewRuntime, previewProcessCommand } from './preview-docker.mjs';

export const previewLaunchRuntime = 'celld-preview-http-v1-linux-arm64';
export async function prepareCandidatePreview(source, lifetimeSeconds = '900') {
  const module = new URL('../../src/preview/prepare.mjs', import.meta.url).href;
  const script = `import {preparePreview} from ${JSON.stringify(module)}; console.log(JSON.stringify(await preparePreview(JSON.parse(process.argv[2]))));`;
  const program = join(source.root, 'prepare-candidate.mjs');
  await writeFile(program, script, { mode: 0o600, flag: 'wx' });
  return JSON.parse((await promisify(execFile)(process.execPath, [program,
    JSON.stringify({ id, output: source.output, runtime: previewLaunchRuntime, lifetimeSeconds, candidateEnrollment: true })], { env: source.env, timeout: 20000 })).stdout);
}

// Fake Docker boundary only. Source HTTP, artifacts, signatures, TLS, private
// records and all coordinator/component checks use the actual implementation.
export async function previewLaunchFixture(t) {
  const source = await reviewFixture(t), prepared = await prepareCandidatePreview(source);
  const preparation = JSON.parse(await readFile(join(source.output, 'preview.json')));
  const runtime = previewRuntimeFamily(previewLaunchRuntime, { candidateEnrollment: true });
  const input = await previewInputFixture(t, { preparation, artifact: source.after, image: runtime.image });
  assert.equal(prepared.preparationSha256, input.request.preparationSha256);
  const base = { ...input, authority: input.signer, storagePassword: input.options.secretValues.storagePassword, gatewayToken: input.options.secretValues.gatewayToken };
  let model = stoppedPreviewFixture(base);
  const observed = { host: model.observed.host, containers: [], networks: [], volumes: [] }, calls = [];
  const root = join(input.root, 'host'); await mkdir(root, { mode: 0o700 });
  const snapshot = await preparePreviewInputPackage(input.authority, input.bundle);
  const ownerControl = { directory: join(await realpath(input.root), 'owner-control'), dockerContext: 'preview-owner-fixture' };
  function selectModel(args) {
    const label = args.find(value => value.startsWith('fogd.preview.allocation='));
    if (label && !observed.networks.length) model = stoppedPreviewFixture(base, label.split('=')[1]);
  }
  function createNetwork(args) {
    selectModel(args);
    const value = structuredClone(model.observed.networks.find(value => value.Name === args.at(-1)));
    observed.networks.push(value); return value.Id;
  }
  function createVolume(args) {
    const value = structuredClone(model.observed.volumes.find(value => value.Name === args.at(-1)));
    observed.volumes.push(value); return value.Name;
  }
  function createContainer(args) {
    const name = args[args.indexOf('--name') + 1];
    const value = structuredClone(model.observed.containers.find(value => value.Name === '/' + name));
    const first = Object.keys(value.NetworkSettings.Networks)[0];
    value.NetworkSettings.Networks = first ? { [first]: value.NetworkSettings.Networks[first] } : {};
    observed.containers.push(value); return value.Id;
  }
  function connect(args) {
    const container = observed.containers.find(value => value.Id === args.at(-1)), network = args.at(-2);
    container.NetworkSettings.Networks[network] = structuredClone(model.observed.containers.find(value => value.Id === container.Id).NetworkSettings.Networks[network]);
    return '';
  }
  const processState = args => previewProcessCommand(observed, args);
  function installer(args, extra) {
    assert.equal(hash(extra.inputText), snapshot.sha256);
    const container = observed.containers.find(value => value.Id === args.at(-1));
    Object.assign(container.State, { Status: 'exited', Running: false, Pid: 0, ExitCode: 0, StartedAt: new Date().toISOString() });
    observed.networks.push({ Name: 'none', Id: 'f'.repeat(64), Driver: 'null', Scope: 'local', Labels: {}, IPAM: { Config: null } });
    container.NetworkSettings.Networks = { none: { NetworkID: 'f'.repeat(64) } };
    return JSON.stringify({ installed: true, packageSha256: snapshot.sha256 });
  }
  async function copy(args) {
    if (args[1].includes(':/app/packages/')) return copyPreviewRuntime(runtime, args[1].split(':')[1], args[2]);
    const [container, path] = args[1].split(':'), role = Object.keys(model.created.containers).find(role => model.created.containers[role] === container);
    const group = role + (path.includes('-trust') ? '-trust' : '-input');
    for (const [name, bytes] of Object.entries(snapshot.files[group])) await writeFile(join(args[2], name), bytes, { mode: 0o600 });
    return '';
  }
  const handlers = { info: () => JSON.stringify(observed.host), image: () => JSON.stringify([model.image]), create: createContainer,
    'network create': createNetwork, 'network connect': connect, 'volume create': createVolume, cp: copy, exec: processState, stop: processState,
    wait: processState,
    start: (args, extra) => args[1] === '--attach' ? installer(args, extra) : processState(args) };
  for (const [kind, values] of Object.entries({ container: 'containers', network: 'networks', volume: 'volumes' })) {
    handlers[kind + ' ls'] = () => observed[values].map(value => kind === 'volume' ? value.Name : value.Id).join('\n');
    handlers[kind + ' inspect'] = () => JSON.stringify(observed[values]);
  }
  const run = async (args, extra) => { calls.push(args); const handler = handlers[args[0] + ' ' + args[1]] || handlers[args[0]]; if (!handler) throw Error('Unexpected Docker operation'); return handler(args, extra); };
  await initializePreviewHost({ root, engineId: input.plan.request.engineId, run }); calls.length = 0; source.calls.length = 0;
  const cancellation = new AbortController();
  const args = { ...input.options, root, plan: input.plan, envelope: input.envelope, bundle: input.bundle, expectedImage: runtime.image,
    runtime: runtime.id, candidateEnrollment: true, directory: source.output, env: source.env, ownerControl, run, signal: cancellation.signal };
  return { args, source, input, observed, calls, cancellation, root, ownerControl, host: join(root, hash(input.plan.request.engineId)) };
}

export async function previewLaunchRequestFixture(t) {
  const f = await previewLaunchFixture(t);
  return { ...f, request: { root: f.args.root, directory: f.args.directory,
    expectedPreparationSha256: f.args.plan.request.preparationSha256,
    engineId: f.args.plan.request.engineId, storage: f.args.plan.request.storage,
    runtime: f.args.runtime, candidateEnrollment: true, origin: f.args.plan.request.origin,
    subnets: f.args.plan.request.subnets, tls: { gateway: f.args.bundle.gateway.tls, ingress: f.args.bundle.ingress.tls },
    dockerContext: f.ownerControl.dockerContext, output: join(f.input.root, 'launch-request'),
    env: f.args.env, runStorageHost: f.args.runStorageHost } };
}
