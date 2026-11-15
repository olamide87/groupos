# Organizer authentication (GOS-003)

The account page at `/account` provides signup, login, logout and password
recovery. The API uses opaque server-side sessions and a PostgreSQL-backed
limiter; it does not depend on AgentBook, JWTs, an external identity provider,
or a live email provider for local development/tests.

## API contract

All POSTs require JSON, `X-GroupOS-Request: 1`, and an `Origin` exactly matching
`AUTH_ORIGIN`. The browser sends Origin automatically. CORS allows only that
origin, with credentials. Responses are not cacheable. Bodies are limited to 8 KiB.

| Route | Input / result |
| --- | --- |
| `POST /api/v1/auth/signup` | `name`, `email`, `password`; generic 202 for new or existing email; no automatic login |
| `POST /api/v1/auth/login` | `email`, `password`; public user fields and an HttpOnly session cookie; generic 401 for bad credentials |
| `POST /api/v1/auth/logout` | `{}`; revokes this session and clears its cookie; idempotent 204 |
| `GET /api/v1/auth/me` | Authenticated public user fields only; otherwise 401 |
| `POST /api/v1/auth/forgot` | `email`; generic 202 with no token or delivery status |
| `POST /api/v1/auth/reset` | `token`, `password`; consumes link once, changes password, revokes all sessions and other links; does not log in automatically |
| `GET /api/v1/events/:eventId` | Read-only event details scoped by authenticated organizer ID; non-owned and missing events both return 404 |

GOS-004 extends the event read into the [organizer event API](events.md), sharing
the same authentication and CSRF safeguards. Caller-supplied organizer IDs are
never trusted. Participant invitation access remains GOS-005. Email ownership verification at signup,
MFA and breached-password screening are not implemented and must be considered
in release readiness. Signup does not label an email address as verified.

## Passwords and sessions

Passwords use Node's scrypt with N=131072, r=8, p=1, a random 16-byte salt and
64-byte derived key. This follows the [OWASP scrypt baseline](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
Only the encoded hash is stored. Passwords are 15–128 characters and at most
512 UTF-8 bytes; they are never trimmed, normalized or truncated. Unknown users
perform the same password derivation as known users. At most two derivations run
per API process, bounding memory use; excess work returns 503 with Retry-After.

Session tokens contain 32 random bytes. Only SHA-256 digests are stored. Sessions
expire after one hour (absolute, not sliding); login rotates the browser's prior
session. Production cookies use `__Host-groupos_session`, Secure, HttpOnly,
SameSite=Strict and Path=/ with no Domain. Development HTTP uses `groupos_session`.
Strict Origin/custom-header checks provide CSRF defense beyond SameSite.
There is no refresh token; the organizer signs in again after expiration.
Protected routes share `requireOrganizer` middleware, which derives identity from
the stored session and exposes only public user fields to subsequent handlers.

Password reset and login lock the same user row. Login rechecks the verified
password hash/version inside its session-creation transaction. Reset consumes
its token, changes the hash, increments the authentication version and revokes
all sessions in one transaction. A login racing with reset cannot leave a valid
old-password session. Sensitive auth events append audit entries without secrets.

The additive migration preserves existing users/events. Pre-auth users retain
`passwordHash = NULL` and cannot log in, reset a password or have their identity
claimed by duplicate signup. If real legacy organizers exist, provide an explicitly
approved identity-verification/enrollment process before granting credentials.

## Recovery delivery

Reset tokens contain 32 random bytes, expire after 30 minutes, and are single-use.
A newer request invalidates previous links. Reset responses never return bearer
tokens. Links use a URL fragment; the account page removes it from browser history
and keeps the token only in component memory. Recovery requests have a minimum
500 ms response duration and never await provider delivery. Generic responses,
rate limits and timing padding reduce enumeration; they are not a guarantee of
identical timing under arbitrary database load.

The password-reset table holds only token hashes. The email payload containing
the raw link is encrypted separately with AES-256-GCM in an outbox. Set a stable,
random 32-byte hex `AUTH_RECOVERY_KEY`, keep it outside version control, and share
it only with API/delivery workers. Losing/rotating it invalidates pending delivery;
let old links expire or explicitly clear pending auth records during a planned
rotation. No production key or provider credentials are included here.

Run `npm run auth:deliver-recovery -w @groupos/api` to process up to 20 messages.
It claims messages with 60-second leases, tries at most five times, and clears
encrypted payloads after successful delivery. Failed attempts retain encrypted
work for retry; provider errors and raw links are never logged. Expired sessions
and expired/consumed reset records (including their outbox payloads) are removed
by this worker. Other personal-data/audit retention policies remain GOS-013.
Each message's claim rechecks token expiry and revocation, including changes while
an earlier message in the batch was delivered. Revocation after a claim can still
race with external delivery; the reset endpoint always revalidates the token, so
delivery never grants validity to an expired or revoked link.

In development without a webhook, messages go to the ignored private
`.local/recovery-mailbox/` directory. POSIX permissions are owner-only; on Windows,
restrict inherited ACLs to the developer account. Delete expired local mailbox
files after testing. This directory must never be exposed by a web server.

Production requires `NODE_ENV=production`, an HTTPS `AUTH_ORIGIN`,
`AUTH_RECOVERY_WEBHOOK_URL` and an `AUTH_RECOVERY_WEBHOOK_SECRET` of at least
32 characters. Startup rejects missing/unsafe configuration without contacting
the provider. The owner-provisioned adapter must accept an HTTPS POST:

```json
{ "email": "organizer@example.test", "resetUrl": "https://app.example.test/account#reset=...", "expiresAt": "ISO-8601 timestamp" }
```

Requests include `Authorization: Bearer <secret>` and `Idempotency-Key: <message UUID>`.
The adapter must deduplicate by that key and return 2xx only after durable acceptance.
The worker rejects redirects and times out after 10 seconds. A scheduler must run
the worker at least once per minute and monitor failed/undelivered messages.
Exactly-once email delivery is not claimed: provider-side idempotency handles
crashes after acceptance but before the database is marked sent. Real provider
delivery and production scheduling require separate owner configuration and
verification; no real email or production infrastructure was used for this PR.

## Rate limits and operational boundaries

Fixed-window counters are incremented atomically in PostgreSQL and survive API
restarts and replicas. Expired counters are removed on subsequent requests;
only hashes of keys are stored, not plaintext IP/email labels. Hashing these
low-entropy values is not anonymization. Default limits:

| Action | Per peer IP | Per account/token | Window |
| --- | --- | --- | --- |
| Signup | 20 | 5 | 1 hour |
| Login | 30 | 10 | 15 minutes |
| Recovery request | 15 | 5 | 1 hour |
| Password reset | 20 | 10 per reset token | 15 minutes |

429 responses include Retry-After. Forwarded IP headers are not trusted: behind
Next.js or another proxy, per-IP limits conservatively apply to the API's direct
peer. Before production, configure a reviewed trusted-proxy/network policy and
edge limits for availability; do not blindly enable `trust proxy`. Account limits
still apply independently. There are no permanent lockouts; targeted temporary
throttling and fixed-window boundary bursts remain operational tradeoffs.

Use TLS, isolated database credentials, secret management, clock synchronization,
and monitoring before release. The existing Zod/PostCSS/Next.js advisories remain
explicit [security-release blockers](database.md#dependency-security-evidence).
This change does not use Zod for untrusted authentication input and does not mark
the dependency audit green.

## Tests

`npm run test -w @groupos/api` includes password hashing, input bounds, authenticated
encryption, production configuration and the original API/test-isolation tests.
`npm run test:db -w @groupos/api` uses a disposable database and exercises signup,
credential failures, cookies, CSRF, rotation/expiry/logout, cross-account access,
encrypted recovery, single-use/expired/replaced links, session invalidation,
delivery retry/concurrency, login/reset races and persistent atomic rate limits.
Migration tests preserve a pre-auth organizer/event while upgrading, redeploy
without changes, and compare schema drift. Delivery tests use in-memory adapters.

## Security review (2026-11-15)

The final review covered session fixation/absolute expiry/version revocation,
CSRF on all authentication mutations, production cookie attributes despite
spoofed proxy headers, reset replay/concurrency, account normalization and
persistent rate limits, organizer ownership, additive migration safety, and
recovery configuration/data exposure. It found and corrected stale recovery
delivery within a batch: each claim now checks that its token is still live.
Webhook response bodies are cancelled on failures as well as successes.

Additional adversarial tests cover planted cross-account sessions, non-sliding
expiry, auth-version revocation, mixed-case/trailing-slash routes and normalized
emails, forged proxy headers, post-selection token expiry/revocation, and mocked
webhook authentication/idempotency/redirect protection. No provider is contacted.
These tests supplement concurrent reset consumption and login/reset race tests.

Production release remains blocked by the recorded dependency advisories and
unverified delivery/scheduling and proxy/edge configuration. Generic auth responses
do not claim perfect timing indistinguishability; fixed-window rate limits permit
boundary bursts and can temporarily throttle a targeted account. Browser rendering
remains unverified. None of these release gates is marked resolved by this review.
