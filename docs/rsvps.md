# Participant RSVP and response history (GOS-006)

Participants use the invitation session to submit YES, NO or MAYBE without an
organizer account. Acceptance alone never creates an RSVP or notification consent.
The `/invite` page displays the current response, a response selector and history.
No participant messages are sent.

## Participant API

All routes require a valid participant cookie scoped to the event. The API derives
participant identity from that session; client-supplied identities are rejected.
Responses are private/no-store. Unknown, expired, revoked, cancelled, draft or
cross-event access returns the invitation API's generic 404.

| Route | Result |
| --- | --- |
| `GET /api/v1/participant/events/:eventId/rsvp` | `rsvp` containing response (null when pending), version and updatedAt; `canRespond` indicates an OPEN event |
| `POST /api/v1/participant/events/:eventId/rsvp` | Submit the body below; returns current `rsvp`, `changed` and `replayed` |
| `GET /api/v1/participant/events/:eventId/rsvp/history` | Own history only, with optional limit/offset |

```json
{ "response": "YES", "expectedVersion": 0, "requestId": "8d56f6fa-7d01-4c39-99a8-581155bcd18b" }
```

POST requires JSON, the exact AUTH_ORIGIN, and `X-GroupOS-Request: 1`. Generate a
fresh UUID requestId for each user intent. Retain the same complete payload for
network retries. Initial version is 0; use the version returned by GET/submission
for subsequent edits. The API rejects unknown fields, nested values, other response
strings and noninteger/negative versions. Only OPEN events accept writes; FINALIZED
events allow reads but return 409 on writes. Cancellation preserves all response data.

## Retry, conflict and history semantics

Each request ID is scoped to its participant. Repeating the same ID and payload
returns the latest current state with `replayed: true`, without reapplying the old
intent. Thus retrying an earlier YES after a later NO does not overwrite NO.
Reusing an ID with a different response/version returns 409. A fresh ID with a
stale expectedVersion also returns 409; reload and ask the participant to review
their intent before resubmission. Failed/conflicting attempts do not reserve IDs.

A valid new request for the already-current response is a no-op: no new revision,
history, timestamp change or audit entry, but the request ID is recorded. A changed
response increments the version and appends one immutable history row, retaining
all previous responses. The API has no history-edit/delete endpoint.

Current state, new history, audit and request ledger are committed in one database
transaction. RSVP writes take an exclusive event row lock **before** session
validation, using `withParticipant(..., true)`. This serializes RSVP writes with
invitation revocation/reissue and cancellation. Reads use shared event locks.
This deliberately favors simple consistency for 8–12-person groups over maximum
write throughput. An operation already authorized may complete before a racing
cancellation commits; after cancellation/revocation completes, no new write is
authorized. Distinct simultaneous edits from the same version have one winner;
the other receives 409. Identical concurrent retries produce one history entry.

The participant form keeps an in-memory retry payload, disables saves while busy,
and refreshes state after a 409 rather than silently overwriting another update.
Reloading discards a pending browser payload; GET retrieves committed server state.
The page shows the first 100 history entries; API pagination exposes later entries.

## Organizer API

`GET /api/v1/events/:eventId/rsvps` requires the event owner's organizer session.
It returns counts (`total`, `YES`, `NO`, `MAYBE`, `pending`) plus a page of participant
IDs/displayNames and current responses/versions. Counts cover the entire event,
independent of pagination. Pending means a participant has no RSVP row. Revoked
invitations do not erase participants or their responses. No email addresses,
invitation secrets or session fields are returned.

`GET /api/v1/events/:eventId/participants/:participantId/rsvp-history` exposes that
participant's history only to the event owner. Missing and non-owned event or
participant combinations return 404. A participant cookie never grants organizer
access. Owners may inspect history after cancellation/finalization.

History and organizer summary pagination default to limit 20/offset 0, with bounds
of 100/10000; unknown/repeated query fields are rejected. New history is ordered by
revision. Legacy unversioned history appears first, ordered by timestamp then ID.
Summaries hold a shared event lock while gathering counts and rows, so supported
API writes cannot change the snapshot between those queries. Direct database
writes outside these locking contracts are not supported operational behavior.

## Migration and verification

The generated additive migration adds Rsvp.version (default 0), nullable history
revision with a participant/revision unique index, and RsvpSubmission with a
participant/requestId primary key. Existing response and history rows remain
unchanged, with legacy revision null; versioned edits begin at 1. No legacy history
is fabricated. The migration runner verifies preservation, repeat deployment and
empty drift on disposable PostgreSQL.

The integration suite covers all choices and history order, duplicate and late
retries, no-ops, stale conflicts, concurrency, authorization, expiry/revocation,
cancellation races, owner summaries/history, CSRF/validation and transaction
rollback on an injected history constraint failure. Run the README's complete
verification commands. Test participants and cookies are synthetic.

No dependencies or environment variables were added. The request ledger and
history are retained; a reviewed personal-data retention policy, abuse/edge limits
and production operations remain GOS-013 work. Do not prune request IDs within
the advertised retry window without defining a replacement contract. Existing
dependency advisories and browser/production-readiness blockers remain unresolved.
