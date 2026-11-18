# Secure participant invitations (GOS-005)

Organizers issue links for an individual event participant. No participant account
or email provider is required. Nothing sends messages: the organizer receives the
link once and shares it through an explicitly approved channel outside this API.
Possession of a link authorizes access; it does not verify a person's identity or
email ownership. Forwarding a link transfers that capability until it is used.

## Organizer API

Every route requires an organizer session. Mutations require the same exact Origin,
JSON body and `X-GroupOS-Request: 1` CSRF protection as events/authentication.

| Route | Contract |
| --- | --- |
| `POST /api/v1/events/:eventId/invitations` | `{ "displayName": "Guest", "expiresInHours": 72 }` creates a participant and link; alternatively provide `participantId` instead of displayName to reissue for an existing participant |
| `GET /api/v1/events/:eventId/invitations` | Most recent 100 metadata records, including participant ID, expiry, acceptance/revocation; never raw tokens or hashes |
| `POST /api/v1/events/:eventId/invitations/:id/revoke` | Empty JSON object; idempotent 204, invalidating link and associated session |

Only the event owner can issue/list/revoke. Cross-account events and mismatched
invitation/participant IDs return 404. Issuance requires an OPEN event. Unknown
fields, nested writes, display names outside 1–120 characters, and fractional or
out-of-range expiry values are rejected. Expiry defaults to 72 hours and is bounded
to 1–168 hours. Reissue revokes all prior invitations for the same participant,
including their established sessions. Concurrent reissues serialize; only the
last-issued link remains active. Failed transactions return no bearer link.

The 201 response includes invitation metadata and `invitationUrl`. The URL is
`${AUTH_ORIGIN}/invite#event=<uuid>&token=<random-token>`: bearer data stays in the
fragment, outside HTTP request URLs and Referer headers. The raw token is not
recoverable through listing, audit records, storage or logs. If it is lost, reissue.
Response bodies containing links must be excluded from any external proxy/APM logs.

## Participant exchange and access

The `/invite` page reads the fragment, removes it from browser history, and keeps
the token only in component memory. It does not automatically accept links on
load, prefetch, or repeated React effects. The user explicitly clicks **Accept
invitation**. The page disallows framing and sets a no-referrer policy. No tokens
are stored in localStorage/sessionStorage. Reloading before acceptance discards
the in-memory token; reopen the original unused link if needed.

`POST /api/v1/participant/events/:eventId/accept` accepts exactly `{ "token": "..." }`
with the same Origin/JSON/custom-header checks. Successful acceptance consumes the
invitation once and creates a separate participant session. Malformed, unknown,
expired, revoked, used, participant-less legacy, and wrong-event invitations all
return the same 404 response. Acceptance requires an OPEN event. It does not create
an RSVP, notification consent, or organizer credentials. No emails are sent.

`GET /api/v1/participant/events/:eventId` uses only the participant cookie to return
limited event details and that participant's ID/displayName. It never returns the
roster, organizer contact details, participant email, invitation metadata or tokens.
Participant sessions cannot authorize organizer endpoints or another event. Reads
are allowed only for OPEN/FINALIZED events. Cancelled/draft events deny access,
even if an old database row lacks a revocation timestamp.

## Token lifecycle and concurrency

Invitation and session tokens each use 32 cryptographically random bytes (256 bits),
encoded as 64 hex characters. Only SHA-256 digests are stored. Sessions have a
one-hour absolute expiry, capped by invitation expiry. Production uses a separate
`__Host-groupos_participant` cookie with Secure, HttpOnly, SameSite=Strict, Path=/,
and no Domain. HTTP development uses `groupos_participant`. Duplicate/forged cookies
are rejected. There are no refresh tokens; a new invitation is required after expiry.
One browser cookie represents one participant context; accepting a different link
replaces that browser context. It does not affect organizer sessions.

Replay is deliberately rejected, including a lost-response retry. The original
session remains usable if its cookie was received; otherwise ask the organizer to
reissue. Concurrent acceptance produces one successful exchange, one session and
one audit entry. A unique invitation/session relationship enforces that cardinality.

Issuance, revocation, acceptance and event cancellation all acquire the event row
lock before changing invitation state. Reads hold a shared event lock and check the
session, invitation and event in the same transaction. A request authorized before
revocation may finish before revocation commits; after revocation/cancellation
completes, subsequent reads fail. Future RSVP/poll handlers must perform their
operations inside `withParticipant`, retaining this transaction boundary (pass
`true` for writes to acquire the exclusive event lock). Never
trust participant/event IDs supplied in a request body.

Cancellation revokes invitations through GOS-004. Session validation always
rechecks revocation, invitation expiry and event state. Token rows/audit history
are retained; expired participant sessions are removed on acceptance and by the
existing recovery maintenance command. Retention scheduling remains a release
operations requirement. Logs must redact Cookie/Set-Cookie and acceptance bodies.

Persistent fixed-window limits apply before acceptance lookup: 30 attempts per
peer IP and 10 per token per 15 minutes. Issuance allows 100 per peer and 60 per
organizer per hour. Forwarded IP headers are not trusted. Behind a proxy these
limits conservatively group clients; reviewed proxy/edge configuration remains
required before production. Invalid tokens count too. 429 includes Retry-After.

## Migration, testing and release limits

The generated additive migration adds nullable `InvitationToken.acceptedAt` and
`ParticipantSession` with a unique invitation foreign key and expiry index. Existing
events, participants and invitations are retained; the migration creates no usable
sessions for legacy records. Generic invitations without a participant cannot be
exchanged. Existing composite event/participant constraints remain enforced.

Use the README Prisma/setup commands, then `npm run test:db -w @groupos/api`.
Integration tests use disposable PostgreSQL and synthetic participants only. They
cover hash-only storage, secure cookies, expiry, replay, revocation, ownership,
cross-event access, CSRF, persistent limits, cancellation, reissue and concurrent
requests. The migration runner also verifies legacy invitation preservation,
repeat deployment and schema drift. [RSVP/history](rsvps.md) is implemented in
GOS-006; polls remain GOS-007.

No new environment variables, dependencies, messaging provider or paid service is
needed. Existing Zod/PostCSS/Next.js advisories and production recovery/proxy/browser
verification release blockers remain unresolved; this is not production approval.
