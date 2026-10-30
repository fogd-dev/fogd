export function previewDeadline(value) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(at) || new Date(at).toISOString() !== value || at - Date.now() > 3600 * 1000) throw new Error('Preview process requires an exact expiry within one hour');
  return at;
}
