# GroupOS standalone architecture

GroupOS is independent of AgentBook. No AgentBook services, accounts, or credentials are required.

## MVP domains

- **Identity:** organizer password authentication, revocable sessions and recovery outbox; single-use invitation exchange and event-scoped participant sessions
- **Events:** organizer-owned event creation, listing, viewing, editing and cancellation API; see [event contracts](events.md)
- **Participation:** [secure invitations](invitations.md), participant event views, [versioned RSVP/history and organizer summaries](rsvps.md)
- **Decisions:** [date/time availability, budget and activity polls](polls.md), organizer lifecycle/results APIs and participant voting UI
- **Coordination Intelligence:** deterministic detection of nonresponses, conflicts, and stalled decisions; AI recommendations require organizer approval before outreach (to implement)
- **Notifications:** email opt-in first; SMS later (to implement)

## Initial code structure

- `apps/api`: Express and TypeScript REST API; health endpoint implemented
- `apps/web`: Next.js and React frontend; landing, organizer account and invitation acceptance pages
- PostgreSQL/Prisma schema, versioned migrations and a managed API client provide the persistence foundation; see [database design](database.md).
- Organizer authentication and an explicit recovery delivery command are implemented; see [authentication](authentication.md). Event CRUD is available through the [organizer API](events.md). [Invitation exchange and participant event reads](invitations.md), RSVP writes/history, organizer response summaries and participant polls are implemented. The [organizer dashboard](dashboard.md) consumes these APIs through the same-origin proxy. General background jobs and AI integration remain planned.

## Security principles

Invitation tokens must be unguessable, expiring, and revocable. Organizer authorization must be enforced server-side. Do not expose participant contact information to other participants. Require consent for outbound messaging. Keep AI-generated suggestions separate from automated sending.

The organizer dashboard is a presentation layer over these APIs. Failed refreshes
remove stale actionable data; authentication expiry clears private views. Invitation
secrets remain transient and are invalidated against refreshed metadata. Browser
tests use loopback-only services, synthetic accounts and disposable PostgreSQL.
