# Instructions for coding agents working on GroupOS

GroupOS is a standalone group coordination product. Do not depend on AgentBook.

Before making changes, read `docs/DEFINITION_OF_DONE.md`, `docs/BACKLOG.md`, and `docs/architecture.md`.

Choose the highest-priority unblocked item, make the smallest end-to-end useful change, add tests, and run the CI-equivalent commands. If CI is red, fix it before taking on additional features. Update backlog status only when backed by passing checks.

Required commands from repository root:

```sh
npm install --no-audit --no-fund
npx tsc --noEmit -p apps/api/tsconfig.json
npm run test -w @groupos/api
npm run build -w @groupos/web
```

Use short-lived branches and PRs. Do not commit secrets, change GitHub repository visibility, merge PRs, deploy to production, send participant messages, incur charges, or run destructive migrations without explicit human approval. If blocked, report the exact blocker and next safe action. Never claim tests passed without running them.
