const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export function secretNames(names) {
  if (!Array.isArray(names) || names.length > 32 || new Set(names.map(name => typeof name === 'string' ? name.toLowerCase() : name)).size !== names.length) throw new Error('Expected at most 32 distinct required secret names');
  for (const name of names) {
    if (typeof name !== 'string' || !identifier.test(name) || /^(?:__|VITE_|FOGD_)/i.test(name)) throw new Error('Invalid or reserved secret name');
  }
  return [...names].sort();
}
export function deploymentMetadata(value, config) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'requiredSecrets')) throw new Error('Invalid deployment metadata');
  const requiredSecrets = secretNames(value.requiredSecrets);
  const taken = new Set([...Object.keys(config.vars || {}), ...(config.d1_databases || []).map(b => b.binding), ...(config.r2_buckets || []).map(b => b.binding), ...(config.durable_objects?.bindings || []).map(b => b.name), ...(config.queues?.producers || []).map(b => b.binding), config.assets?.binding].filter(Boolean).map(name => name.toLowerCase()));
  if (requiredSecrets.some(name => taken.has(name.toLowerCase()))) throw new Error('Secret name conflicts with a variable or resource binding');
  return { requiredSecrets };
}
export function buildMetadata(input) {
  if (input.build && (typeof input.build !== 'object' || Object.keys(input.build).some(key => key !== 'watch_dir'))) throw new Error('Unsupported prebuilt build directive');
  if (input.secrets && (typeof input.secrets !== 'object' || Array.isArray(input.secrets) || Object.keys(input.secrets).some(key => key !== 'required'))) throw new Error('Unsupported secrets declaration');
  return deploymentMetadata({ requiredSecrets: input.secrets?.required || [] }, input);
}
