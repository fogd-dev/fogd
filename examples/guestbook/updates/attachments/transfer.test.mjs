import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot, sha256, encode, MAX_FILE } from './src/transfer-format.ts';

async function fixture() {
  const bytes = Uint8Array.from([0, 255, 128, 1]);
  return { format: 'fogd-guestbook-v1', messages: [{ id: 1, text: 'Saved', createdAt: '2026-10-16' }], attachments: [{ id: '12345678-1234-4234-8234-123456789abc', messageId: 1, name: 'bytes.bin', size: bytes.length, sha256: await sha256(bytes), data: encode(bytes) }] };
}
test('logical profile preserves binary bytes and rejects corrupt or ambiguous input', async () => {
  const valid = await fixture(); assert.deepEqual(await validateSnapshot(valid), valid);
  const mutations = [
    x => { x.format = 'future'; },
    x => { x.attachments[0].data = 'AAAAAA=='; },
    x => { x.attachments[0].messageId = 2; },
    x => { x.attachments[0].size = MAX_FILE + 1; },
    x => { x.messages.push(x.messages[0]); },
    x => { x.attachments.push(x.attachments[0]); },
    x => { x.messages[0].id = Number.MAX_SAFE_INTEGER; },
    x => { x.extra = 'unrecognized'; },
    x => { x.attachments[0].data += '\n'; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(valid); mutate(invalid);
    await assert.rejects(validateSnapshot(invalid));
  }
});
test('logical profile caps total object bytes independently of each attachment', async () => {
  const value = await fixture();
  const bytes = new Uint8Array(MAX_FILE), data = encode(bytes), hash = await sha256(bytes);
  value.attachments = Array.from({ length: 17 }, (_, i) => ({ ...value.attachments[0], id: `12345678-1234-4234-8234-${String(i).padStart(12, '0')}`, size: MAX_FILE, sha256: hash, data }));
  await assert.rejects(validateSnapshot(value), /1 MiB/);
});
test('an export must also fit the encoded import request limit', async () => {
  const value = await fixture();
  value.messages = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, text: '\u0000'.repeat(1000), createdAt: '' }));
  const bytes = new Uint8Array(10485), data = encode(bytes), hash = await sha256(bytes);
  value.attachments = Array.from({ length: 100 }, (_, i) => ({ ...value.attachments[0], id: `12345678-1234-4234-8234-${String(i).padStart(12, '0')}`, name: '\u0000'.repeat(200), size: bytes.length, sha256: hash, data }));
  await assert.rejects(validateSnapshot(value), /2 MiB encoded/);
});
