'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { api, dateLabel, messageOf, type Outing } from './api';
import { Confirm, Notice, Pager } from './forms';
type Participant = { id: string; displayName: string; rsvp: { response: string | null; version: number } };
type Invitation = { id: string; participantId: string; expiresAt: string; revokedAt: string | null; acceptedAt: string | null };
type History = { id: string; response: string; recordedAt: string };
export default function Participants({ event, revision, changed }: { event: Outing; revision: number; changed: () => void }) {
  const [participants, setParticipants] = useState<Participant[]>([]); const [invitations, setInvitations] = useState<Invitation[]>([]); const [offset, setOffset] = useState(0); const [loading, setLoading] = useState(true); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ url: string; id: string } | null>(null); const [selected, setSelected] = useState<Participant | null>(null);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let active = true; setLoading(true); setAvailable(false); setParticipants([]); setInvitations([]); setSelected(null); setMessage('');
    Promise.all([api<{ participants: Participant[] }>(`/events/${event.id}/rsvps?limit=20&offset=${offset}`), api<{ invitations: Invitation[] }>(`/events/${event.id}/invitations`)]).then(([p, i]) => {
      if (!active) return;
      setParticipants(p.participants); setInvitations(i.invitations); setAvailable(true);
      setSecret(current => { const metadata = i.invitations.find(invitation => invitation.id === current?.id); return metadata && !metadata.revokedAt && !metadata.acceptedAt && new Date(metadata.expiresAt) > new Date() ? current : null; });
    }).catch(error => { if (active) { setSecret(null); setMessage(messageOf(error)); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [event.id, offset, revision]);
  useEffect(() => { if (!secret) return; const timer = setTimeout(() => setSecret(null), 120000); const hide = () => { if (document.hidden) setSecret(null); }; document.addEventListener('visibilitychange', hide); return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', hide); }; }, [secret]);
  useEffect(() => { if (event.status !== 'OPEN') setSecret(null); }, [event.status]);
  async function issue(body: unknown) {
    setBusy(true); setSecret(null); setMessage('');
    try { const result = await api<{ invitation: Invitation; invitationUrl: string }>(`/events/${event.id}/invitations`, 'POST', body); setSecret({ url: result.invitationUrl, id: result.invitation.id }); changed(); }
    catch (error) { const failure = new Error(`${messageOf(error)} Refresh before retrying: an interrupted request may already have created a participant or replaced a link.`); setMessage(failure.message); throw failure; }
    finally { setBusy(false); }
  }
  async function add(e: FormEvent<HTMLFormElement>) { e.preventDefault(); const form = e.currentTarget; const values = new FormData(form); try { await issue({ displayName: values.get('displayName'), expiresInHours: Number(values.get('hours')) }); form.reset(); } catch { /* issue reports the error; retain entered values for recovery. */ } }
  async function copy() { try { if (secret) await navigator.clipboard.writeText(secret.url); setMessage('Invitation link copied. Share it only with the intended participant.'); } catch { setMessage('Clipboard unavailable. Select and copy the link manually.'); } }
  return <section aria-label="Participants"><div className="heading"><div><h2>Your group</h2><p className="muted">Follow up on outstanding responses. No messages are sent from this dashboard.</p></div></div>
    {event.status === 'OPEN' && <form className="panel inline-form" onSubmit={add}><label>Participant name<input name="displayName" required maxLength={120} /></label><label>Link validity (hours)<input name="hours" type="number" min={1} max={168} defaultValue={72} required /></label><button className="primary" disabled={busy || loading || !available}>{busy ? 'Creating…' : 'Generate invitation'}</button></form>}
    {secret && available && !loading && <section className="panel secret" aria-label="New invitation link"><h3>Copy this private link now</h3><p>Shown once, hidden after two minutes or when you leave this view. Anyone with this link can accept the invitation.</p><label htmlFor="new-invitation-url">Invitation link</label><textarea id="new-invitation-url" readOnly value={secret.url} onFocus={e => e.currentTarget.select()} /><div className="actions"><button onClick={copy}>Copy invitation link</button><button onClick={() => setSecret(null)}>Hide link</button></div></section>}
    <Notice message={message} />{loading ? <p role="status">Loading participants…</p> : !available ? null : !participants.length ? <div className="panel empty">No participants on this page. Open the event and generate an invitation to add someone.</div> : <div className="participant-list">{participants.map(participant => {
      const invitation = invitations.find(i => i.participantId === participant.id);
      const status = !invitation ? 'No recent invitation metadata' : invitation.revokedAt ? 'Revoked' : new Date(invitation.expiresAt) <= new Date() ? 'Expired' : invitation.acceptedAt ? 'Accepted' : 'Awaiting acceptance';
      return <article className="panel participant" key={participant.id}><div><h3>{participant.displayName}</h3><p><span className="badge">{participant.rsvp.response ?? 'RSVP pending'}</span> <span>{status}</span></p>{invitation && <small>Invitation expires {dateLabel(invitation.expiresAt)}</small>}</div><div className="actions"><button onClick={() => setSelected(participant)}>Response history</button>{event.status === 'OPEN' && <Confirm title={`Reissue for ${participant.displayName}`} detail="This replaces all earlier links and ends this participant’s current session. Copy and share the new link yourself." action={() => issue({ participantId: participant.id, expiresInHours: 72 })} done={() => {}} />}{invitation && !invitation.revokedAt && <Confirm title={`Revoke for ${participant.displayName}`} detail="This ends access through this invitation. Existing responses are retained." action={() => api(`/events/${event.id}/invitations/${invitation.id}/revoke`, 'POST', {})} done={() => { setSecret(null); changed(); }} />}</div></article>;
    })}</div>}
    {invitations.length === 100 && <p className="muted">Invitation status uses the 100 most recent invitations. Older metadata may be unavailable; responses are unaffected.</p>}
    <Pager offset={offset} count={participants.length} change={value => { setSecret(null); setOffset(value); }} />
    {selected && <ResponseHistory key={selected.id} eventId={event.id} participant={selected} close={() => setSelected(null)} />}
  </section>;
}
function ResponseHistory({ eventId, participant, close }: { eventId: string; participant: Participant; close: () => void }) {
  const [rows, setRows] = useState<History[]>([]); const [offset, setOffset] = useState(0); const [message, setMessage] = useState('Loading history…');
  useEffect(() => { let active = true; setRows([]); setMessage('Loading history…'); api<{ history: History[] }>(`/events/${eventId}/participants/${participant.id}/rsvp-history?limit=20&offset=${offset}`).then(data => { if (active) { setRows(data.history); setMessage(''); } }).catch(error => { if (active) setMessage(messageOf(error)); }); return () => { active = false; }; }, [eventId, participant.id, offset]);
  return <section className="panel" aria-label="Response history"><div className="heading"><h3>Response history: {participant.displayName}</h3><button onClick={close}>Close history</button></div><Notice message={message} />{!message && !rows.length && <p>No responses recorded.</p>}<ol>{rows.map(row => <li key={row.id}>{row.response} — {dateLabel(row.recordedAt)}</li>)}</ol><Pager offset={offset} count={rows.length} change={setOffset} /></section>;
}
