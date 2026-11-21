'use client';

import { useEffect, useRef, useState } from 'react';
type Choice = 'YES' | 'NO' | 'MAYBE';
type Current = { response: Choice | null; version: number; updatedAt: string | null };
type Submission = { response: Choice; expectedVersion: number; requestId: string };
type History = { id: string; response: Choice; revision: number | null; recordedAt: string };

export default function RsvpPanel({ eventId, open }: { eventId: string; open: boolean }) {
  const [current, setCurrent] = useState<Current | null>(null);
  const [choice, setChoice] = useState<Choice>('MAYBE');
  const [rows, setRows] = useState<History[]>([]);
  const [message, setMessage] = useState('Loading your response…');
  const [busy, setBusy] = useState(false);
  const [canRespond, setCanRespond] = useState(open);
  const pending = useRef<Submission | null>(null);
  const path = `/api/v1/participant/events/${encodeURIComponent(eventId)}/rsvp`;
  async function load() {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error('Your access may have expired. Ask the organizer for a new invitation.');
    const data = await response.json(); setCurrent(data.rsvp); setChoice(data.rsvp.response ?? 'MAYBE'); setCanRespond(data.canRespond);
    const history = await fetch(`${path}/history?limit=100`, { cache: 'no-store' });
    if (!history.ok) throw new Error('Unable to load response history.');
    setRows((await history.json()).history);
  }
  useEffect(() => { load().then(() => setMessage('')).catch(error => setMessage(error.message)); }, [eventId]);
  async function save() {
    if (!current || busy) return;
    setBusy(true); setMessage('');
    try {
      pending.current ??= { response: choice, expectedVersion: current.version, requestId: crypto.randomUUID() };
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GroupOS-Request': '1' }, body: JSON.stringify(pending.current) });
      if (response.status === 409) {
        pending.current = null; await load(); setMessage('The response or event changed. Review the current state before submitting again.'); return;
      }
      if (!response.ok) throw new Error('Unable to save. Your access may have expired or the event may be closed.');
      const data = await response.json(); pending.current = null; setCurrent(data.rsvp); setChoice(data.rsvp.response ?? 'MAYBE');
      await load(); setMessage('Your response is saved.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to save. Retry to confirm the result.'); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="rsvp-title">
    <h2 id="rsvp-title">Your RSVP</h2>
    <p>Current response: {current?.response ?? 'Not yet responded'}</p>
    {current && canRespond && <form onSubmit={event => { event.preventDefault(); save(); }}>
      <label htmlFor="rsvp-response">Response</label> <select id="rsvp-response" value={choice} disabled={busy} onChange={event => { setChoice(event.target.value as Choice); pending.current = null; }}>
        <option value="YES">Yes</option><option value="NO">No</option><option value="MAYBE">Maybe</option>
      </select> <button disabled={busy} type="submit">{busy ? 'Saving…' : 'Save RSVP'}</button>
    </form>}
    {!canRespond && <p>This event no longer accepts RSVP changes.</p>}
    <p role="status" aria-live="polite">{message}</p>
    <h3>Response history</h3>
    {rows.length ? <ol>{rows.map(row => <li key={row.id}>{row.response} — {new Date(row.recordedAt).toLocaleString()}</li>)}</ol> : <p>No responses recorded yet.</p>}
    {rows.length === 100 && <p>Showing the first 100 history entries.</p>}
  </section>;
}
