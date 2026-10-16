import assert from 'node:assert/strict';
import { chromium, expect } from './guestbook-browser.mjs';

export async function uploadAttachment(url, message, bytes) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await expect(async () => {
      await page.getByRole('button', { name: 'Load attachments' }).click();
      await expect(page.getByLabel('Attachment status')).toHaveText('Attachments loaded');
    }).toPass({ timeout: 30000 });
    await page.getByLabel('Message', { exact: true }).selectOption({ label: message });
    await page.getByLabel('File (up to 64 KiB)').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: bytes });
    await page.getByRole('button', { name: 'Upload attachment' }).click();
    await expect(page.getByLabel('Attachment status')).toHaveText('Attachment saved');
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'note.txt' }).click();
    const stream = await (await download).createReadStream(); const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
  } finally { await browser.close(); }
}
