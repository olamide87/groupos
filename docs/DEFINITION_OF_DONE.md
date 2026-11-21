# GroupOS MVP — Definition of Done

## Scope
Standalone GroupOS application for organizing outings with approximately 8–12 participants. No AgentBook dependency.

## Acceptance criteria

- [ ] Organizer can register, authenticate, sign out, and recover account access securely.
- [ ] Organizer can create, edit, cancel, and view an outing; ownership checks prevent unauthorized access.
- [ ] Organizer can generate secure, expiring, revocable participant invitation links.
- [ ] Invited participants can view appropriate event details and RSVP yes/no/maybe without registering.
- [ ] Organizer can view accurate participant counts and response history.
- [ ] Participants can vote on proposed dates, budgets, and activities; organizer can close polls.
- [ ] Organizer dashboard clearly identifies pending responses and unresolved decisions.
- [ ] Deterministic coordination rules flag nonresponses, conflicting preferences, and stalled decisions with explainable reasons.
- [ ] AI-generated recommendations are clearly labeled, reviewed by organizer, and never auto-sent without explicit authorization.
- [ ] Opt-in email reminders work; recipients can opt out. No unsolicited SMS.
- [ ] Organizer can finalize and share an itinerary, with participant access scoped to the event.
- [ ] Persistence uses a migration-managed database, with constraints and authorization tested.
- [ ] Automated unit, integration, and end-to-end tests cover the critical organizer-to-participant flow and pass in CI.
- [ ] Security review addresses token entropy, expiry/revocation, input validation, rate limiting, authorization, secret handling, and sensitive data exposure; no unresolved critical/high vulnerabilities.
- [ ] README documents local setup, required environment variables, migrations, test commands, and deployment.
- [ ] Staging deployment and smoke test pass; owner approves production release.

## Completion policy
A checkbox may be marked complete only with linked evidence (commit, passing CI run, test, or verified deployment). Code present is not the same as tested or released. A feature is done only when its tests and security requirements pass. All MVP criteria and release gates must pass before declaring the MVP complete.

## Engineering workflow
1. Select highest-priority unblocked backlog item.
2. Implement a small change on a feature branch.
3. Add/update tests and documentation.
4. Run typecheck, API tests, frontend build, and security checks.
5. Open a PR describing acceptance criteria and evidence.
6. Fix CI failures; require human review before merging and deployment.
7. Update backlog and repeat until all acceptance criteria pass.
