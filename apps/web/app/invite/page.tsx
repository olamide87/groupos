'use client';

import { useEffect, useRef, useState } from 'react';
import RsvpPanel from './rsvp-panel';
import PollsPanel from './polls-panel';

type Details = { event: { title: string; description: string | null; location: string | null; startsAt: string | null; timeZone: string; status: string }; participant: { displayName: string } };
export default function Invitation() {
  const [eventId, setEventId] = useState('');
  const [token, setToken] = useState('');
  const [details, setDetails] = useState<Details | null>(null);
  const [message, setMessage] = useState('Loading invitation…');
  const [busy, setBusy] = useState(false);
  const initialized = useRef(false);
  async function view(id: string) {
    const response = await fetch(`/api/v1/participant/events/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Access is unavailable. Ask your organizer for a new invitation.');
    setDetails(await response.json()); setMessage('');
  }
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const id = fragment.get('event') ?? new URLSearchParams(window.location.search).get('event') ?? '';
    const raw = fragment.get('token') ?? '';
    setEventId(id); setToken(raw);
    // Do not auto-consume links (mail scanners/prefetch and React effect replay).
    window.history.replaceState(null, '', `/invite${id ? `?event=${encodeURIComponent(id)}` : ''}`);
    if (raw) setMessage('Accept this invitation to view your outing.');
    else if (id) view(id).catch(error => setMessage(error.message));
    else setMessage('Open the invitation link shared by your organizer.');
  }, []);
  async function accept() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/participant/events/${encodeURIComponent(eventId)}/accept`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GroupOS-Request': '1' }, body: JSON.stringify({ token }) });
      if (!response.ok) throw new Error('This invitation is unavailable or has already been used. Ask your organizer for a new link.');
      setToken(''); await view(eventId);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to accept invitation.'); }
    finally { setBusy(false); }
  }
  return <main style={{ maxWidth: 640, margin: '8vh auto', padding: 24, fontFamily: 'system-ui', lineHeight: 1.6 }}>
    <h1>{details?.event.title ?? 'Your GroupOS invitation'}</h1>
    {details && <section>
      <p>Welcome, {details.participant.displayName}.</p>
      <p>{details.event.description}</p><p>{details.event.location ?? 'Location to be decided'}</p>
      <p>{details.event.startsAt ? new Date(details.event.startsAt).toLocaleString(undefined, { timeZone: details.event.timeZone }) : 'Date to be decided'} ({details.event.timeZone})</p>
      <RsvpPanel eventId={eventId} open={details.event.status === 'OPEN'} />
      <PollsPanel eventId={eventId} />
    </section>}
    <p role="status" aria-live="polite">{message}</p>
    {token && <button disabled={busy} onClick={accept}>{busy ? 'Accepting…' : 'Accept invitation'}</button>}
  </main>;
}
