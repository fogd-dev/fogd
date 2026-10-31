import { mkdir } from 'node:fs/promises';
import { dirname, basename, join, resolve, sep, isAbsolute } from 'node:path';
import { hash, jsonBytes, uuid, exists } from '../build-cache/paths.mjs';
import { execute } from '../recovery/execute.mjs';
import { bindHostDirectory, syncHostDirectory, checkHostDirectory } from '../runtime/host-directory.mjs';
import { executionKeys } from './execution-shape.mjs';
import { validatePreviewPlan } from './plan.mjs';
import { previewServiceInspection } from './container-plan.mjs';
import { readHostRecord, appendHostRecord, hostRefusal } from './host-records.mjs';

const fields = ['schema', 'kind', 'root', 'dockerContext', 'plan', 'allocationId', 'reservation', 'envelope', 'expectedImage', 'publicKey', 'expectedGrantSha256', 'secretValues'];
const refuseControl = reason => {
  const error = new Error(reason === 'engine' ? 'Preview owner engine refused; check the explicit Docker context and engine identity' : 'Preview owner control refused; check its private directory and allocation identity');
  error.code = 'PREVIEW_OWNER_CONTROL_REFUSED'; error.reason = reason; throw error;
};
function validateControl(value) {
  executionKeys(value, fields); executionKeys(value.secretValues, ['storagePassword', 'gatewayToken']);
  if (value.schema !== 1 || value.kind !== 'fogd-preview-owner-control' || typeof value.root !== 'string' || !isAbsolute(value.root) ||
    typeof value.dockerContext !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.dockerContext) ||
    !uuid(value.allocationId) || !uuid(value.reservation)) hostRefusal('owner-control');
  const plan = validatePreviewPlan(value.plan);
  if (value.expectedImage !== plan.request.image) hostRefusal('owner-control');
  previewServiceInspection(plan, value.envelope, value, value.allocationId);
  return value;
}
const within = (directory, parent) => directory === parent || directory.startsWith(parent + sep);

async function controlLocation(input, { directory, dockerContext }) {
  if (typeof directory !== 'string' || !directory || typeof dockerContext !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(dockerContext)) hostRefusal('owner-control');
  const root = await bindHostDirectory(input.root), parent = await bindHostDirectory(dirname(resolve(directory)));
  const output = join(parent.canonical, basename(resolve(directory)));
  const preparation = input.directory ? await bindHostDirectory(input.directory) : null;
  if (within(output, root.canonical) || preparation && within(output, preparation.canonical) || await exists(output)) hostRefusal('owner-control-location');
  return { root, parent, output };
}
export async function checkPreviewOwnerControlLocation(input, config) {
  try { return (await controlLocation(input, config)).output; }
  catch { refuseControl('control'); }
}

// Expectations only, not a readiness receipt or new execution permission.
// Keep this owner-only configuration outside both immutable inputs and host state.
export async function writePreviewOwnerControl(input, { directory, dockerContext }) {
  try {
    const { root, parent, output } = await controlLocation(input, { directory, dockerContext });
    const data = validateControl(JSON.parse(jsonBytes({ schema: 1, kind: 'fogd-preview-owner-control', root: root.canonical, dockerContext,
      ...Object.fromEntries(fields.slice(4).map(key => [key, input[key]])) })));
    await checkHostDirectory(parent); await mkdir(output, { mode: 0o700 }); await syncHostDirectory(parent);
    const bound = await bindHostDirectory(output); await appendHostRecord(bound, 'owner.json', data);
    return { directory: output, sha256: hash(jsonBytes(data)), allocationId: data.allocationId, capability: 'inspect-stop-and-retire-only' };
  } catch { refuseControl('control'); }
}

export async function readPreviewOwnerControl(directory, allocationId) {
  try {
    if (!uuid(allocationId)) hostRefusal('owner-control');
    const bound = await bindHostDirectory(resolve(directory)), data = validateControl(await readHostRecord(bound, 'owner.json'));
    if (data.allocationId !== allocationId) hostRefusal('owner-control');
    return data;
  } catch { refuseControl('control'); }
}

export function previewOwnerDocker(dockerContext) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DOCKER_') && !key.startsWith('FOGD_')));
  return args => execute('docker', ['--context', dockerContext, ...args], { env, timeoutMs: 30000, maxOutputBytes: 64 * 1024 ** 2 });
}

export async function verifyPreviewOwnerEngine(control, run) {
  try {
    const actual = JSON.parse(await run(['info', '--format', '{{json .}}']));
    if (actual.ID !== control.plan.request.engineId) hostRefusal('owner-engine');
  } catch { refuseControl('engine'); }
}
