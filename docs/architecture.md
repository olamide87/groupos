# GroupOS standalone architecture

GroupOS is independent of AgentBook. No AgentBook services, accounts, or credentials are required.

## MVP domains

- **Identity:** organizer password authentication, revocable sessions and recovery outbox; invite-link participant access remains to implement
- **Events:** organizer-owned event creation, listing, viewing, editing and cancellation API; see [event contracts](events.md)
- **Participation:** invitations, RSVP, and response history (to implement)
- **Decisions:** date, budget, and activity polls (to implement)
- **Coordination Intelligence:** deterministic detection of nonresponses, conflicts, and stalled decisions; AI recommendations require organizer approval before outreach (to implement)
- **Notifications:** email opt-in first; SMS later (to implement)

## Initial code structure

- `apps/api`: Express and TypeScript REST API; health endpoint implemented
- `apps/web`: Next.js and React frontend; landing and organizer account pages
- PostgreSQL/Prisma schema, versioned migrations and a managed API client provide the persistence foundation; see [database design](database.md).
- Organizer authentication and an explicit recovery delivery command are implemented; see [authentication](authentication.md). Event CRUD is available through the [organizer API](events.md). Participant endpoints, organizer dashboard, general background jobs and AI integration remain planned.

## Security principles

Invitation tokens must be unguessable, expiring, and revocable. Organizer authorization must be enforced server-side. Do not expose participant contact information to other participants. Require consent for outbound messaging. Keep AI-generated suggestions separate from automated sending.
