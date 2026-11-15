# GroupOS MVP backlog

Status: **planned** unless explicitly linked to implementation and passing checks. Prioritize vertical slices over infrastructure-only work.

| ID | Priority | Deliverable | Acceptance evidence | Status |
| --- | --- | --- | --- | --- |
| GOS-001 | P0 | CI baseline and reproducible install | API tests, API typecheck, web build pass on PR | Verified complete |
| GOS-002 | P0 | PostgreSQL + Prisma schema and migrations | [PR #3](https://github.com/olamide87/groupos/pull/3), [post-merge CI](https://github.com/olamide87/groupos/actions/runs/43561329745), [database design](database.md) | Integrated and verified |
| GOS-003 | P0 | Organizer account authentication | [PR #4](https://github.com/olamide87/groupos/pull/4), [passing CI](https://github.com/olamide87/groupos/actions/runs/43753618250), [authentication](authentication.md) | Integrated and verified; release blockers open |
| GOS-004 | P0 | Event CRUD with organizer authorization | [PR #5](https://github.com/olamide87/groupos/pull/5), [passing CI](https://github.com/olamide87/groupos/actions/runs/43755102110), [event API](events.md) | In review; merge approval required |
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
**GOS-004:** Review PR #5 and obtain explicit approval before merge. Resolve the documented security release blockers before release.

GOS-003 integration (2026-11-15): approved squash merge `0728fe0f08e071e0a18c36fe98bbce583ac83cdf`. The synchronized development branch passed clean `npm ci`, Prisma validation/generation, fresh/upgrade/repeat migration and drift checks, API typecheck, 11 API tests, 27 database/authentication integration tests, and frontend production build (all exit 0). Dependency and production-readiness release blockers remain unresolved. Historical pre-integration review notes below record the earlier state.

GOS-002 integration: approved squash merge `07177ca6e9b74ccfa3028e03acba0b71bd280969`. The synchronized development branch passed Prisma validation/generation, fresh migration and repeat-deploy/drift checks, API typecheck, 6 API tests, 9 database tests and the frontend production build, all exit 0. Post-merge CI passed. The security release blockers below remain open.

GOS-001 was integrated by [PR #2](https://github.com/olamide87/groupos/pull/2), squash commit `3af7135c08ba5594cc7848848ed77d8246a7f1dd`. [Post-merge CI passed](https://github.com/olamide87/groupos/actions/runs/43556040217); Node.js 22 local clean install, typecheck, API test (1 passed) and web build also passed.

GOS-002 local verification (2026-11-13, Node.js 22.23.5): a single clean `npm ci --no-audit --no-fund` installed 165 packages and exited 0. Prisma validation and generation, API TypeScript checks, API tests (6 passed, 0 failed), database integration tests (9 passed, 0 failed), and the frontend production build all exited 0. The generated initial migration applied to a fresh disposable PostgreSQL 17.7 database; repeated deployment was a no-op and schema drift was empty. The test runner removed its database and the temporary server was stopped. [PR CI](https://github.com/olamide87/groupos/actions/runs/43559278098) passed all required checks on implementation commit `3090361e2ad5d0d4f62c677aee2b517c7f9957a4`, using a PostgreSQL 17 service container. PR #3 was subsequently integrated in squash commit `07177ca6e9b74ccfa3028e03acba0b71bd280969`. See [setup](../README.md) and [database design](database.md).

GOS-003 local verification (2026-11-14, Node.js 22.23.5): dependency installation, Prisma validation/generation, API TypeScript checks, API tests (10 passed), database/authentication integration tests (24 passed), and frontend production build exited 0. Migration verification applied the baseline to a fresh disposable PostgreSQL 17.7 database, preserved a populated legacy organizer/event during the authentication upgrade, redeployed without pending migrations, and found no schema drift. The runner removed its disposable database. A separate HTTP smoke test through the production frontend proxy passed signup, login, identity lookup, local-only recovery, reset, old-session revocation and logout. All disposable test databases were confirmed removed and the temporary PostgreSQL server was stopped. Browser rendering could not be verified because the browser automation host was unavailable. [PR #4 CI](https://github.com/olamide87/groupos/actions/runs/43674381892) passed clean `npm ci`, Prisma validation/generation, typecheck, API tests, database integration tests and the web build for implementation commit `43bedb1338dc4d2128118105446e7a27dd76bd56`. See [authentication contracts, setup and operational boundaries](authentication.md). Human review and the security release blockers remain open; this item is not marked complete.

GOS-013 release blockers: `npm audit` exits 1 with 3 affected packages (2 high: Zod and PostCSS; 1 moderate: Next.js via PostCSS; 0 critical). Rechecked on 2026-11-14 for GOS-003: the same three findings remain, with no additional affected packages and no new dependencies introduced. These findings require dependency remediation before release. See [security evidence](database.md#dependency-security-evidence). Both the lockfile and installation resolve `deepmerge-ts` 8.0.0; the audit no longer reports the Prisma tooling advisory, and Prisma/migration checks pass with the override. Production recovery delivery/scheduling and trusted-proxy/edge-limit configuration also require separate owner setup and verification before release; no real emails or production infrastructure were used.

GOS-003 security review (2026-11-15): corrected recovery delivery of tokens that expired or were revoked after batch selection; added adversarial coverage for fixation, absolute expiry/auth-version revocation, normalized account limits and proxy-header spoofing, all auth POST CSRF checks, reset replay, and mocked delivery configuration. Local Node.js 22 verification passed installation, Prisma validation/generation, API typecheck, 11 API tests, 27 database/authentication tests, migration upgrade/redeploy/drift checks and frontend build (all exit 0). Disposable databases were removed and the test server stopped. Audit still exits 1 with the same Zod/PostCSS/Next.js findings (2 high, 1 moderate, 0 critical). See the [security review and remaining release concerns](authentication.md#security-review-2026-11-15); final-commit CI evidence is recorded on [PR #4](https://github.com/olamide87/groupos/pull/4). Merge approval remains required; GOS-004 starts only after integration.

GOS-004 local verification (2026-11-15, Node.js 22.23.5): installation, Prisma validation/generation, API TypeScript checks, 11 API tests, 35 database/authentication/event tests (including 8 new event tests), fresh/upgrade/repeat migration and empty-drift checks, and frontend production build all exited 0. The [event API](events.md) supports creation, owner-scoped listing/viewing/updating and idempotent cancellation, with shared CSRF protection, transactional audit records, invitation revocation and concurrency tests. No schema or dependency changes were introduced. Final PR CI and human review remain required; GOS-004 is not marked complete. The unresolved Zod/PostCSS/Next.js advisories, production recovery/proxy configuration and browser UI verification concerns remain unchanged.

GOS-004 PR verification: [CI run](https://github.com/olamide87/groupos/actions/runs/43755102110) passed every required step on implementation commit `98daff781505b554cec5d4cb7887065fdf129459`, including clean `npm ci`, Prisma, API typecheck/tests, all database/authentication/event integration tests and frontend production build. Local disposable database cleanup was confirmed and the temporary server stopped. Human review and merge approval remain pending; security release blockers are unchanged.

## Agent operating constraints

- GroupOS is standalone; do not introduce AgentBook imports, authentication dependencies, or required services.
- Never push secrets, run destructive database migrations, contact real invitees, incur paid-service charges, merge to main, or deploy production without explicit approval.
- Keep each PR scoped to one backlog item where practical.
- Update this file with commit/PR/CI evidence rather than optimistic completion claims.
