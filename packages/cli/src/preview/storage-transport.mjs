import { hash } from '../build-cache/paths.mjs';
import { execute } from '../recovery/execute.mjs';
import { previewStorageWorkerSha256 } from './storage.mjs';

const bootstrap = 'import io,json,sys;request=json.load(sys.stdin);sys.stdin=io.TextIOWrapper(io.BytesIO(request["input"].encode("utf-8")));exec(compile(request["worker"],"fogd-preview-storage","exec"))';
const remote = "sudo -n python3 -c '" + bootstrap + "'";
function refuse() {
  const error = new Error('Preview storage transport refused; check the explicit SSH alias and inspect retained host state');
  error.code = 'PREVIEW_STORAGE_TRANSPORT_REFUSED'; throw error;
}

// The alias is selected by the owner, never loaded from a launch request. SSH
// executes one fixed bootstrap; worker source and input travel over stdin.
export function previewStorageSSH(alias) {
  if (typeof alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(alias)) refuse();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FOGD_') && !key.startsWith('DOCKER_')));
  return async (args, options = {}) => {
    try {
      if (!Array.isArray(args) || args.length !== 3 || args[0] !== 'python3' || args[1] !== '-c' ||
        typeof args[2] !== 'string' || hash(args[2]) !== previewStorageWorkerSha256 || typeof options.inputText !== 'string') refuse();
      return await execute('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
        '-o', 'ClearAllForwardings=yes', '--', alias, remote], {
        env, inputText: JSON.stringify({ worker: args[2], input: options.inputText }), timeoutMs: 45000, maxOutputBytes: 65536,
      });
    } catch { refuse(); }
  };
}
