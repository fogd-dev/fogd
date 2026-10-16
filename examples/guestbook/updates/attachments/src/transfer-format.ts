import { z } from 'zod';

export const MAX_SNAPSHOT = 2 * 1024 * 1024;
export const MAX_FILE = 65536;
export const MAX_TOTAL = 1048576;
const message = z.object({ id: z.number().int().positive().max(2147483647), text: z.string().min(1).max(1000), createdAt: z.string().max(64) }).strict();
export const attachment = z.object({ id: z.string().uuid(), messageId: message.shape.id, name: z.string().min(1).max(200), size: z.number().int().min(0).max(MAX_FILE), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const snapshot = z.object({ format: z.literal('fogd-guestbook-v1'), messages: z.array(message).max(100), attachments: z.array(attachment.extend({ data: z.string().max(87384) })).max(100) }).strict();
export type Snapshot = z.infer<typeof snapshot>;
export const objectKey = (id: string) => `attachments/${id}`;
export async function sha256(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
export const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
export function decode(data: string) {
  const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
  if (encode(bytes) !== data) throw new Error('Noncanonical attachment encoding');
  return bytes;
}
export async function validateSnapshot(value: unknown) {
  const parsed = snapshot.parse(value);
  const ids = new Set(parsed.messages.map(row => row.id));
  if (ids.size !== parsed.messages.length) throw new Error('Duplicate message ID');
  const objectIds = new Set<string>(); let total = 0;
  for (const file of parsed.attachments) {
    if (!ids.has(file.messageId) || objectIds.has(file.id)) throw new Error('Missing message or duplicate attachment ID');
    objectIds.add(file.id);
    const bytes = decode(file.data); total += bytes.length;
    if (bytes.length !== file.size || await sha256(bytes) !== file.sha256) throw new Error('Attachment checksum/size mismatch');
  }
  if (total > MAX_TOTAL) throw new Error('Snapshot exceeds 1 MiB');
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > MAX_SNAPSHOT) throw new Error('Snapshot exceeds 2 MiB encoded');
  return parsed;
}
export const snapshotDigest = (value: Snapshot) => sha256(new TextEncoder().encode(JSON.stringify(value)));
