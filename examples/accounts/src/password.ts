// celld compatibility adapter: preserve Void's scrypt parameters and salt:key format.
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { timingSafeEqual } from 'node:crypto';

const options = { N: 16384, r: 16, p: 1, dkLen: 64, maxmem: 67108864 };
const derive = (password: string, salt: string) => scryptAsync(password.normalize('NFKC'), salt, options);
export const password = {
  async hash(value: string) {
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    return `${salt}:${bytesToHex(await derive(value, salt))}`;
  },
  async verify({ hash, password: value }: { hash: string; password: string }) {
    if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash)) return false;
    const [salt, key] = hash.split(':');
    return timingSafeEqual(hexToBytes(key), await derive(value, salt));
  },
};
