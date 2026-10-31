import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes } from '../build-cache/paths.mjs';
import { runtimeFamily } from '../runtime/catalog.mjs';
import { previewInputFile } from './input-files.mjs';
import { hostRefusal } from './host-records.mjs';

const entries = JSON.parse(await readFile(new URL('./runtime-catalog.json', import.meta.url)));

export function previewRuntimeFamily(name, { candidateEnrollment = false } = {}) {
  const entry = entries.find(value => value.id === name);
  if (!entry || typeof candidateEnrollment !== 'boolean' || entry.schema !== 1 || entry.purpose !== 'http-preview' ||
    entry.os !== 'linux' || entry.architecture !== 'arm64' || !['candidate', 'qualified'].includes(entry.admission) ||
    entry.admission !== 'qualified' && !candidateEnrollment) hostRefusal('preview-runtime');
  const base = runtimeFamily(entry.baseFamily, 'enrolled');
  if (hash(jsonBytes(base)) !== entry.baseCatalogEntrySha256 || base.binarySha256 !== entry.binarySha256 ||
    !entry.sourceFiles || !Object.entries(base.sourceFiles).every(([path, digest]) => entry.sourceFiles[path] === digest) ||
    !['backend', 'input-installer', 'control-main', 'service-main'].every(name => Object.hasOwn(entry.sourceFiles, `packages/cli/src/preview/${name}.mjs`))) hostRefusal('preview-runtime');
  return structuredClone(entry);
}

export function bindPreviewRuntime(plan, name, candidateEnrollment) {
  const entry = previewRuntimeFamily(name, { candidateEnrollment });
  if (plan.request.image !== entry.image || !isDeepStrictEqual(plan.request.preparation.runtime, { family: entry.id, catalogEntrySha256: hash(jsonBytes(entry)) })) hostRefusal('preview-runtime');
  return entry;
}

// Read from the existing stopped installer; never execute an image inspector or
// mount host state into the image. The catalog and immutable image ID are trusted.
export async function verifyPreviewRuntime(entry, installer, run) {
  if (!isDeepStrictEqual(entry, previewRuntimeFamily(entry.id, { candidateEnrollment: true }))) hostRefusal('preview-runtime');
  const root = await mkdtemp(join(tmpdir(), 'fogd-preview-runtime-'));
  try {
    for (const name of ['cli', 'platform', 'runtime']) {
      const directory = join(root, 'packages', name); await mkdir(join(directory, 'src'), { recursive: true, mode: 0o700 });
      await run(['cp', `${installer}:/app/packages/${name}/src/.`, join(directory, 'src')]);
      await run(['cp', `${installer}:/app/packages/${name}/package.json`, join(directory, 'package.json')]);
    }
    for (const [path, expected] of Object.entries(entry.sourceFiles)) {
      if (!/^packages\/(?:cli|platform|runtime)\/(?:package\.json|src\/[A-Za-z0-9._/-]+\.(?:mjs|js))$/.test(path) || path.split('/').includes('..') ||
        hash(await previewInputFile(join(root, path), 4 * 1024 ** 2)) !== expected) hostRefusal('preview-runtime-bytes');
    }
    return { id: entry.id, image: entry.image, programFiles: Object.keys(entry.sourceFiles).length, admission: entry.admission };
  } finally { await rm(root, { recursive: true }); }
}
