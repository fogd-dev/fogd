import { useState } from 'react';
import { fetch as api } from 'void/client';

export default function Attachments({ messages }: { messages: { id: number; text: string }[] }) {
  const [status, setStatus] = useState('');
  const [files, setFiles] = useState<Awaited<ReturnType<typeof loadFiles>>>([]);
  async function loadFiles() { return api('/api/attachments'); }
  async function upload(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const response = await globalThis.fetch('/api/attachments', { method: 'POST', body: new FormData(form) });
      if (!response.ok) throw new Error(`Upload failed (HTTP ${response.status})`);
      setFiles(await loadFiles()); setStatus('Attachment saved'); form.reset();
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Upload failed'); }
  }
  return <section><h2>Attachments</h2><form onSubmit={upload}>
    <label htmlFor="attachment-message">Message</label>
    <select id="attachment-message" name="messageId" required>{messages.map(message => <option key={message.id} value={message.id}>{message.text}</option>)}</select>
    <label htmlFor="attachment-file">File (up to 64 KiB)</label><input id="attachment-file" name="file" type="file" required />
    <button disabled={!messages.length}>Upload attachment</button>
  </form><button onClick={async () => { try { setFiles(await loadFiles()); setStatus('Attachments loaded'); } catch { setStatus('Could not load attachments'); } }}>Load attachments</button>
  <p aria-label="Attachment status">{status}</p><ul aria-label="Attachments">{files.map(file => <li key={file.id}><a href={`/api/download?id=${file.id}`}>{file.name}</a> ({file.size} bytes)</li>)}</ul></section>;
}
