import { defineHandler } from 'void';
import { live } from '../src/live';
export const GET = defineHandler(ctx => live.connect(ctx));
export const POST = defineHandler(ctx => {
  const url = new URL(ctx.req.url);
  const host = ctx.req.header('x-forwarded-host') || url.host;
  const protocol = ctx.req.header('x-forwarded-proto') || url.protocol.slice(0, -1);
  if (ctx.req.header('origin') !== `${protocol}://${host}`) return new Response('Forbidden origin', { status: 403 });
  return live.control(ctx);
});
