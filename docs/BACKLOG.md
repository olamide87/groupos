# GroupOS MVP backlog

Status: **planned** unless explicitly linked to implementation and passing checks. Prioritize vertical slices over infrastructure-only work.

| ID | Priority | Deliverable | Acceptance evidence | Status |
| --- | --- | --- | --- | --- |
| GOS-001 | P0 | CI baseline and reproducible install | API tests, API typecheck, web build pass on PR | In progress |
| GOS-002 | P0 | PostgreSQL + Prisma schema and migrations | Migrations and database integration tests | Planned |
| GOS-003 | P0 | Organizer account authentication | Signup/login/logout/recovery, auth and rate-limit tests | Planned |
| GOS-004 | P0 | Event CRUD with organizer authorization | Event API integration tests incl. cross-account denial | Planned |
| GOS-005 | P0 | Secure participant invitations | Expiring/revocable tokens and token security tests | Planned |
| GOS-006 | P0 | Participant RSVP and response history | API and UI tests, duplicate response behavior | Planned |
| GOS-007 | P0 | Date/budget/activity polls | Poll creation, voting, closing and authorization tests | Planned |
| GOS-008 | P0 | Organizer dashboard | End-to-end pending/confirmed participation view | Planned |
| GOS-009 | P1 | Coordination Intelligence rules | Deterministic rule fixtures and explainability tests | Planned |
| GOS-010 | P1 | AI suggestion generation with organizer approval | No-send-without-approval tests | Planned |
| GOS-011 | P1 | Opt-in email reminders | Consent/opt-out and delivery integration tests | Planned |
| GOS-012 | P1 | Shareable finalized itinerary | Participant-scoped access and E2E tests | Planned |
| GOS-013 | P0 | Security and operational readiness | Security review, docs, staging smoke tests | Planned |
| GOS-014 | P0 | Release acceptance | All DoD evidence linked, owner sign-off | Planned |

## Next implementation task
**GOS-001:** Establish reproducible dependency installation and make CI green. Then begin GOS-002.

## Agent operating constraints
- GroupOS is standalone; do not introduce AgentBook imports, authentication dependencies, or required services.
- Never push secrets, run destructive database migrations, contact real invitees, incur paid-service charges, merge to main, or deploy production without explicit approval.
- Keep each PR scoped to one backlog item where practical.
- Update this file with commit/PR/CI evidence rather than optimistic completion claims.
