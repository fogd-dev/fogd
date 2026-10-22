export function buildEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(CLOUDFLARE_|CF_|AWS_|MINIO_|VOID_DEPLOY_PROJECT_ID$|VOID_CLOUDFLARE_DEPLOY_BUILD$|VOID_MANAGED$)/i.test(key) && !/^FOGD_.*(TOKEN|PASSWORD|SECRET)|^FOGD_(HOME|CLIENT_HOME|ENV_FILE)$/i.test(key)));
}
