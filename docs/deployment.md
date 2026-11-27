# Authentication edge and recovery operations

These are deployment requirements and examples, not a verified deployment.

## Network boundary

The supported production path is browser → TLS edge → API for `/api/v1/`, and
browser → TLS edge → Next.js for pages. Build Next with
`GROUPOS_API_PROXY_MODE=edge` to disable its API rewrite. Preserve the browser's
Origin, cookies and X-GroupOS-Request header. Configure `AUTH_ORIGIN` to the exact
public HTTPS origin. Secure cookies and CSRF remain based on this configuration,
never on caller-provided forwarding values. Do not serve/cache API responses at
the edge. Do not log Authorization, Cookie, bodies, reset URLs or token values.

Express `trust proxy` remains false. `API_PROXY_MODE=trusted` requires
`API_TRUSTED_PROXY_CHAIN`, a JSON array of 1–3 exact IPs, nearest to API first.
Example: `["10.20.0.10"]`. No wildcard, CIDR, hop-count or automatic discovery is
supported. The socket peer must equal the first IP. X-Forwarded-For must contain
exactly client, then remaining proxies in reverse order. Every request must have
one X-Forwarded-Proto equal to `https` and one X-Forwarded-Host equal to AUTH_ORIGIN's
host (including any nondefault port). Forwarded, X-Real-IP, X-Forwarded-Port,
duplicate, malformed, shorter, longer and reordered chains are rejected with 400.
IPv6 forms and IPv4-mapped IPv6 are normalized before rate limiting.

The public edge must **overwrite**, not append to, incoming forwarding headers.
An inner proxy may append only its verified immediate upstream address after
enforcing its own allowlist. Firewall each hop so only its designated upstream
can reach it. API_BIND_HOST defaults to loopback; if changed to a private address,
allow only the nearest proxy to the API port. Next's port must also be private.
No untrusted local process may share the proxy's network identity. Header checks
cannot authenticate a compromised or publicly bypassable trusted proxy. Review
and test the real topology before enabling trusted mode; no topology was deployed.

`API_PROXY_MODE=direct` ignores all forwarding headers and rate limits by the
socket peer. Production requires an explicit mode. Direct mode behind Next is
conservative but shares an IP quota; it is not a production client-IP solution.

Required edge controls: TLS, public Host allowlist, request/body/header size limits
(API body maximum 8 KiB), bounded connection/request timeouts and per-source
throttling for auth and invitation endpoints. Apply IPv6 /64 aggregation and
global concurrency limits at the edge; API canonicalization does not prevent
IPv6 address rotation or distributed attacks. Tune thresholds with synthetic
staging load tests. Keep database-backed account/token limits enabled. Health
probes in trusted mode must traverse the same configured header/path boundary.

## Recovery worker

Keep the existing encrypted outbox and authenticated HTTPS adapter. API/worker
share AUTH_RECOVERY_KEY through private secret management. The worker needs
DATABASE_URL, AUTH_ORIGIN, NODE_ENV=production, AUTH_RECOVERY_WEBHOOK_URL and
AUTH_RECOVERY_WEBHOOK_SECRET. Do not place these in source control or command-line
arguments. The provider must durably deduplicate Idempotency-Key (message UUID)
for at least the reset validity/retry horizon and reject expired messages.

Claims last 60 seconds, with at most five attempts. Failures retain encrypted
payloads and the lease as a retry delay. Acknowledgements match both attempt and
lease, so an older worker cannot clear a newer claim. Duplicate external delivery
is still possible after a crash or lease overrun; provider idempotency is mandatory.
Delivery does not alter token validity: reset always checks expiry/revocation.
Batches stop claiming after 40 seconds (up to 20 messages); webhook timeout is
10 seconds. A process supervisor bounds database stalls and long shutdowns.

Run `npm run auth:deliver-recovery -w @groupos/api -- --check` for read-only,
operator-only aggregate health. There is no recovery health HTTP endpoint.
It reports pending, expired/revoked, exhausted (five attempts), stuck (unsent
older than five minutes), and oldest age. Counts overlap. Exit 1 signals alerts;
delivery also exits 1 on failed attempts. Monitor output before cleanup so expiry
loss is not hidden. Alert on missing worker completion for two minutes, any
exhaustion/expiry, or growing backlog; an empty queue cannot prove a scheduler
is alive. Restrict CLI/DB access and logs to operators. Never log payloads.

The systemd examples in `deploy/` schedule once per minute without overlapping
instances on one host. Adapt paths, service account and private environment file;
review with `systemd-analyze verify` on the deployment host. They are examples,
not installed services. Multiple hosts remain safe only with database leases and
provider idempotency. Test failover, monitoring and real provider acceptance only
after explicit owner approval.

The service explicitly sets NODE_ENV=production. The private environment file
must not override that setting to development. Runtime tooling (`tsx`) must be
present in the worker image; a production-only npm install omitting development
dependencies is not sufficient for this repository's current TypeScript launcher.

## Developer verification

Full local verification on 2026-11-26 used Node 22.23.5, npm 10.9.8 and the
identified loopback PostgreSQL 17.7 test service. All commands below exited 0:

| Command/check | Result |
| --- | --- |
| `npm ci --no-audit --no-fund` | 168 packages installed from unchanged committed lockfile |
| `npm ls --all --json` | Valid graph, no compatibility diagnostics |
| `npm audit --json` | Zero vulnerabilities at all severities |
| `git diff --check` | Clean |
| `npm run db:validate -w @groupos/api` | Schema valid |
| `npm run db:generate -w @groupos/api` | Prisma client 6.19.3 generated |
| PostgreSQL connectivity | `groupos_test` control database/role, PostgreSQL 17.7 |
| `npx tsc --noEmit -p apps/api/tsconfig.json` | Passed (local compiler invoked directly) |
| `npm run test -w @groupos/api` | 16 passed, zero failed |
| `npm run test:db -w @groupos/api` | 82 passed, zero failed; baseline/upgrade/repeat migrations, empty drift |
| `npm run build -w @groupos/web` | Production build and web typecheck passed |
| `npx playwright install chromium` | Passed (local Playwright CLI invoked directly) |
| `npm run test:e2e -w @groupos/web` | 7 Chromium scenarios passed, zero failed |
| Next configuration checks | Edge disables rewrite, local preserves it, invalid mode rejects: 3 passed |
| Cleanup | Zero disposable databases; owned browser/API/frontend services cleaned up |

Logs remain private under ignored `.local/phase2-final-*`. This is local evidence,
not Phase 2 GitHub CI or production evidence. The existing test PostgreSQL service
was already running and was left running. Package manifests and lockfile were
unchanged. No real recovery provider was contacted.

Deployment examples were reviewed, but `systemd-analyze verify` via the installed
Ubuntu 18.04 WSL environment exited 1: it could not determine the cgroup or
initialize its manager. Native Linux validation, operator-specific paths/users,
secrets, timer execution, firewall topology and provider acceptance remain
unverified. No infrastructure was provisioned or changed.

The following focused evidence predates the complete local run:

Focused verification on 2026-11-22 passed: API TypeScript; five proxy/health unit
tests; seven auth/recovery integration tests; three Next proxy-mode assertions.
The disposable runner's migration/redeploy/drift checks also passed. To repeat
only the focused database tests, set
`GROUPOS_AUTH_TEST_PATTERN='edge hardening|delivery|concurrent recovery'`;
this selects auth.integration.ts only, then unset it before full verification.

Use Node 22 and npm 10.9.8. Run from the repository root with the existing local
PostgreSQL test service on loopback, control database `groupos_test`, and a role
allowed to create/drop its disposable test databases. Set TEST_DATABASE_URL to
that control database and DATABASE_URL to the same local URL for Prisma tooling.
The test runners create, migrate and remove unique databases; never supply a
production URL. Unset GROUPOS_AUTH_TEST_PATTERN for the complete suite and keep
GROUPOS_API_PROXY_MODE=local for existing Chromium tests.

```powershell
Remove-Item Env:GROUPOS_AUTH_TEST_PATTERN -ErrorAction SilentlyContinue
$env:GROUPOS_API_PROXY_MODE='local'
npm ci --no-audit --no-fund
npm ls --all
npm audit
npm run db:validate -w @groupos/api
npm run db:generate -w @groupos/api
npx tsc --noEmit -p apps/api/tsconfig.json
npm run test -w @groupos/api
npm run test:db -w @groupos/api
npm run build -w @groupos/web
npx playwright install chromium
npm run test:e2e -w @groupos/web
```

Stop on any nonzero command. `test:db` includes migration upgrade, repeat deploy
and drift checks. No separate migration against an application database is needed.
Full-suite results, production topology/provider validation, edge load testing,
retention and broader release acceptance remain required before release.
