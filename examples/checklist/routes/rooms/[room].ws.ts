import { z } from 'zod';
import { defineRoom } from 'void/ws';
import { ServerMessage } from '../../lib/wire.mjs';
import { Board } from '../../lib/board.mjs';

const wire = (message: unknown) => ServerMessage.parse({ ...(message as Record<string, unknown>), release: 'v1' });

const validRoom = (room: string) => /^[a-z0-9-]{1,64}$/.test(room);

export default defineRoom({
  name: 'checklist',
  messages: {
    // Semantic failures are typed replies, not reconnect-inducing schema closes.
    client: z.object({ type: z.literal('operation'), opId: z.string(), operation: z.unknown() }),
    server: ServerMessage,
  },
  onBeforeConnect(ctx) {
    const url = new URL(ctx.request.url);
    const host = ctx.request.headers.get('x-forwarded-host') || url.host;
    const protocol = ctx.request.headers.get('x-forwarded-proto') || url.protocol.slice(0, -1);
    if (ctx.request.headers.get('origin') !== `${protocol}://${host}`) return new Response('Forbidden origin', { status: 403 });
    if (!validRoom(ctx.params.room)) return new Response('Invalid room', { status: 400 });
  },
  async onConnect(ctx) { await ctx.connection.send(wire(new Board(ctx.storage).snapshot())); },
  async onMessage(ctx, event) {
    const board = new Board(ctx.storage);
    const result = board.apply(event.opId, event.operation);
    const snapshot = result.type === 'ack' ? wire(board.snapshot()) : null;
    try {
      await ctx.connection.send(wire(result));
      if (snapshot) await ctx.connection.send(snapshot);
    } catch { console.warn('Checklist sender disconnected before reply'); }
    // Exclude the sender so its disconnect cannot prevent peer notification.
    if (snapshot) await ctx.room.broadcast(snapshot, [ctx.connection.id]);
  },
  onRequest(ctx) {
    if (!validRoom(ctx.params.room)) return new Response('Invalid room', { status: 400 });
    if (ctx.request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    return Response.json(wire(new Board(ctx.storage).snapshot()));
  },
});
