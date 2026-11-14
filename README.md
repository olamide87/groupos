# GroupOS

Standalone group coordination. No AgentBook services or credentials are required.

## Local setup

Use Node.js 22.12+ and Docker Compose v2. Prisma CLI and Client are pinned together
at 6.19.3. PostgreSQL 17 is used in Compose and CI.

1. Copy `.env.example` to `.env` in the repository root (never commit `.env`).
2. Set separate local `POSTGRES_PASSWORD` and `POSTGRES_TEST_PASSWORD` values.
   Replace `REPLACE_ME` in both URLs with the corresponding URL-encoded password.
3. From the repository root, run:

```sh
npm ci --no-audit --no-fund
docker compose up -d --wait postgres
npm run db:validate -w @groupos/api
npm run db:generate -w @groupos/api
npm run db:migrate -w @groupos/api
npm run dev:api
```

In another terminal, `npm run dev:web` starts the frontend. The API listens on
`PORT` (default 4100). It connects to the database before accepting requests and
drains HTTP requests and closes the pool on SIGINT/SIGTERM. `/health` is a process
liveness endpoint, not a continuous database readiness probe.

The API and Prisma CLI load the root `.env`; explicit environment variables take
precedence. No seed is needed. Integration tests create their own synthetic data.

## Migrations

`db:migrate` applies committed migrations with `prisma migrate deploy`; it does not
reset a database. Verify the target URL before running it. Never point local
commands at production. To author a new migration on a disposable development
database, use `npm run db:migrate:dev -w @groupos/api -- --name descriptive_name`.
Review generated SQL and any reset prompt; do not accept destructive changes to
an existing database without approval. Commit schema and migration together, then
regenerate the client. PostgreSQL CHECK constraints are maintained in migration
SQL because Prisma does not express them in its schema.

## Verification

```sh
docker compose --profile test up -d --wait postgres-test
npm run db:validate -w @groupos/api
npm run db:generate -w @groupos/api
npx tsc --noEmit -p apps/api/tsconfig.json
npm run test -w @groupos/api
npm run test:db -w @groupos/api
npm run build -w @groupos/web
```

`TEST_DATABASE_URL` must point to the dedicated loopback server and database
`groupos_test` (Compose port 5433); its role needs CREATEDB permission. The runner
rejects remote hosts, other database names and query parameters. It creates a
random `groupos_test_<uuid>` database, applies the migration twice to check
idempotency, checks schema drift, runs relational integration tests, and drops
only that invocation's database in `finally`. It never migrates or clears the
database named in `TEST_DATABASE_URL` or the development `DATABASE_URL`. A killed
process may leave its uniquely named test database; inspect it before manual
cleanup. The test server uses temporary storage and is separate from development.

`docker compose --profile test stop` stops local services without deleting the
development volume. Do not use `down -v` against data you intend to retain.

CI uses a disposable PostgreSQL service and executes the same checks. The
workflow's test-only password is not a production credential. There is no
deployment configured by this change; production provisioning, credentials,
backups, monitoring and migration approval remain release work.

See [database design and security boundaries](docs/database.md).
