'use client';

import { useEffect, useRef, useState } from 'react';
type Option = { id: string; label: string; startsAt: string | null; endsAt: string | null; amountMinor: number | null; currency: string | null };
type Poll = { id: string; question: string; kind: 'DATE' | 'BUDGET' | 'ACTIVITY'; status: string; version: number; closesAt: string | null; canVote: boolean; options: Option[]; ballot: { version: number; optionIds: string[] } };
type Submission = { optionIds: string[]; expectedVersion: number; expectedPollVersion: number; requestId: string };

function VotingForm({ poll, path, refresh }: { poll: Poll; path: string; refresh: () => Promise<void> }) {
  const [selected, setSelected] = useState(poll.ballot.optionIds);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const pending = useRef<Submission | null>(null);
  useEffect(() => { setSelected(poll.ballot.optionIds); pending.current = null; }, [poll.ballot.version, poll.version]);
  async function save() {
    if (busy || (poll.kind !== 'DATE' && !selected.length)) return;
    setBusy(true); setMessage('');
    try {
      pending.current ??= { optionIds: selected, expectedVersion: poll.ballot.version, expectedPollVersion: poll.version, requestId: crypto.randomUUID() };
      const response = await fetch(`${path}/${poll.id}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GroupOS-Request': '1' }, body: JSON.stringify(pending.current) });
      if (response.status === 409) { pending.current = null; await refresh(); setMessage('The poll or your vote changed. Review before submitting again.'); return; }
      if (!response.ok) throw new Error('Unable to vote. Access may have expired or the poll may be unavailable.');
      pending.current = null; await refresh(); setMessage('Your vote is saved.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to save. Retry to confirm.'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={event => { event.preventDefault(); save(); }}>
    <fieldset disabled={busy || !poll.canVote}>
      <legend>{poll.question}</legend>
      <p>{poll.kind === 'DATE' ? 'Select every time you are available, or leave all unchecked if none work.' : 'Select one preference.'}</p>
      <p>{poll.ballot.version > 0 || poll.ballot.optionIds.length ? 'Your saved choices are shown below.' : 'You have not voted yet.'}</p>
      {poll.options.map(option => <label key={option.id} style={{ display: 'block', marginBottom: '0.75rem' }}>
        <input type={poll.kind === 'DATE' ? 'checkbox' : 'radio'} name={poll.id} checked={selected.includes(option.id)} onChange={event => {
          pending.current = null;
          setSelected(poll.kind === 'DATE' ? (event.target.checked ? [...selected, option.id] : selected.filter(id => id !== option.id)) : [option.id]);
        }} /> {option.label}
        {option.startsAt && option.endsAt && <span> — {new Date(option.startsAt).toLocaleString()} to {new Date(option.endsAt).toLocaleString()} (your local time)</span>}
        {option.amountMinor !== null && option.currency && <span> — {new Intl.NumberFormat(undefined, { style: 'currency', currency: option.currency }).format(option.amountMinor / 100)}</span>}
      </label>)}
      {poll.canVote && <button type="submit" disabled={(poll.kind !== 'DATE' && !selected.length) || busy}>{busy ? 'Saving…' : 'Save vote'}</button>}
    </fieldset>
    {!poll.canVote && <p>This poll is {poll.status === 'CANCELLED' ? 'cancelled' : 'closed for voting'}.</p>}
    {poll.closesAt && <p>Closes: {new Date(poll.closesAt).toLocaleString()}</p>}
    <p role="status" aria-live="polite">{message}</p>
  </form>;
}

export default function PollsPanel({ eventId }: { eventId: string }) {
  const [polls, setPolls] = useState<Poll[]>([]); const [offset, setOffset] = useState(0);
  const [message, setMessage] = useState('Loading polls…'); const [ready, setReady] = useState(false);
  const path = `/api/v1/participant/events/${encodeURIComponent(eventId)}/polls`;
  async function load() {
    const response = await fetch(`${path}?offset=${offset}`, { cache: 'no-store' });
    if (!response.ok) { setPolls([]); setReady(false); throw new Error('Unable to load polls. Ask the organizer for a new invitation if your access expired.'); }
    setPolls((await response.json()).polls); setReady(true); setMessage('');
  }
  useEffect(() => { load().catch(error => setMessage(error.message)); }, [eventId, offset]);
  return <section aria-labelledby="polls-title">
    <h2 id="polls-title">Your preferences</h2>
    {ready && !polls.length && <p>No polls on this page.</p>}
    {polls.map(poll => <VotingForm key={poll.id} poll={poll} path={path} refresh={load} />)}
    <p role="status" aria-live="polite">{message}</p>
    <button type="button" onClick={() => load().catch(error => setMessage(error.message))}>Refresh polls</button>{' '}
    {offset > 0 && <button type="button" onClick={() => setOffset(offset - 20)}>Previous polls</button>}{' '}
    {polls.length === 20 && <button type="button" onClick={() => setOffset(offset + 20)}>More polls</button>}
  </section>;
}
