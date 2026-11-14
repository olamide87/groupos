# GroupOS standalone architecture

GroupOS is independent of AgentBook. No AgentBook services, accounts, or credentials are required.

## MVP domains

- **Identity:** organizer accounts and invite-link participant access (to implement)
- **Events:** organizer-owned outings, locations, schedules, and status (to implement)
- **Participation:** invitations, RSVP, and response history (to implement)
- **Decisions:** date, budget, and activity polls (to implement)
- **Coordination Intelligence:** deterministic detection of nonresponses, conflicts, and stalled decisions; AI recommendations require organizer approval before outreach (to implement)
- **Notifications:** email opt-in first; SMS later (to implement)

## Initial code structure

- `apps/api`: Express and TypeScript REST API; health endpoint implemented
- `apps/web`: Next.js and React frontend; landing page implemented
- PostgreSQL/Prisma, authentication, background jobs, and AI integration are planned but **not yet implemented**.

## Security principles

Invitation tokens must be unguessable, expiring, and revocable. Organizer authorization must be enforced server-side. Do not expose participant contact information to other participants. Require consent for outbound messaging. Keep AI-generated suggestions separate from automated sending.
