import { defineHandler } from 'void';
import { getUser } from 'void/auth';
export const GET = defineHandler(c => { const user = getUser(); return user ? c.json({ email: user.email }) : c.json({ error: 'Sign in required' }, 401); });
