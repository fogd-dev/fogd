export function observerEnvironment(host) {
  return Object.fromEntries(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'FOGD_BUCKET', 'S3_ENDPOINT', 'FOGD_SLOTS']
    .map(key => [key, host.config.services.controller.environment[key]]));
}
export function observerOptions(host, network) {
  if (network !== 'none' && !Object.values(host.config.networks).some(value => value.name === network)) throw new Error('Observer network is outside the installation');
  return ['--pull', 'never', '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--label', `fogd.qualifier.project=${host.project}`,
    '--mount', `type=volume,src=${host.config.volumes.controller.name},dst=/var/lib/fogd,readonly`,
    '--mount', `type=volume,src=${host.config.volumes['runtime-policy'].name},dst=/var/lib/fogd-runtime,readonly`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m'];
}
