# Mova dependency remediation — 2026-09-07

PR12's assembled frontend passes, but its existing CI dependency audit fails. This follow-up repairs that graph without changing the audit threshold or workflow. It is stacked on `ca043c92ef88b3166d11fe78e3d829b6caacb4b3`; PR12's source attributions remain authoritative. F retains upstream integration and sponsor ownership.

## What changes

- Next.js 14.2.5 → patched Maintenance LTS 15.5.24, matching ESLint config, React 19.2.8, NextAuth 4.24.15 and Sharp 0.35.4.
- Vitest, coverage and UI move together to 4.1.11; Vite 6.4.3 and React Testing Library 16.3.3 supply compatible peers. Supported Node versions now match the test tooling and existing Node20 CI.
- The official `next-async-request-api` codemod changes the product page to unwrap promised params with React `use`. Its real-page cart tests await React's async render. Two existing indexer test doubles use constructible functions as required by Vitest4; production Stellar/payment source is unchanged.
- Coverage explicitly includes covered and uncovered application source; all four existing thresholds stay intact. `next typegen` precedes TypeScript so a fresh checkout has route definitions before the existing type gate runs.
- Next15 pins an old PostCSS internally. A narrow Next-only override uses the directly declared patched PostCSS range. npm's in-place update/dedupe retained the old nested lock entry, so the lockfile was regenerated and a clean `npm ci` verified it. Other declared ranges stay intact; their resolved patch/minor versions are listed in the evidence JSON, including Stellar SDK16.3.0 and Supabase2.115.0.

## Actual execution

| Check                                        | Result                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Native npm audit                             | 27 findings (3 critical / 14 high / 8 moderate / 2 low) → **0 total**               |
| Clean npm ci                                 | Exit0; patched PostCSS is the sole resolved copy                                    |
| Frontend plus V8 coverage                    | **252 passed, 0 failed, 40 files**                                                  |
| Coverage                                     | 45.73% statements; 43.30% branches; 40.17% functions; 45.94% lines; 74 source files |
| Fresh-checkout route generation + type check | Exit0 with no prior `.next` directory                                               |
| Full ESLint                                  | Exit0; same three existing warnings                                                 |
| Production Next build                        | Exit0 with the workflow's dummy public configuration                                |
| Focused Prettier and diff check              | Pass                                                                                |
| Production browser                           | Eight checks pass; no uncaught page exceptions                                      |

The browser ran the production server and Chromium149 through Playwright with one synthetic product response. It checked home rendering, the existing anonymous-login redirect, actual shop/detail duplicate-cart removal and survivor DOM identity, persistence after reload, async product params, checkout/login rendering, and a real Next/Sharp local-image optimization response (HTTP200). Browser data interception was limited to Supabase product reads. Existing remote Unsplash requests timed out during the first network-idle attempt; the final run used actual UI readiness. Existing sidebar prefetches to `/about`, `/contact` and `/categories` still return 404 and belong to F's separate upstream363/fork13 repair. This is not a claim that every link or hosted integration is verified.

Execution used isolated Linux and Node24.19.0. Automatic CI is a separate Node20 check. No live payment, email, database, deployment or sponsor action was performed.

## Replay and sources

Run `npm ci --ignore-scripts --no-audit --no-fund`, `npm audit --audit-level=high`, `npm run type-check`, `npm run lint`, and `npm run test:coverage -- --maxWorkers=1`. For `npm run build`, use the dummy public variables already listed in `.github/workflows/ci.yml`.

Official guidance: [Next security release](https://nextjs.org/blog/august-2026-security-release), [Next15 migration](https://nextjs.org/docs/app/guides/upgrading/version-15), [Vitest4 migration](https://v4.vitest.dev/guide/migration). Exact dependency versions, source blob hashes, native audit reports, per-test statuses and browser checks are in [the evidence JSON](sable-mova-dependencies-20260907.json).
