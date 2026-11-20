'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';

type Mode = 'login' | 'signup' | 'forgot' | 'reset';
type User = { id: string; email: string; name: string };

export default function Account() {
  const [mode, setMode] = useState<Mode>('login');
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const reset = fragment.get('reset');
    if (reset) {
      setToken(reset); setMode('reset');
      window.history.replaceState(null, '', window.location.pathname);
    }
    fetch('/api/v1/auth/me', { cache: 'no-store' })
      .then(async response => { if (response.ok && !reset) setUser((await response.json()).user); })
      .catch(() => setMessage('Unable to reach GroupOS. Please try again.'))
      .finally(() => setChecking(false));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/v1/auth/${mode}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GroupOS-Request': '1' },
        body: JSON.stringify({ ...values, ...(mode === 'reset' ? { token } : {}) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Unable to complete this request');
      if (data.user) { setUser(data.user); window.location.assign('/dashboard'); }
      setMessage(data.message ?? 'You are signed in.');
      form.reset();
      if (mode === 'signup' || mode === 'reset') { setMode('login'); setToken(''); }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to complete this request'); }
    finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    try {
      const response = await fetch('/api/v1/auth/logout', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GroupOS-Request': '1' }, body: '{}' });
      if (!response.ok) throw new Error('Unable to sign out. Please try again.');
      setUser(null); setMode('login'); setMessage('You are signed out.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to sign out'); }
    finally { setBusy(false); }
  }

  const title = { login: 'Welcome back', signup: 'Create your organizer account', forgot: 'Recover your account', reset: 'Choose a new password' }[mode];
  const button = { login: 'Sign in', signup: 'Create account', forgot: 'Send reset instructions', reset: 'Update password' }[mode];
  return <main style={{ maxWidth: 480, margin: '8vh auto', padding: 24, fontFamily: 'system-ui', lineHeight: 1.6 }}>
    <Link href="/">GroupOS</Link>
    <h1>{user ? `Welcome, ${user.name}` : title}</h1>
    {checking ? <p>Checking your session…</p> : user ? <section>
      <p>Signed in as {user.email}.</p><p><Link href="/dashboard">Open organizer dashboard</Link></p>
      <button disabled={busy} onClick={logout}>Sign out</button>
    </section> : <>
      <form key={mode} onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
        {mode === 'signup' && <label>Name<input name="name" autoComplete="name" required maxLength={120} style={{ display: 'block', width: '100%', padding: 10, boxSizing: 'border-box' }} /></label>}
        {mode !== 'reset' && <label>Email<input name="email" type="email" autoComplete="email" required maxLength={254} style={{ display: 'block', width: '100%', padding: 10, boxSizing: 'border-box' }} /></label>}
        {mode !== 'forgot' && <><label>Password<input name="password" type="password" required minLength={15} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} aria-describedby="password-hint" style={{ display: 'block', width: '100%', padding: 10, boxSizing: 'border-box' }} /></label><small id="password-hint">Use 15–128 characters. Spaces and password managers are welcome.</small></>}
        <button disabled={busy} type="submit" style={{ padding: 12 }}>{busy ? 'Please wait…' : button}</button>
      </form>
      <nav aria-label="Account options" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 24 }}>
        {(['login', 'signup', 'forgot'] as Mode[]).filter(value => value !== mode).map(value => <button key={value} disabled={busy} onClick={() => { setMode(value); setMessage(''); }}>{({ login: 'Sign in', signup: 'Create account', forgot: 'Forgot password?', reset: '' })[value]}</button>)}
      </nav>
    </>}
    <p role="status" aria-live="polite">{message}</p>
  </main>;
}
