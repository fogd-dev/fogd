// Self-contained for execution in the immutable cached image.
export async function workerdExecutable() {
  const { createRequire } = await import('node:module');
  const { createHash } = await import('node:crypto');
  const { createReadStream } = await import('node:fs');
  const { realpath } = await import('node:fs/promises');
  const require = createRequire('/app/packages/runtime/package.json');
  const dependency = createRequire(require.resolve('workerd/package.json'));
  const path = await realpath(dependency.resolve('@cloudflare/workerd-linux-arm64/bin/workerd'));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path, sha256: hash.digest('hex') };
}
