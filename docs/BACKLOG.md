# GroupOS MVP backlog

Status: **planned** unless explicitly linked to implementation and passing checks. Prioritize vertical slices over infrastructure-only work.

| ID | Priority | Deliverable | Acceptance evidence | Status |
| --- | --- | --- | --- | --- |
| GOS-001 | P0 | CI baseline and reproducible install | API tests, API typecheck, web build pass on PR | Verified complete |
| GOS-002 | P0 | PostgreSQL + Prisma schema and migrations | [PR #3](https://github.com/olamide87/groupos/pull/3), [passing CI](https://github.com/olamide87/groupos/actions/runs/43559278098), [database design](database.md) | In review; checks passed |
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

Verified evidence: [PR #2](https://github.com/olamide87/groupos/pull/2), commit `9e9062810be81bfeff38c98609b7e45ca7b85760`, and [successful GitHub Actions run](https://github.com/olamide87/groupos/actions/runs/43554713588). The Node.js 22 CI job passed `npm ci --no-audit --no-fund`, `npx tsc --noEmit -p apps/api/tsconfig.json`, `npm run test -w @groupos/api`, and `npm run build -w @groupos/web`.

## Next implementation task
**GOS-002:** Review the verified PostgreSQL and Prisma foundation in PR #3. No merge or deployment is authorized by this implementation task.

GOS-001 was integrated by [PR #2](https://github.com/olamide87/groupos/pull/2), squash commit `3af7135c08ba5594cc7848848ed77d8246a7f1dd`. [Post-merge CI passed](https://github.com/olamide87/groupos/actions/runs/43556040217); Node.js 22 local clean install, typecheck, API test (1 passed) and web build also passed.

GOS-002 local verification (2026-11-13, Node.js 22.23.5): a single clean `npm ci --no-audit --no-fund` installed 165 packages and exited 0. Prisma validation and generation, API TypeScript checks, API tests (6 passed, 0 failed), database integration tests (9 passed, 0 failed), and the frontend production build all exited 0. The generated initial migration applied to a fresh disposable PostgreSQL 17.7 database; repeated deployment was a no-op and schema drift was empty. The test runner removed its database and the temporary server was stopped. [PR CI](https://github.com/olamide87/groupos/actions/runs/43559278098) passed all required checks on implementation commit `3090361e2ad5d0d4f62c677aee2b517c7f9957a4`, using a PostgreSQL 17 service container. The PR remains unmerged. See [setup](../README.md) and [database design](database.md).

GOS-013 release blockers: `npm audit` exits 1 with 3 affected packages (2 high: Zod and PostCSS; 1 moderate: Next.js via PostCSS; 0 critical). These existing findings are not resolved by GOS-002 and require dependency remediation before release. See [security evidence](database.md#dependency-security-evidence). Both the lockfile and clean installation resolve `deepmerge-ts` 8.0.0; the audit no longer reports the new Prisma tooling advisory, and Prisma/migration checks pass with the override.

## Agent operating constraints
- GroupOS is standalone; do not introduce AgentBook imports, authentication dependencies, or required services.
- Never push secrets, run destructive database migrations, contact real invitees, incur paid-service charges, merge to main, or deploy production without explicit approval.
- Keep each PR scoped to one backlog item where practical.
- Update this file with commit/PR/CI evidence rather than optimistic completion claims.
