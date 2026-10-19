import { useEffect, useRef, useState } from 'react';
import { connect } from 'void/ws';
import { ChecklistSession } from '../lib/session.mjs';
import type { Props } from './index.server';
import './style.css';

type View = { status: string; revision: number; items: Array<{ id: string; text: string; checked: boolean }>; pending: number; error: string; canAcceptRestored?: boolean };
export default function Checklist({ room }: Props) {
  const [view, setView] = useState<View>({ status: 'Connecting', revision: 0, items: [], pending: 0, error: '' });
  const [text, setText] = useState('');
  const session = useRef<ChecklistSession | null>(null);
  useEffect(() => {
    let socket: ReturnType<typeof connect<'/rooms/:room'>>;
    let model: ChecklistSession;
    try { model = new ChecklistSession(localStorage, room, (message: Parameters<typeof socket.send>[0]) => { if (!socket.sendIfOpen(message)) throw new Error('Socket is not open'); }, setView); }
    catch (error) { setView(current => ({ ...current, status: 'Writes stopped', error: String(error) })); return; }
    socket = connect('/rooms/:room', { params: { room } });
    session.current = model;
    const remove = [socket.on('open', () => model.opened()), socket.on('close', () => model.disconnected()), socket.on('message', event => model.receive(event))];
    const storage = () => model.storageChanged(); window.addEventListener('storage', storage);
    return () => { remove.forEach(fn => fn()); window.removeEventListener('storage', storage); socket.close(); session.current = null; };
  }, [room]);
  function submit(operation: unknown) {
    if (!session.current) return false;
    try { session.current.submit(crypto.randomUUID(), operation); return true; }
    catch { return false; }
  }
  return <main>
    <p className="eyebrow">SHARED CHECKLIST</p><h1>A small board, kept together.</h1>
    <p>Room <strong>{room}</strong>. Open this URL in another browser to collaborate.</p>
    <p role="status">{view.status} · Revision {view.revision} · {view.pending} pending</p>
    {view.error && <p role="alert">{view.error}</p>}
    {view.canAcceptRestored && <button onClick={() => session.current?.acceptRestored()}>Accept restored state and retry pending edits</button>}
    <form onSubmit={event => { event.preventDefault(); if (submit({ kind: 'add', itemId: crypto.randomUUID(), text })) setText(''); }}>
      <label htmlFor="new-item">New item</label>
      <div className="entry"><input id="new-item" value={text} maxLength={160} required onChange={event => setText(event.target.value)} /><button disabled={view.status === 'Writes stopped'}>Add item</button></div>
    </form>
    <ul aria-label="Checklist">{view.items.map(item => <li key={item.id}><label><input type="checkbox" checked={item.checked} disabled={view.status === 'Writes stopped'} onChange={event => submit({ kind: 'set', itemId: item.id, checked: event.target.checked })} />{item.text}</label></li>)}</ul>
    {!view.items.length && <p>No saved items yet.</p>}
    <p className="note">Pending edits stay in this browser until acknowledged. Offline edits appear on the board after reconnecting. This local example has no sign-in.</p>
  </main>;
}
