# Organizer event API (GOS-004)

All routes under `/api/v1/events` require a live organizer session. Ownership is
always derived from that session, never a body, query string or header. Every
lookup and mutation is scoped to the organizer. Missing and non-owned event IDs
both return 404. Responses use `Cache-Control: no-store` and return event fields
only, without organizer credentials, participant data or nested relations.

| Method and path | Behavior |
| --- | --- |
| `POST /api/v1/events` | Create an event; 201 with event and Location header |
| `GET /api/v1/events` | List only the organizer's events; optional status, limit and offset |
| `GET /api/v1/events/:id` | View one owned event, including cancelled events |
| `PATCH /api/v1/events/:id` | Update supplied editable fields; omitted fields are unchanged |
| `POST /api/v1/events/:id/cancel` | Empty JSON object; idempotently cancel and revoke outstanding invitations |

Mutations require JSON, the exact configured Origin and `X-GroupOS-Request: 1`,
using the same CSRF middleware as authentication. PATCH is allowed by CORS only
for the configured origin. Authentication errors return 401; CSRF errors 403;
invalid input 400; edits of cancelled/finalized events 409.

Editable fields are `title` (required on creation, 1–200 characters after trimming),
`description` (nullable, up to 4000 characters), `location` (nullable, up to 300),
`startsAt`, `endsAt`, `timeZone` (valid runtime-supported time zone, at most 80
characters), and `status` (`DRAFT` or `OPEN`). Unknown fields and nested writes are
rejected. Creation defaults to DRAFT, UTC and null optional fields. Date strings
must be UTC ISO-8601, e.g. `2027-02-01T18:00:00Z` or
`2027-02-01T18:00:00.000Z`; invalid calendar dates are rejected. An end requires a
start and must be later. Partial updates validate the resulting full date range.
Dates may be cleared with null, and past events may be recorded. No timezone or
local-date inference is performed by the API.

List pagination defaults to limit 20 and offset 0, with maximums of 100 and 10000.
Results are ordered by creation time descending, then ID descending for stable
ties. Status can be DRAFT, OPEN, FINALIZED or CANCELLED. Unknown/repeated filters
are rejected. Offset pagination is not a snapshot: concurrent creation can shift
page boundaries. A dashboard and its pagination UX remain GOS-008.

Cancellation preserves the event, participants, responses, polls and audit trail;
there is no hard-delete API. Cancellation is terminal in this slice. Finalized
events cannot be edited but may be cancelled; the finalization workflow remains
GOS-012. No messages are sent. Outstanding invitation tokens are revoked in the
same transaction. Future invitation/participant endpoints must also reject
cancelled events and enforce invitation revocation.

Updates and cancellation lock the owned event row before reading/validating its
state, preventing a racing edit from reopening cancellation. Successful writes
append an audit entry in the same transaction. Concurrent patches serialize;
the last patch wins for overlapping fields (there is no optimistic version/ETag
contract yet). Repeated cancellation returns the existing state without duplicate
audit entries. No schema migration or dependency addition is needed.

## Verification

Run the existing README installation, Prisma, typecheck, API test and web build
commands. `npm run test:db -w @groupos/api` also runs eight event integration tests
against a uniquely named disposable database. Coverage includes lifecycle/audit,
anonymous/expired/revoked sessions, cross-account read/update/cancel/list denial,
mass assignment and nested-write rejection, validation and partial date ranges,
CSRF, pagination/filter bounds, cancellation retention/invitation revocation, and
concurrent cancellation/patch behavior. Existing authentication and migration
tests remain in that same CI command. No real emails or production DBs are used.

This deliverable is the event API; an organizer event-management screen is not
included. The dependency advisories and production-readiness gates documented in
[authentication](authentication.md) and the backlog remain unresolved.
