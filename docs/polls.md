# Participant polls (GOS-007)

Organizers manage polls through the authenticated API. Invited participants vote
from `/invite` using their existing HTTP-only participant session; no account or
new token is required. No messages or external services are used.

## Choices and lifecycle

- `DATE`: 2–20 labeled future UTC time windows (`startsAt`, `endsAt`). Participants
  select every available window, or submit an empty selection for none available.
- `BUDGET`: 2–20 labeled amounts in integer minor units (`amountMinor`, maximum
  100000000) with one currency per poll. Supported currencies are USD, GBP, EUR,
  CAD, AUD and NGN (all use two decimal places). Select exactly one preference.
- `ACTIVITY`: 2–20 labeled activities. Select exactly one preference.

Labels are distinct, at most 200 characters; questions are at most 300. Every
poll has an optional future `closesAt` UTC timestamp. There are at most 50 polls
per event. Deadlines are enforced during voting, even if the stored status remains
OPEN. Closed or cancelled polls cannot reopen. Cancellation retains votes/audit.
An owner can cancel an already-closed poll. Draft events allow poll preparation;
participants can vote only while their event is OPEN. Finalized events are read-only.

An owner may edit a deadline on a still-open poll. Questions/options can change
only before any response, including a none-available response. Kind is immutable.
Every edit increments the poll version; participants must review a changed poll
before voting. Changing existing voted option meanings is prohibited. Create a
new poll instead. Date windows display in the participant's local time with that
label; budget values use the poll currency.

## Organizer API

All paths start `/api/v1/events/:eventId/polls`. Only the event owner has access;
missing and non-owned resources return 404. Organizer authentication is required.
Writes require exact Origin, JSON and `X-GroupOS-Request: 1`.

| Method/path | Body or result |
| --- | --- |
| POST `/` | `{question, kind, options, closesAt?}`; creates OPEN poll, version 0 |
| GET `/` | `polls`, limit 20 and offset; optional `?offset=20` |
| PATCH `/:pollId` | `{expectedVersion, question?, options?, closesAt?}` |
| POST `/:pollId/close` | `{expectedVersion}` |
| POST `/:pollId/cancel` | `{expectedVersion}` |
| GET `/:pollId/results` | Poll/options, per-option counts, total participants, responded and pending |

An option is `{label}` for activities, `{label, startsAt, endsAt}` for dates or
`{label, amountMinor, currency}` for budgets. ISO dates must be canonical UTC;
invalid calendar dates are rejected. `closesAt: null` removes a future deadline
while the poll is still open. An expired poll cannot be extended or reopened.
Repeating close/cancel for its current status is a no-op without another audit.
All other stale owner edits return 409. Unknown body/query fields are rejected.

Aggregate responses contain no participant identities/contact details or tokens.
Responded counts distinct participants, including none-available date ballots;
date option totals can exceed the respondent count. Revoking an invitation does
not erase that participant or their vote. Results remain available to the owner
after event cancellation. List pagination is bounded to 20 rows/offset 10000.

## Participant API and retries

`GET /api/v1/participant/events/:eventId/polls?offset=0` returns a page of polls,
options, `canVote` and only the caller's ballot (`version`, `optionIds`). A missing
ballot has version 0. Other people's votes and aggregates are not exposed.

`POST /api/v1/participant/events/:eventId/polls/:pollId/vote` accepts:

```json
{
  "optionIds": ["6e660bc0-d9f1-40b3-9d2a-ad2574ee49aa"],
  "expectedVersion": 0,
  "expectedPollVersion": 0,
  "requestId": "35a0d8c0-d76c-4ec1-ae93-774f791fc013"
}
```

Participant identity comes exclusively from the session. Same Origin/JSON/custom
header protections apply. Invalid or repeated options return 400. Each selected
option must belong to this poll and event. Expired/revoked sessions or invitations,
cross-event access and cancelled/draft events return generic 404. Closed/expired
polls and finalized events return 409. Authorization is rechecked on retries.

Selections are canonicalized (UUID case/order) before hashing the request payload.
Keep the same request ID and full payload for network retries. An identical retry
returns the latest ballot without reapplying old intent. ID reuse with a different
payload and new submissions with stale ballot/poll versions return 409. A fresh
request for unchanged choices records the retry ID but does not change the ballot
version, selection timestamps or audit. An initial empty date ballot is a response,
not a no-op. Changing a response atomically replaces its selected options and
increments its ballot version. The UI retains pending retry payloads in memory and
refreshes after 409 instead of automatically resubmitting a stale choice.

## Persistence, concurrency and migration

All reads hold a shared event row lock. All mutations hold an exclusive event lock
before validating invitation/session state and keep it through commit. Owner
editing, closing/cancelling, invitation revocation/reissue and event cancellation
use the same lock order. A vote may commit before a racing stop/revocation; once
that operation commits, later votes are denied. Competing edits from one version
have one winner; identical simultaneous retries commit once. Selection replacement,
ballot version, retry ledger and audit are one transaction and roll back together.

`Vote` now has unique `(pollId, participantId, optionId)` selections, retaining its
composite event/poll/option foreign keys. `PollBallot` tracks each participant's
version, including zero selections. `PollSubmission` stores a hash of the canonical
request payload under `(pollId, participantId, requestId)`. Both tables have
event-scoped composite foreign keys. Poll audit entries identify the poll and the
participant actor through an event-scoped foreign key; organizer lifecycle entries
identify their organizer actor. No raw session/invitation tokens are stored here.

The Prisma-generated migration preserves existing votes/options, adds typed option
columns, poll versions and the CANCELLED enum, and replaces the old single-vote
index. Legacy selections are read as version 0 until changed; no artificial ballot
or history is fabricated. Legacy labeled options may have null typed fields. The
runner seeds a legacy vote and verifies its preservation, repeat deployment and
empty schema drift in a disposable database. Apply migrations before starting the
updated API; older API/client code using the removed unique key is incompatible.
Do not run a destructive rollback. API cardinality/type/deadline rules supplement
the database's relationship/uniqueness constraints; direct database writes must
not bypass the API's locks and validation.

## Verification and release boundaries

Run the complete README verification suite. `test:db` includes poll integration
tests automatically in CI with PostgreSQL 17. Tests exercise all poll kinds,
authorization, CSRF, malformed/cross-poll options, stale versions, concurrent
retries/edits, expiry/revocation, stop races, none-available responses, aggregate
privacy, legacy migration preservation, relational constraints and forced audit
failure rollback. Only generated disposable test databases are migrated/dropped.

No dependencies, environment variables or messaging provider were added. Vote
selections represent current state; this feature does not promise full preference
history. Audit and retry ledgers are retained. Approved retention/deletion policy,
abuse/edge limits, production recovery/proxy operations, real-browser verification
and unresolved Zod/PostCSS/Next.js advisories remain release blockers. Do not prune
retry IDs without defining a supported retry window. GOS-008 owns the organizer
dashboard; organizer poll controls are API endpoints in this slice.
