# Organizer dashboard (GOS-008)

Open `/account` to register or sign in. Successful login opens `/dashboard`; an
existing session can also open it directly. The dashboard uses the existing
same-origin API proxy and HTTP-only organizer session. Sign out revokes the
session through the authentication API. Recovery remains available on `/account`.

## Organizer workflow

- Browse events in pages of 20, create a draft/open event, and open its overview.
  Edit title, description, location, UTC schedule and display time zone. Cancellation
  asks for confirmation and uses the existing event endpoint; it retains responses
  and revokes invitations. Finalized/cancelled events show read-only controls.
- Open an event before adding a named participant and generating an invitation.
  Copy the returned link manually; the dashboard does not send messages. Reissue
  explicitly confirms that prior links/sessions will stop working. Revoke confirms
  access removal. Participants are managed through these existing invitation APIs;
  this feature adds no participant deletion or renaming API.
- View RSVP participation, YES/NO/MAYBE counts and outstanding responses. Rates
  use server-returned total/pending counts, including participants with revoked
  invitations. Participant lists and ordered response history are paginated.
- Create date/time, budget or activity polls; edit question/options before voting
  begins, or a future deadline afterward. Close/cancel with confirmation. The
  server enforces lifecycle, ownership and version checks; conflicts instruct the
  organizer to discard stale edits and refresh. Results show option counts and
  responded/pending totals from the existing aggregate endpoint. Availability
  polls can have multiple or zero selections per respondent.

All date/time input fields explicitly use UTC; readouts label local times. Budget
forms convert decimal display amounts to the API's integer minor units. Validation,
authorization, token creation/revocation and poll/RSVP concurrency remain exclusively
in the API. No new database schema or business-rule endpoints are introduced.
Poll option times and deadlines retain seconds and milliseconds through editing;
unrelated edits do not round stored UTC timestamps to the minute.

## Privacy and UI states

Credentials are submitted only by the existing account form. No auth tokens or
invitation links are stored in localStorage/sessionStorage. A newly issued link is
shown only in its owner-authorized response view, without an anchor or prefetch;
copying requires an explicit click. It is cleared after two minutes, when the
document is hidden, when leaving participants/event views, or after observed
revocation/cancellation/session expiry. Clipboard contents remain under the user's
control after copying. Historical invitation secrets cannot be retrieved.
Successful metadata refreshes also clear a link if its invitation is revoked,
accepted, expired or absent from the returned metadata. Failed metadata refreshes
clear the displayed secret and disable invitation mutations until recovery.

The invitation API exposes only its latest 100 metadata entries; the dashboard
warns when that limit is reached rather than inventing an older participant's
invitation status. RSVP/poll counts are event-wide, independent of displayed pages.
They describe the latest fetched state; use Refresh after participant activity.
No automatic retries occur for mutations, especially invitation creation/reissue.
After an ambiguous network failure, refresh before retrying to avoid creating an
additional participant. The API does not provide invitation-issuance idempotency.
Issuance failures retain the participant name and validity fields. Reissue failures
reject the confirmation action and keep its error visible; they are never treated
as successful confirmations.

Any API 401 clears the dashboard's private component state and offers sign-in.
Refreshes disable dependent event actions until the event and summary are both
available; failures remove stale event details, counts and child views. Participant,
invitation and poll list failures clear their previous results/actions. Poll actions
require successfully loaded results. Empty states are not used to disguise failed
reads. Superseded event requests cannot restore an older response after a newer one.
Loading, empty, not-owned/not-found, network and stale-edit errors are visible.
Labels, native controls, live status messages, keyboard focus styles, confirmation
groups and a skip link support accessible use. Responsive cards replace wide tables.
Dashboard/account pages receive the same no-referrer and framing protections as
the participant page; sensitive API responses remain no-store.

## Automated real-browser verification

The pinned `@playwright/test` dependency is development-only. Build first, then:

```sh
npx playwright install chromium
npm run test:e2e -w @groupos/web
```

Set `TEST_DATABASE_URL` to the loopback `/groupos_test` control database from the
README. The runner creates and migrates a random `groupos_test_<uuid>` database,
starts its own loopback-only API on 127.0.0.1:4100 and production frontend on
127.0.0.1:3000, and cleans up its
database and owned processes in `finally`. Keep these ports free; it never adopts
or stops an unrelated server. Build with the default local API rewrite target.
No recovery worker or messaging service runs. Never point this runner at production.
The runner attaches its process-exit waiter before signaling shutdown and handles
already-exited or failed-to-spawn children without waiting for a lost exit event.

For installed local Google Chrome, set `GROUPOS_TEST_CHROME=1` instead of downloading
Chromium. CI installs Chromium and its Linux dependencies after the production
build and runs the same tests. Tests create synthetic `example.test` organizers and
participants, exercise desktop/mobile workflows, cross-account denial, session
expiry, stale edits and network failures against the real API/database. Traces,
videos and automatic screenshots are disabled to avoid capturing invitation links;
secret-free desktop/mobile result screenshots are written only under ignored `.local/`.

On 2026-11-19, all seven isolated Chromium E2E scenarios passed, along with 11 API
unit tests, 77 integration tests, Prisma/migrations, TypeScript and the production
build. Desktop/mobile screenshots were inspected. Regressions cover stale refresh
actions, failed issuance/reissue, revoked metadata, and UTC timestamp precision.
The computer-use browser host was unavailable during initial setup; Playwright
provided the real-browser verification. Firefox/WebKit, physical mobile devices
and assistive technologies were not tested.

The GOS-008 audit snapshot was nonzero: six affected packages (five high, one moderate),
including the newly reported Effect advisory through Prisma tooling as well as
Zod/PostCSS/Next.js. Production recovery/proxy/edge/retention work and the
deepmerge-ts range diagnostic were recorded as blockers. Current dependency
status is tracked in [the GOS-013 review](dependency-security.md).
Browser automation does not replace release security remediation or verification
of a real production deployment. GOS-008 was integrated in PR #9; production
readiness remains separately gated.
