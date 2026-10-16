import { defineHandler } from 'void';
import { getUser } from 'void/auth';
export const GET = defineHandler(c => getUser()
  ? c.json({ privateURL: new URL('/api/private', c.req.url).href })
  : c.json({ error: 'Sign in required' }, 401));
