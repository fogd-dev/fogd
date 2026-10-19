import { useEffect, useState } from 'react';
import { observeChecklist } from '../lib/live-observer.mjs';
import type { Props } from './index.server';
import './style.css';
type View = { status: string; revision: number; items: Array<{ id: string; text: string; checked: boolean }>; error: string; restored: boolean };
export default function Watch({ room }: Props) {
  const [view, setView] = useState<View>({ status: 'Connecting', revision: 0, items: [], error: '', restored: false });
  useEffect(() => {
    const session = observeChecklist(room, async () => {
      const response = await fetch(`/rooms/${room}`);
      if (!response.ok) throw new Error(`Snapshot request failed (${response.status})`);
      return response.json();
    }, setView);
    return () => session.close();
  }, [room]);
  return <main>
    <p role="note">Experimental SSE observer. Reload to resynchronize with the current board.</p>
    <p className="eyebrow">CHECKLIST OBSERVER</p><h1>Watch a shared board.</h1>
    <p>Room <strong>{room}</strong>. <a href={`/?room=${room}`}>Open the editor</a>.</p>
    <p role="status">{view.status} · Revision {view.revision}</p>
    {view.error && <p role="alert">{view.error}</p>}
    <ul aria-label="Checklist">{view.items.map(item => <li key={item.id}>{item.checked ? '✓' : '○'} {item.text}</li>)}</ul>
    <button onClick={() => location.reload()}>Reload board and accept current state</button>
    <p className="note">Read-only view. Live notifications trigger a fresh board snapshot; missed notifications are recovered after resubscription. This local example has no sign-in.</p>
  </main>;
}
