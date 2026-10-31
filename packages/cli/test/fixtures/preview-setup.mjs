import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from '../../src/build-cache/paths.mjs';
import { initializePreviewProfile } from '../../src/preview/profile.mjs';
import { previewRuntimeFamily } from '../../src/preview/runtime-catalog.mjs';
import { reviewFixture, artifact as reviewArtifact, id } from './artifact-review.mjs';
import { prepareCandidatePreview, previewLaunchRuntime } from './preview-launch.mjs';
import { previewInputFixture } from './preview-input-package.mjs';
import { emptyPreviewDocker } from './preview-host.mjs';
import { previewStorageAdmissionFixture, previewStorageFixture } from './preview-storage.mjs';
import { previewStorageWorkerSha256, previewStorageBytes, previewStorageChargeBytes } from '../../src/preview/storage.mjs';

export async function previewSetupFixture(t, extraConfig) {
  const source = await reviewFixture(t);
  if (extraConfig) { Object.assign(source.after, reviewArtifact(true, extraConfig)); source.state.deployments[id].digest = source.after.digest; }
  const prepared = await prepareCandidatePreview(source), preparation = JSON.parse(await readFile(join(source.output, 'preview.json')));
  const runtime = previewRuntimeFamily(previewLaunchRuntime, { candidateEnrollment: true });
  const artifact = await previewInputFixture(t, { preparation, artifact: source.after, image: runtime.image }), docker = emptyPreviewDocker();
  const storageRoot = '/var/lib/docker/fogd-setup-fixture', hostCalls = [];
  const admission = previewStorageAdmissionFixture({ root: storageRoot, engineId: docker.host.ID });
  admission.policy.rootIdentity = { device: 1, inode: 1 };
  let initialized = false, storage;
  const runHost = async (args, options) => {
    assert.equal(hash(args[2]), previewStorageWorkerSha256); const request = JSON.parse(options.inputText); hostCalls.push(request);
    if (request.action === 'initialize') { assert.equal(initialized, false); initialized = true; }
    if (['initialize', 'admission'].includes(request.action)) return JSON.stringify({ ok: true, admission });
    if (request.action === 'prepare') {
      if (storage || !admission.admissionOpen) return JSON.stringify({ ok: false, reason: 'capacity' });
      storage = previewStorageFixture(request.project, request.engineId, request.root);
      admission.reservations.push({ schema: 1, kind: 'fogd-preview-storage-hold', profileId: admission.policy.id,
        reservation: storage.storage.admission.reservation, project: request.project, engineId: request.engineId,
        backingBytes: previewStorageBytes, chargeBytes: previewStorageChargeBytes });
      Object.assign(admission, { heldProjects: 1, heldChargeBytes: previewStorageChargeBytes, remainingProjects: 1 });
    }
    assert(storage); assert.equal(request.project, storage.storage.project);
    return JSON.stringify({ ok: true, storage: storage.storage });
  };
  const output = join(artifact.root, 'profile');
  const profile = await initializePreviewProfile({ output, dockerContext: 'setup-owner', storageRoot, maxProjects: 2, run: docker.run, runHost });
  hostCalls.length = 0; docker.calls.length = 0; source.calls.length = 0;
  const args = { profileDirectory: output, expectedProfileSha256: profile.profileSha256, directory: source.output,
    expectedPreparationSha256: prepared.preparationSha256, output: join(artifact.root, 'storage-request'),
    env: source.env, run: docker.run, runHost, candidateEnrollment: true };
  const settings = { origin: artifact.request.origin, subnets: artifact.request.subnets,
    tls: { gateway: artifact.bundle.gateway.tls, ingress: artifact.bundle.ingress.tls }, secrets: {} };
  return { args, settings, source, artifact, docker, hostCalls, admission, profile, get storage() { return storage; } };
}
