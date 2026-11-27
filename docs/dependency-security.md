# Dependency security review — GOS-013

Review date: 2026-11-20. Base: `58243b1300bf7453d3d07d4e2d192730dd14ed64`,
including merged [dashboard PR #9](https://github.com/olamide87/groupos/pull/9).
This review covers dependencies, not overall production or MVP acceptance.

PR #10 was merged as `2ffd29d9cb53905f1a9bb12ef65d3c0b167bd10b`.
Phase 2 reverified the unchanged dependency graph on 2026-11-26 using a clean
Node 22.23.5/npm 10.9.8 install: full audit and npm ls both exited 0, with zero
vulnerabilities. This does not confer CI or production verification on Phase 2.

## Baseline

`npm audit --json` exited 1: six affected packages, five high and one moderate,
zero critical. Counts include transitive parent findings, not six unique advisories.
`npm ls --all --json` exited 1 with a separate deepmerge-ts ELSPROBLEMS diagnostic.
`npm explain` confirmed the paths below.

| Installed package/path | Advisory and affected range | First patched version | Execution boundary |
| --- | --- | --- | --- |
| API → zod 3.25.76 | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), high, <4.6.6; constrained collection memory exhaustion | 4.6.6 | Declared production dependency, but no source imports or runtime use found |
| Web → next 15.5.29 → postcss 8.4.31 | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93), moderate, <8.5.10; CSS stringify XSS | 8.5.10 | Production dependency tree; CSS build/development processing, not a GroupOS user-CSS endpoint |
| Same PostCSS path | [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q), high, <=8.5.11; source-map file disclosure | 8.5.12 | Same build boundary; no exposure exemption claimed |
| Same PostCSS path | [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849), high, <=8.5.17; source-map traversal | 8.5.18 | Same build boundary |
| Same PostCSS path | [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp), moderate, <=8.5.22; incomplete source-map fix | 8.5.23 | Same build boundary |
| API → prisma 6.19.3 → @prisma/config 6.19.3 → effect 3.21.0 | [GHSA-7589-6fvf-x4pw](https://github.com/advisories/GHSA-7589-6fvf-x4pw), high, <=3.22.0; TemplateLiteral regex denial of service | 3.22.1 | Prisma CLI configuration, generation/migrations; no API request-path import. CLI is a dev dependency but also an optional client peer, so do not assume every production install omits it |

Next.js is a moderate transitive finding through PostCSS, not a separate advisory
in this audit (npm's parent affected range: 9.3.4-canary.0–16.3.0-preview.10).
Prisma and @prisma/config are high transitive findings through Effect (npm's parent
affected range: >=6.13.0-dev.1). Audit suggested Next 16.4.6 and a Prisma downgrade
to 6.12.0; neither is necessary if compatible patched transitive packages work.

## Remediation and compatibility

- Remove unused Zod rather than adopt an unused major-version migration. Existing
  explicit request validation remains unchanged.
- Retain Next 15.5.29; scope PostCSS 8.5.23 to Next. This crosses its exact 8.4.31
  dependency pin, so production build and actual Chromium behavior must pass.
- Retain matching Prisma CLI/client 6.19.3; scope Effect 3.22.1 to @prisma/config.
  This crosses its exact 3.21.0 pin within major 3; validate generation, migrations,
  drift, persistence and authentication before accepting it.
- Retain the existing root deepmerge-ts 8.0.0 override; its only consumer is
  @prisma/config. Upstream still declares
  7.1.5. Downgrading would restore [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)
  (high, <8.0.0; recursive graph stack exhaustion; patched 8.0.0). This is a
  tested major-version override, not upstream certification of compatibility.
- Pin Node 22 and npm 10.9.8. npm 11.13.0 ignored workspace overrides and marked
  overridden packages invalid, matching [npm issue #9514](https://github.com/npm/cli/issues/9514).
  A version declaration alone is not evidence: verify installed versions, the
  complete dependency graph, clean installation and audit. CI checks both graph
  validity and the full audit without suppression or severity filtering.

Overrides must be revisited when upstream parents adopt patched dependencies.
Do not remove them merely to silence a compatibility diagnostic. No lockfile
entries are hand-authored and `npm audit fix --force` is not used.

## Verification

Local verification on Node 22.23.5 / npm 10.9.8 (2026-11-20):

| Check | Actual result |
| --- | --- |
| npm-generated lockfile and clean `npm ci --no-audit --no-fund` | 168 packages installed; exit 0 |
| `npm ls --all --json` | Exit 0; no invalid/missing dependencies or deepmerge diagnostic |
| `npm explain` | PostCSS 8.5.23, Effect 3.22.1, deepmerge-ts 8.0.0; expected overrides recognized; Zod absent |
| `npm audit --json` after clean installation and after all tests | Exit 0; zero info/low/moderate/high/critical findings |
| Prisma validation and client generation | Exit 0, CLI/client 6.19.3 |
| API TypeScript and frontend build/typecheck | Exit 0 |
| API unit tests | 11 passed, 0 failed |
| Database integration tests | 77 passed, 0 failed; fresh baseline, populated legacy upgrade, repeat deployment and empty schema drift |
| Playwright Chromium E2E | 7 passed, 0 failed; production frontend, synthetic users and disposable database |
| Cleanup | Zero disposable databases remained; owned browser/API/frontend services cleaned up and local PostgreSQL test server stopped |

Before: six affected packages (five high, one moderate), audit exit 1 and graph
exit 1. After: zero affected packages, audit exit 0 and graph exit 0. No known
advisories remain in this audited graph at this review snapshot. This is not a
claim that future advisories or unreported vulnerabilities cannot exist.

The lockfile was generated by npm, including npm 10 metadata normalization and
deduplication of the compatible Express `@types/send` declaration. No application
or database schema logic changed. Existing adversarial integration/browser tests
were retained without weakened assertions. New CI audit/graph gates prevent
silently accepting the earlier invalid override graph.

[Linux CI passed](https://github.com/olamide87/groupos/actions/runs/44866010093)
on implementation commit `f2d6e2826143b3109b71c9629473d5f1d7b4c606`, including
the full audit/graph gates and all functional checks above. Final-head CI is
maintained on [PR #10](https://github.com/olamide87/groupos/pull/10); merge requires
explicit approval.

## Remaining release gates

Production recovery delivery/scheduling, trusted-proxy/edge protections, retention
policy, broader accessibility/cross-browser assessment, staging smoke verification
and owner release approval remain open. No production services or real messaging
are used by this dependency review. GOS-013 and the MVP remain incomplete.
