import { defineHandler } from 'void';
import { summary, changeMode } from '../../lib/refresh.mjs';
import { readMode, InputError } from '../../lib/input.mjs';
export const GET = defineHandler(c => summary(c.env.DB));
export const POST = defineHandler(async c => {
  if (c.req.header('Origin') !== new URL(c.req.url).origin) return c.json({ error: 'Use this app to change its demo source.' }, 403);
  try {
    const mode = await readMode(c.req.raw); await changeMode(c.env.DB, mode);
    return c.json({ mode });
  } catch (error) { if (error instanceof InputError) return c.json({ error: error.message }, error.status); throw error; }
});
