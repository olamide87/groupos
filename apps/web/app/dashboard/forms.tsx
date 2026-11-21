'use client';
import { useId, useState, type FormEvent } from 'react';
import { api, messageOf, type Outing } from './api';

export function Notice({ message }: { message: string }) { return <p className="notice" role="status" aria-live="polite">{message}</p>; }
export function Pager({ offset, count, size = 20, change }: { offset: number; count: number; size?: number; change: (value: number) => void }) {
  return <nav className="actions" aria-label="Pagination"><button disabled={!offset} onClick={() => change(offset - size)}>Previous</button><span>Page {offset / size + 1}</span><button disabled={count < size} onClick={() => change(offset + size)}>Next</button></nav>;
}
export function Confirm({ title, detail, action, done }: { title: string; detail: string; action: () => Promise<unknown>; done: () => void }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  async function confirm() { setBusy(true); try { await action(); setOpen(false); done(); } catch (error) { setMessage(messageOf(error)); } finally { setBusy(false); } }
  return <div className="confirmation"><button className="danger" onClick={() => setOpen(true)} disabled={busy}>{title}</button>{open && <div role="group" aria-label={`Confirm ${title}`}><p>{detail}</p><div className="actions"><button className="danger" disabled={busy} onClick={confirm}>Confirm {title.toLowerCase()}</button><button disabled={busy} onClick={() => { setOpen(false); setMessage(''); }}>Keep unchanged</button></div><Notice message={message} /></div>}</div>;
}
export function EventForm({ current, saved, close }: { current?: Outing; saved: (event: Outing) => void; close: () => void }) {
  const formId = useId();
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); setBusy(true); setMessage('');
    try {
      const data = { title: values.title, description: values.description || null, location: values.location || null, timeZone: values.timeZone, status: values.status,
        startsAt: values.startsAt ? new Date(`${values.startsAt}Z`).toISOString() : null, endsAt: values.endsAt ? new Date(`${values.endsAt}Z`).toISOString() : null };
      const result = await api<{ event: Outing }>(current ? `/events/${current.id}` : '/events', current ? 'PATCH' : 'POST', data); saved(result.event);
    } catch (error) { setMessage(messageOf(error)); } finally { setBusy(false); }
  }
  return <form className="panel form-grid" onSubmit={submit} aria-label={current ? 'Edit event' : 'Create event'}>
    <h2>{current ? 'Edit event' : 'Create an event'}</h2>
    <label>Event title<input name="title" required maxLength={200} defaultValue={current?.title} /></label>
    <div><label htmlFor={`${formId}-description`}>Description</label><textarea id={`${formId}-description`} name="description" maxLength={4000} defaultValue={current?.description ?? ''} /></div>
    <label>Location<input name="location" maxLength={300} defaultValue={current?.location ?? ''} /></label>
    <div className="columns"><label>Starts at (UTC)<input name="startsAt" type="datetime-local" step="0.001" defaultValue={current?.startsAt?.replace(/Z$/, '')} /></label><label>Ends at (UTC)<input name="endsAt" type="datetime-local" step="0.001" defaultValue={current?.endsAt?.replace(/Z$/, '')} /></label></div>
    <label>Display time zone<input name="timeZone" required maxLength={80} defaultValue={current?.timeZone ?? 'UTC'} placeholder="America/Chicago" /></label>
    <div><label htmlFor={`${formId}-status`}>Event status</label><select id={`${formId}-status`} name="status" defaultValue={current?.status ?? 'DRAFT'}><option value="DRAFT">Draft</option><option value="OPEN">Open for responses</option></select></div>
    <p className="muted">Use UTC for the schedule. The display time zone controls how invitees see it. Open the event before issuing invitations.</p>
    <div className="actions"><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save event'}</button><button type="button" disabled={busy} onClick={close}>Discard edits</button></div><Notice message={message} />
  </form>;
}
