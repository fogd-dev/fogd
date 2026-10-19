import { defineHandler, type InferProps } from 'void';
export const loader = defineHandler((ctx) => {
  const room = new URL(ctx.req.url).searchParams.get('room') || 'shared';
  if (!/^[a-z0-9-]{1,64}$/.test(room)) return new Response('Invalid room', { status: 400 });
  return { room };
});
export type Props = InferProps<typeof loader>;
