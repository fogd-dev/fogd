import { appName } from '@fogd/runtime/artifact';
// The qualified package's export list is frozen. Resolve its declared dependency
// first so copied/offline CLIs reuse the shipped explanation policy as well.
const { deploymentStatus } = await import(new URL('./deployment-status.mjs', import.meta.resolve('@fogd/platform/runtime-policy')));

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const statuses = new Set(['pending', 'activating', 'active', 'failed', 'rejected', 'superseded', 'retired']);
export function submitterStatus(input, requested) {
  if (!input || Array.isArray(input) || !uuid(input.id) || input.id !== requested || typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest)) throw new Error('Controller returned an invalid or different submission identity');
  try { appName(input.app); } catch { throw new Error('Controller returned an invalid submission app'); }
  const status = statuses.has(input.status) ? input.status : 'unknown';
  return deploymentStatus({ id: input.id, app: input.app, digest: input.digest, status, step: typeof input.step === 'string' ? input.step : 'unknown', submittedAt: recordedTime(input.submittedAt) });
}
function recordedTime(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}
