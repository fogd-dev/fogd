import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const previewCookie = '__Host-fogd-preview';
export const previewPath = '/.well-known/fogd-preview';
const hashed = value => createHash('sha256').update(value).digest();
const equal = (a, b) => timingSafeEqual(hashed(a), hashed(b));
const cookies = value => String(value || '').split(';').map(part => part.trim()).filter(Boolean);
const name = value => value.split('=', 1)[0].trim();
export const withoutPreviewCookie = value => cookies(value).filter(part => name(part).toLowerCase() !== previewCookie.toLowerCase()).join('; ');

export function previewAccess({ accessKey, identity, origin, expiresAt }) {
  if (typeof accessKey !== 'string' || !/^[a-f0-9]{64}$/.test(accessKey)) throw new Error('Preview ingress requires a private 256-bit access key');
  if (!identity || Object.keys(identity).sort().join(',') !== 'app,digest,preview,submission' || !Object.values(identity).every(value => typeof value === 'string') ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(identity.app) || !/^[a-f0-9]{64}$/.test(identity.digest) ||
    !['preview', 'submission'].every(key => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity[key]))) throw new Error('Preview ingress requires exact public release identities');
  const session = createHmac('sha256', Buffer.from(accessKey, 'hex')).update(JSON.stringify({ preview: identity.preview, app: identity.app, submission: identity.submission, digest: identity.digest, origin, expiresAt })).digest('base64url');
  return {
    login: key => typeof key === 'string' && key.length === 64 && equal(key, accessKey),
    authenticated: header => {
      const selected = cookies(header).filter(part => name(part) === previewCookie);
      return selected.length === 1 && equal(selected[0].slice(selected[0].indexOf('=') + 1), session);
    },
    cookie: () => `${previewCookie}=${session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))}`,
    clearCookie: `${previewCookie}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
  };
}

export function accessPage(identity, expiresAt) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview access</title><style>body{font:16px system-ui;margin:0;padding:24px}main{max-width:48rem;margin:auto}p,code{overflow-wrap:anywhere}label{display:block;margin-top:24px}input{font:inherit;box-sizing:border-box;width:24rem;max-width:100%;padding:8px}button{font:inherit;display:block;margin-top:16px;padding:8px 16px}</style><main><h1>Preview access</h1><p>Application: ${identity.app}</p><p>Preview: ${identity.preview}</p><p>Submission: ${identity.submission}</p><p>Release: <code>${identity.digest}</code></p><p>Expires: <time datetime="${expiresAt}">${expiresAt}</time></p><form method="post" action="${previewPath}/login"><label for="preview-key">Preview access key</label><input id="preview-key" name="key" type="password" autocomplete="current-password" required minlength="64" maxlength="64" pattern="[a-f0-9]{64}"><button>Open preview</button></form></main></html>`;
}
