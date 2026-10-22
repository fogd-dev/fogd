import { appName } from '@fogd/runtime/artifact';
import { identity, digest, hash, jsonBytes } from './paths.mjs';
import { validRecord } from './policy.mjs';
import { safePath } from './tree.mjs';

export function validatePlan(plan) {
  if (plan?.format !== 'fogd-host-cache-plan-v1' || !digest(plan.home) || !digest(plan.controller) || !Array.isArray(plan.rows)) throw new Error('Unsupported host build plan');
  appName(plan.app); const seen = new Set();
  for (const row of plan.rows) {
    identity(row.app, row.id);
    if (row.app !== plan.app || seen.has(row.id) || !['keep', 'prune'].includes(row.decision)) throw new Error('Invalid host build plan selection'); seen.add(row.id);
    if (row.decision === 'prune') validateCandidate(row);
  }
}
const rootIdentity = value => value && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino);
const filePath = value => safePath(value) && (value === 'record.json' || value.startsWith('artifact/'));
const directoryPath = value => safePath(value) && (value === 'artifact' || value.startsWith('artifact/'));
function validateFiles(tree) {
  if (new Set(tree.files.map(file => file.path)).size !== tree.files.length || new Set(tree.directories).size !== tree.directories.length) throw new Error('Ambiguous host build plan inventory');
  for (const file of tree.files) if (!filePath(file.path) || !digest(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid host build plan file');
  if (!tree.directories.every(directoryPath)) throw new Error('Invalid host build plan directory');
}
export function validateCandidate(row) {
  identity(row.app, row.id);
  if (!validRecord(row.record, row.app, row.id) || row.record.phase !== 'submitted') throw new Error('Invalid host build plan receipt');
  const tree = row.tree;
  if (!tree || !rootIdentity(tree.identity) || !Array.isArray(tree.files) || !Array.isArray(tree.directories) || !digest(tree.artifactDigest)) throw new Error('Invalid host build plan inventory');
  validateFiles(tree);
  if (tree.artifactDigest !== row.record.digest || !tree.files.some(file => file.path === 'record.json' && file.sha256 === hash(jsonBytes(row.record)))) throw new Error('Build plan receipt differs from its inventory');
  const total = tree.files.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(total) || total !== tree.logicalBytes || total !== row.logicalBytes) throw new Error('Build plan byte count differs from its inventory');
}
