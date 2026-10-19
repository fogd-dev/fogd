import { z } from 'zod';
import { defineRoom } from 'void/ws';
export default defineRoom({
  name: 'checklist',
  messages: { client: z.object({ type: z.literal('ping') }), server: z.object({ type: z.literal('ready'), room: z.string() }) },
  async onConnect(ctx) { await ctx.connection.send({ type: 'ready', room: ctx.params.room }); },
  async onMessage(ctx) { await ctx.connection.send({ type: 'ready', room: ctx.params.room }); },
  onRequest(ctx) { return Response.json({ room: ctx.params.room }); },
});
