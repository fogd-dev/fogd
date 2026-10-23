const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex64 = /^[0-9a-f]{64}$/;
const isId = value => typeof value === 'string' && uuid.test(value);
const isHash = value => typeof value === 'string' && hex64.test(value);
const unsafeCharacter = /[\\\u0000-\u001f\u007f]/;
const TARGET_KEYS = 'bytes,digest,directories,files,id';
const FILE_KEYS = 'bytes,path,sha256';

function invalid() {
  const error = new Error('Artifact prune targets are malformed; plan artifact retention again');
  error.code = 'ARTIFACT_PRUNE_TARGETS_INVALID';
  return error;
}

const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === keys;
const size = value => Number.isSafeInteger(value) && value >= 0;
const parent = path => path.slice(0, Math.max(path.lastIndexOf('/'), 0));

// Relative inventory paths as join() produces them on POSIX; 255 bytes is the common name limit.
function safePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 512 && !unsafeCharacter.test(path)
    && path.split('/').every(name => name !== '' && name !== '.' && name !== '..' && Buffer.byteLength(name) <= 255);
}

// Strictly ascending in the inventory's default sort order, so also unique.
const sortedPaths = paths => paths.every((path, i) => safePath(path) && (i === 0 || paths[i - 1] < path));

// A declared parent for every entry rules out a file standing where a directory must be.
function validLayout(paths, directories) {
  const dirs = new Set(directories);
  if (!sortedPaths(paths) || !sortedPaths(directories) || paths.some(path => dirs.has(path))) return false;
  return [...paths, ...directories].every(path => !parent(path) || dirs.has(parent(path)));
}

function validTarget(target) {
  if (!exactKeys(target, TARGET_KEYS) || !isId(target.id) || !isHash(target.digest) || !size(target.bytes)) return false;
  const { files, directories } = target;
  if (!Array.isArray(files) || !Array.isArray(directories)) return false;
  if (!files.every(file => exactKeys(file, FILE_KEYS) && size(file.bytes) && isHash(file.sha256))) return false;
  return validLayout(files.map(file => file.path), directories) && files.reduce((sum, file) => sum + file.bytes, 0) === target.bytes;
}

export function validatePruneTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0 || !targets.every(validTarget)) throw invalid();
  if (new Set(targets.map(target => target.id)).size !== targets.length) throw invalid();
  return targets;
}
