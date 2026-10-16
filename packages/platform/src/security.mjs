import { createHash, timingSafeEqual } from 'node:crypto';

export const equal = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
