import { defineLiveStream } from 'void/live';
import { validId } from '../lib/input.mjs';
export const live = defineLiveStream({
  id: 'checklist-hints',
  allowAnonymousControl: true,
  onSubscribe(ctx) {
    if (!validId(ctx.topic)) return new Response('Invalid room', { status: 400 });
  },
});
