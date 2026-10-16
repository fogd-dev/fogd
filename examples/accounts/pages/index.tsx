import { useState } from 'react';
import { auth } from 'void/client';
import type { Props } from './index.server';
import './style.css';

export default function Accounts({ user }: Props) {
  const [status, setStatus] = useState('');
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email')), password = String(data.get('password'));
    const action = (event.nativeEvent.submitter as HTMLButtonElement).value;
    const result = action === 'signup' ? await auth.signUp.email({ name: email, email, password }) : await auth.signIn.email({ email, password });
    if (result.error) setStatus(result.error.message || 'Account request failed');
    else location.reload();
  }
  return <main><h1>Accounts</h1>
    {user ? <><p>Signed in as {user.email}</p><button onClick={async () => { await auth.signOut(); location.reload(); }}>Sign out</button></> :
      <form onSubmit={submit}><label htmlFor="email">Email</label><input id="email" name="email" type="email" required />
        <label htmlFor="password">Password</label><input id="password" name="password" type="password" minLength={8} required />
        <button name="action" value="signup">Create account</button><button name="action" value="signin">Sign in</button></form>}
    <button onClick={async () => { const result = await auth.getSession(); setStatus(result.data ? 'Session active' : 'Anonymous'); }}>Check session</button>
    <p role="status">{status}</p>
  </main>;
}
