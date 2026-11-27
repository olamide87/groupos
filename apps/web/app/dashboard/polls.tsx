'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, dateLabel, messageOf, type Outing } from './api';
import { Confirm, Notice, Pager } from './forms';
type Option = { id?: string; label: string; startsAt?: string | null; endsAt?: string | null; amountMinor?: number | null; currency?: string | null };
type Poll = { id: string; question: string; kind: string; version: number; status: string; closesAt: string | null; options: Option[] };
type Results = { poll: Poll; total: number; responded: number; pending: number; counts: { optionId: string; count: number }[] };
export default function Polls({ event }: { event: Outing }) {
  const [polls, setPolls] = useState<Poll[]>([]); const [offset, setOffset] = useState(0); const [revision, setRevision] = useState(0); const [loading, setLoading] = useState(true); const [message, setMessage] = useState(''); const [creating, setCreating] = useState(false);
  const refresh = () => setRevision(value => value + 1);
  useEffect(() => { let active = true; setLoading(true); setPolls([]); setCreating(false); setMessage(''); api<{ polls: Poll[] }>(`/events/${event.id}/polls?offset=${offset}`).then(data => { if (active) setPolls(data.polls); }).catch(error => { if (active) setMessage(messageOf(error)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [event.id, offset, revision]);
  const editable = !loading && !message && ['DRAFT', 'OPEN'].includes(event.status);
  return <section aria-label="Polls"><div className="heading"><div><h2>Decisions to make</h2><p className="muted">Collect availability and preferences before settling the plan.</p></div>{editable && <button className="primary" onClick={() => setCreating(true)}>Create poll</button>}</div>
    {creating && <PollForm eventId={event.id} close={() => setCreating(false)} saved={() => { setCreating(false); refresh(); }} />}
    <Notice message={message} />{loading ? <p role="status">Loading polls…</p> : message ? null : !polls.length ? <div className="panel empty">No polls on this page. Create a date, budget or activity poll to start a decision.</div> : polls.map(poll => <PollCard key={`${poll.id}-${poll.version}-${revision}`} poll={poll} eventId={event.id} editable={editable} changed={refresh} />)}
    <div className="actions"><button onClick={refresh}>Refresh polls</button><Pager offset={offset} count={polls.length} change={setOffset} /></div>
  </section>;
}
function PollCard({ poll, eventId, editable, changed }: { poll: Poll; eventId: string; editable: boolean; changed: () => void }) {
  const [results, setResults] = useState<Results | null>(null); const [message, setMessage] = useState('Loading results…'); const [editing, setEditing] = useState(false);
  async function load() { setResults(null); setEditing(false); setMessage('Loading results…'); try { setResults(await api<Results>(`/events/${eventId}/polls/${poll.id}/results`)); setMessage(''); } catch (error) { setMessage(messageOf(error)); } }
  useEffect(() => { load(); }, [eventId, poll.id]);
  const closed = poll.status !== 'OPEN' || (!!poll.closesAt && new Date(poll.closesAt) <= new Date());
  return <article className="panel" aria-label={poll.question}><div className="heading"><div><span className="badge">{poll.kind} · {poll.status === 'OPEN' && closed ? 'DEADLINE PASSED' : poll.status}</span><h3>{poll.question}</h3><p className="muted">{poll.closesAt ? `Closes ${dateLabel(poll.closesAt)}` : 'No closing deadline'}</p></div><div className="actions">{editable && !closed && results && <button onClick={() => setEditing(true)}>Edit poll</button>}{editable && results && poll.status === 'OPEN' && <Confirm title="Close poll" detail="Voting will stop. Existing results remain available and this poll cannot reopen." action={() => api(`/events/${eventId}/polls/${poll.id}/close`, 'POST', { expectedVersion: poll.version })} done={changed} />}{editable && results && poll.status !== 'CANCELLED' && <Confirm title="Cancel poll" detail="Cancel this decision and retain its results. Participants will no longer be able to vote." action={() => api(`/events/${eventId}/polls/${poll.id}/cancel`, 'POST', { expectedVersion: poll.version })} done={changed} />}</div></div>
    {editing && <PollForm eventId={eventId} current={poll} frozen={!!results?.responded} close={() => setEditing(false)} saved={changed} />}
    <Notice message={message} />{results ? <><p><strong>{results.responded} of {results.total} responded</strong> · {results.pending} outstanding · {results.total ? Math.round(results.responded / results.total * 100) : 0}% participation</p><div className="result-list">{poll.options.map(option => { const count = results.counts.find(c => c.optionId === option.id)?.count ?? 0; return <div key={option.id}><div className="result-label"><span>{option.label}{option.startsAt && ` · ${dateLabel(option.startsAt)} – ${dateLabel(option.endsAt ?? null)}`}{option.amountMinor != null && ` · ${(option.amountMinor / 100).toFixed(2)} ${option.currency}`}</span><strong>{count} votes</strong></div><progress aria-label={`${option.label} votes`} value={count} max={Math.max(results.total, 1)} /></div>; })}</div>{poll.kind === 'DATE' && <small>Participants may select multiple times or none. Option totals can differ from the number of respondents.</small>}</> : message && <button onClick={load}>Retry results</button>}
  </article>;
}
function PollForm({ eventId, current, frozen = false, close, saved }: { eventId: string; current?: Poll; frozen?: boolean; close: () => void; saved: () => void }) {
  const formId = useId();
  const [kind, setKind] = useState(current?.kind ?? 'ACTIVITY'); const [options, setOptions] = useState<Option[]>(current?.options ?? [{ label: '' }, { label: '' }]); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  function update(index: number, change: Partial<Option>) { setOptions(rows => rows.map((row, i) => i === index ? { ...row, ...change } : row)); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true); setMessage('');
    try {
      const closesAt = values.get('closesAt') ? new Date(`${values.get('closesAt')}Z`).toISOString() : null;
      const choices = frozen ? undefined : options.map(option => ({ label: option.label, ...(kind === 'DATE' ? { startsAt: new Date(option.startsAt!).toISOString(), endsAt: new Date(option.endsAt!).toISOString() } : kind === 'BUDGET' ? { amountMinor: option.amountMinor, currency: values.get('currency') } : {}) }));
      const body = current ? { expectedVersion: current.version, closesAt, ...(!frozen ? { question: values.get('question'), options: choices } : {}) } : { question: values.get('question'), kind, closesAt, options: choices };
      await api(current ? `/events/${eventId}/polls/${current.id}` : `/events/${eventId}/polls`, current ? 'PATCH' : 'POST', body); saved();
    } catch (error) { setMessage(`${messageOf(error)} If the poll changed, discard edits and refresh before trying again.`); } finally { setBusy(false); }
  }
  return <form className="panel form-grid" aria-label={current ? 'Edit poll' : 'Create poll'} onSubmit={submit}><h3>{current ? 'Edit decision' : 'New decision'}</h3>
    <label>Poll question<input name="question" required maxLength={300} defaultValue={current?.question} disabled={frozen} /></label>
    <div><label htmlFor={`${formId}-kind`}>Poll type</label><select id={`${formId}-kind`} value={kind} disabled={!!current} onChange={e => { setKind(e.target.value); setOptions([{ label: '' }, { label: '' }]); }}><option value="ACTIVITY">Activity preference</option><option value="DATE">Date and time availability</option><option value="BUDGET">Budget preference</option></select></div>
    {frozen && <p>Voting has begun. The question and options are locked; you can still change a future deadline.</p>}
    {kind === 'BUDGET' && <div><label htmlFor={`${formId}-currency`}>Currency</label><select id={`${formId}-currency`} name="currency" disabled={frozen} defaultValue={current?.options[0]?.currency ?? 'USD'}>{['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'NGN'].map(c => <option key={c}>{c}</option>)}</select></div>}
    {!frozen && <>{options.map((option, index) => <fieldset key={index}><legend>Option {index + 1}</legend><label>Label<input value={option.label} required maxLength={200} onChange={e => update(index, { label: e.target.value })} /></label>{kind === 'DATE' && <div className="columns"><label>Starts at (UTC)<input type="datetime-local" step="0.001" required value={option.startsAt?.replace(/Z$/, '') ?? ''} onChange={e => update(index, { startsAt: e.target.value ? `${e.target.value}Z` : null })} /></label><label>Ends at (UTC)<input type="datetime-local" step="0.001" required value={option.endsAt?.replace(/Z$/, '') ?? ''} onChange={e => update(index, { endsAt: e.target.value ? `${e.target.value}Z` : null })} /></label></div>}{kind === 'BUDGET' && <label>Amount<input type="number" required min={0} step="0.01" value={option.amountMinor == null ? '' : option.amountMinor / 100} onChange={e => update(index, { amountMinor: e.target.value === '' ? null : Math.round(Number(e.target.value) * 100) })} /></label>}<button type="button" disabled={options.length <= 2} onClick={() => setOptions(rows => rows.filter((_, i) => i !== index))}>Remove option {index + 1}</button></fieldset>)}<button type="button" disabled={options.length >= 20} onClick={() => setOptions(rows => [...rows, { label: '' }])}>Add option</button></>}
    <label>Closing deadline (UTC, optional)<input name="closesAt" type="datetime-local" step="0.001" defaultValue={current?.closesAt?.replace(/Z$/, '')} /></label><div className="actions"><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save poll'}</button><button type="button" disabled={busy} onClick={close}>Discard poll edits</button></div><Notice message={message} />
  </form>;
}
