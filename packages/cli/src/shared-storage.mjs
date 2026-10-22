// Host-side admission only: never generate or rotate an existing storage account.
export function assertSharedStorageCredentials(profile, user, password) {
  if (profile !== 'shared') return;
  if (typeof user !== 'string' || !user.trim() || typeof password !== 'string' || !password.trim() || password === 'fogd-local-development-only') {
    throw new Error('Shared storage requires explicit FOGD_BUCKET_USER and a private FOGD_BUCKET_PASSWORD. Enrolled installations use saved credentials; an environment edit does not change them. Existing data needs a deliberate maintenance procedure; startup never rotates credentials. See docs/shared-installation.md.');
  }
}

export function assertSharedStorageConfiguration(config) {
  const env = config.services.controller.environment;
  assertSharedStorageCredentials(env.FOGD_PROFILE, env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY);
  if (env.FOGD_PROFILE !== 'shared') return;
  const storage = config.services.minio.environment;
  assertSharedStorageCredentials(env.FOGD_PROFILE, storage.MINIO_ROOT_USER, storage.MINIO_ROOT_PASSWORD);
  if (env.AWS_ACCESS_KEY_ID !== storage.MINIO_ROOT_USER || env.AWS_SECRET_ACCESS_KEY !== storage.MINIO_ROOT_PASSWORD) {
    throw new Error('Shared storage credentials must match between the controller and MinIO; retain the original configuration and review the storage maintenance procedure.');
  }
}
