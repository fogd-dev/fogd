import { z } from 'zod';
export const ServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), revision: z.number(), release: z.string(), items: z.array(z.object({ id: z.string(), text: z.string(), checked: z.boolean() })) }),
  z.object({ type: z.literal('ack'), opId: z.string(), revision: z.number(), release: z.string() }),
  z.object({ type: z.literal('rejected'), opId: z.string(), reason: z.string(), release: z.string() }),
]);
