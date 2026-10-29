import { isDeepStrictEqual } from 'node:util';

export function artifactComparison(before, after) {
  const oldFiles = new Map((before?.files || []).map(file => [file.path, file]));
  const newFiles = new Map(after.files.map(file => [file.path, file]));
  const changed = []; let unchangedFiles = 0;
  for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    const old = oldFiles.get(path), next = newFiles.get(path);
    if (old && next && isDeepStrictEqual(old, next)) { unchangedFiles++; continue; }
    changed.push({ path, change: !old ? 'added' : !next ? 'removed' : 'changed',
      before: old ? { bytes: old.bytes, sha256: old.sha256 } : null,
      after: next ? { bytes: next.bytes, sha256: next.sha256 } : null });
  }
  return { files: changed, unchangedFiles,
    declarations: { before: before ? declarations(before.release) : null, after: declarations(after.release) },
    changedDeclarations: declarationChanges(before?.release, after.release),
    migrationFiles: changed.filter(file => file.path.startsWith('migrations/')).map(file => file.path) };
}
const declarations = release => ({ resources: release.resources, requiredSecrets: release.requiredSecrets, migrations: release.migrations });
function declarationChanges(before, after) {
  const old = before?.resources || {}, previousSecrets = before?.requiredSecrets || [];
  return { resources: [...new Set([...Object.keys(old), ...Object.keys(after.resources)])].sort().filter(key => !isDeepStrictEqual(old[key], after.resources[key])),
    requiredSecrets: { added: after.requiredSecrets.filter(name => !previousSecrets.includes(name)), removed: previousSecrets.filter(name => !after.requiredSecrets.includes(name)) } };
}
