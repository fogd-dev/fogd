import { Form, useForm } from '@void/react';
import { useState } from 'react';
import { fetch } from 'void/client';
import type { Props } from './index.server';
import './style.css';

export default function Guestbook({ messages }: Props) {
  const form = useForm('/', { text: '' });
  const [summary, setSummary] = useState('');
  async function refreshSummary() {
    try {
      const saved = await fetch('/api/messages');
      setSummary(`${saved.length} saved messages`);
    } catch {
      setSummary('Could not load messages. Please try again.');
    }
  }
  return (
    <main>
      <h1>Guestbook</h1>
      <p>Leave a message for the next visitor.</p>
      <Form form={form}>
        <label htmlFor="message">Your message</label>
        <input id="message" value={form.data.text} maxLength={1000} required
          onChange={event => form.setData('text', event.target.value)} />
        {form.errors.text && <p role="alert">{form.errors.text}</p>}
        <button disabled={form.pending}>Add message</button>
      </Form>
      <ul aria-label="Messages">
        {messages.map(message => <li key={message.id}>{message.text}</li>)}
      </ul>
      <button onClick={() => { void refreshSummary(); }}>Check saved messages</button>
      <p role="status">{summary}</p>
    </main>
  );
}
