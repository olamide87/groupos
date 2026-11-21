'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, dateLabel, messageOf, type Outing, type Counts } from './api';
import { Confirm, EventForm, Notice, Pager } from './forms';
import Participants from './participants';
import Polls from './polls';
import './dashboard.css';

type User = { id: string; name: string };
export default function Dashboard() {
  const [user, setUser] = useState<User | null>(null); const [checking, setChecking] = useState(true); const [expired, setExpired] = useState(false); const [message, setMessage] = useState('');
  const [selected, setSelected] = useState(''); const [busy, setBusy] = useState(false);
  async function check() { setChecking(true); setMessage(''); try { setUser((await api<{ user: User }>('/auth/me')).user); setExpired(false); } catch (error) { setMessage(messageOf(error)); } finally { setChecking(false); } }
  useEffect(() => {
    const expire = () => { setUser(null); setExpired(true); setSelected(''); };
    window.addEventListener('groupos-session-expired', expire);
    const id = new URLSearchParams(window.location.search).get('event'); if (id && /^[0-9a-f-]{36}$/i.test(id)) setSelected(id);
    check(); return () => window.removeEventListener('groupos-session-expired', expire);
  }, []);
  function select(id: string) { setSelected(id); window.history.replaceState(null, '', id ? `/dashboard?event=${encodeURIComponent(id)}` : '/dashboard'); }
  async function logout() { setBusy(true); setMessage(''); try { await api('/auth/logout', 'POST', {}); setUser(null); setSelected(''); window.location.assign('/account'); } catch (error) { setMessage(messageOf(error)); } finally { setBusy(false); } }
  return <div className="dashboard"><a className="skip" href="#content">Skip to content</a><header className="topbar"><Link className="brand" href="/">GroupOS<span>Organizer workspace</span></Link><nav aria-label="Organizer navigation"><Link href="/dashboard" onClick={event => { event.preventDefault(); select(''); }}>My events</Link>{user && <button disabled={busy} onClick={logout}>Sign out</button>}</nav></header>
    <main id="content" className="workspace">
      {checking ? <p role="status">Checking your session…</p> : !user ? <section className="panel"><h1>{expired ? 'Sign in to continue' : 'Unable to load your workspace'}</h1><Notice message={message || 'Your session has ended. Private event details have been cleared.'} /><Link className="button primary" href="/account">Sign in or register</Link><button onClick={check}>Check session again</button></section> : <>
        <Notice message={message} />{selected ? <EventOverview key={selected} id={selected} back={() => select('')} /> : <Events name={user.name} select={select} />}
      </>}
    </main><footer className="workspace muted">GroupOS · Make room for getting together.</footer></div>;
}
function Events({ name, select }: { name: string; select: (id: string) => void }) {
  const [events, setEvents] = useState<Outing[]>([]); const [offset, setOffset] = useState(0); const [loading, setLoading] = useState(true); const [message, setMessage] = useState(''); const [creating, setCreating] = useState(false);
  useEffect(() => { let active = true; setLoading(true); setEvents([]); setMessage(''); api<{ events: Outing[] }>(`/events?limit=20&offset=${offset}`).then(data => { if (active) setEvents(data.events); }).catch(error => { if (active) setMessage(messageOf(error)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [offset]);
  return <><div className="heading"><div><p className="eyebrow">YOUR PLANS, TOGETHER</p><h1>Hello, {name}.</h1><p className="muted">A clear view of every outing and every response.</p></div><button className="primary" onClick={() => setCreating(true)}>Create event</button></div>
    {creating && <EventForm saved={event => select(event.id)} close={() => setCreating(false)} />}
    <h2>My events</h2><Notice message={message} />{loading ? <p role="status">Loading events…</p> : message ? null : !events.length ? <div className="panel empty"><h3>No events here yet</h3><p>Create an outing, open it for responses, then invite your group.</p></div> : <div className="event-grid">{events.map(event => <article className="panel event-card" key={event.id}><span className={`badge ${event.status.toLowerCase()}`}>{event.status}</span><h3><button className="text-button" onClick={() => select(event.id)}>{event.title}</button></h3><p>{event.location || 'Location to be decided'}</p><p className="muted">{dateLabel(event.startsAt)} · {event.timeZone}</p><button onClick={() => select(event.id)}>Open event</button></article>)}</div>}
    <Pager offset={offset} count={events.length} change={setOffset} />{message && <button onClick={() => window.location.reload()}>Retry loading events</button>}</>;
}
function EventOverview({ id, back }: { id: string; back: () => void }) {
  const [event, setEvent] = useState<Outing | null>(null); const [counts, setCounts] = useState<Counts | null>(null); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(true); const [editing, setEditing] = useState(false); const [tab, setTab] = useState('participants'); const [revision, setRevision] = useState(0);
  const request = useRef(0);
  async function load() {
    const version = ++request.current; setLoading(true); setMessage(''); setEditing(false);
    try {
      const [data, summary] = await Promise.all([api<{ event: Outing }>(`/events/${id}`), api<{ counts: Counts }>(`/events/${id}/rsvps?limit=1`)]);
      if (version === request.current) { setEvent(data.event); setCounts(summary.counts); }
    } catch (error) { if (version === request.current) { setEvent(null); setCounts(null); setMessage(messageOf(error)); } }
    finally { if (version === request.current) setLoading(false); }
  }
  useEffect(() => { load(); return () => { request.current++; }; }, [id, revision]);
  const refresh = () => setRevision(value => value + 1);
  const responded = counts ? counts.total - counts.pending : 0; const rate = counts?.total ? Math.round(responded / counts.total * 100) : 0;
  return <><button className="text-button" onClick={back}>← All events</button><Notice message={message} />{loading && <p role="status">Refreshing event…</p>}{!event ? !loading && <button onClick={load}>Retry event</button> : <fieldset className="event-content" disabled={loading} aria-label="Event workspace" aria-busy={loading}>
    <div className="heading"><div><span className={`badge ${event.status.toLowerCase()}`}>{event.status}</span><h1>{event.title}</h1><p className="muted">{event.location || 'Location to be decided'} · {event.timeZone}</p></div><div className="actions"><button onClick={refresh}>Refresh event</button>{['DRAFT', 'OPEN'].includes(event.status) && <button onClick={() => setEditing(true)}>Edit event</button>}</div></div>
    {editing && <EventForm current={event} close={() => setEditing(false)} saved={updated => { setEvent(updated); setEditing(false); refresh(); }} />}
    <section className="panel overview" aria-label="Event overview"><div><h2>At a glance</h2><p className="preserve-lines">{event.description || 'Add a description to help your group plan.'}</p><p>Starts: {dateLabel(event.startsAt)} · Ends: {dateLabel(event.endsAt)} <small>(your local time)</small></p></div>{event.status !== 'CANCELLED' && <Confirm title="Cancel event" detail="This preserves responses but revokes invitations and stops participation. It cannot be reopened." action={() => api(`/events/${id}/cancel`, 'POST', {})} done={refresh} />}</section>
    {counts && <section aria-label="RSVP summary" className="stats"><div className="stat"><strong>{rate}%</strong><span>RSVP participation</span><small>{responded} of {counts.total} responded</small></div>{(['YES', 'MAYBE', 'NO', 'pending'] as const).map(key => <div className="stat" key={key}><strong>{counts[key]}</strong><span>{key === 'pending' ? 'Outstanding RSVPs' : key}</span></div>)}</section>}
    <nav className="tabs" aria-label="Event sections"><button aria-pressed={tab === 'participants'} onClick={() => setTab('participants')}>Participants & RSVPs</button><button aria-pressed={tab === 'polls'} onClick={() => setTab('polls')}>Polls & decisions</button></nav>
    {tab === 'participants' ? <Participants event={event} revision={revision} changed={refresh} /> : <Polls event={event} />}
  </fieldset>}</>;
}
