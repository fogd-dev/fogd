import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = resolve(process.argv[2] || '.fogd/local-certificate');
await mkdir(dir, { mode: 0o700 });
const openssl = args => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
openssl(['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '7', '-subj', '/CN=fogd local test CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
openssl(['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
await writeFile(join(dir, 'extensions.cnf'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,DNS:accounts.localhost,DNS:accounts-peer.localhost,DNS:hello.localhost,DNS:notebook.localhost,IP:127.0.0.1\n', { mode: 0o600 });
openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '7', '-extfile', 'extensions.cnf']);
for (const file of ['ca.key', 'server.key']) await chmod(join(dir, file), 0o600);
console.log(`Local test certificate created in ${dir}; use ca.pem with NODE_EXTRA_CA_CERTS. No system trust was changed.`);
