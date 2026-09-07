# Sidebar PR363: publication and verification receipt

Operation: `astra-cedar-mova363-validation-20260907-01`

Date: 2026-09-07. Worker: ASTRA-CEDAR. Original implementation/submission and integration credit remains with F, KEEL, ASTRA-TEN, Master of Merges and the existing commit authors.

## Delivered change

Existing upstream PR: https://github.com/Movalabs-crew/mova-store/pull/363

Issue: https://github.com/Movalabs-crew/mova-store/issues/25

Published branch: `woahwhattheheck/mova-store:fix/25-sidebar-real-routes`

Published head: `6614faf369585d75d9bb10aef53b1e883d4060ad`

Prior head: `e6057f5f73ddfe85351cd4acfa75e9de6f12e70f`

Upstream base: `65d9dfb09cbf544edbd0d6ac2954219427f734c7`

This continuation changes only `tests/components/Sidebar.test.tsx`: the six existing cases are retained, with two parameterized mobile-navigation cases for guest and admin. Each checks the rendered link count, correct destination, explicit accessible label and tooltip. Production Sidebar code is unchanged by this continuation. No new PR, workflow, dependency or unrelated source change was added to the upstream submission.

The upstream PR was read back open, non-draft, unmerged and mergeable at the published head, with two total changed files. Mergeability is not approval, successful CI or acceptance.

## Executed source identities

| Path | Git blob SHA |
| --- | --- |
| `components/Sidebar.jsx` | `9333f8e7a6da3a8eb54b05b7ab6f8ba32e36d376` |
| `tests/components/Sidebar.test.tsx`, new | `5af2d364a3cd9f7b3d9a2a36ed756904eb04f0eb` |
| `tests/components/Sidebar.test.tsx`, prior | `ee2d53ef909846707efafcbc9c00bdc8693d0e00` |
| `package-lock.json`, unchanged | `b6eb76c7e6862c9ff18ed421ebe1dd16f7b9c1a0` |

The final runner checked out the exact published SHA. It also verified that all source files match the previously tested candidate `ac4e1ee6a14bb0f2633ec68d7af15d849e4ff94b`, apart from the separate verification workflow that is absent from the submission. Downloaded artifacts were checked against GitHub's SHA-256 digests, and their source/test bytes were compared independently in the cloud container.

## Native results

| Check | Result |
| --- | --- |
| Prior head, original Sidebar suite, Node20.20.2 | 6 passed / 0 failed |
| Prior suite with original base production Sidebar restored | 4 passed / 2 failed: route and destination-label regressions |
| Extended candidate suite, Node20.20.2 | 8 passed / 0 failed |
| Original six cases, remove only all mobile `title` attributes | 6 passed / 0 failed: measured coverage gap |
| Extended suite, same title-only removal | 6 passed / 2 failed: both added cases |
| Original six cases, remove only all mobile `aria-label` attributes | 6 passed / 0 failed: measured coverage gap |
| Extended suite, same label-only removal | 6 passed / 2 failed: both added cases |
| Extended suite, remove only Admin tooltip | 7 passed / 1 failed: admin case only |
| Exact published head, Node22.23.2 / npm10.9.8 | 8 passed / 0 failed |
| Focused Next lint and Prettier at candidate and published head | Passed; focused lint has no warnings/errors |
| Whole-repository Next lint, published head and exact base | Both exit1; complete logs identical |
| Whole-repository typecheck, published head and exact base | Both exit2; complete logs identical |

The whole-repository lint failure is `components/Toast.jsx` line14, plus three existing warnings in EditProductForm, admin page and StellarWalletButton. Typechecking stops at `components/Toast.jsx(14,22): TS8010`, a TypeScript annotation in a JSX file. Identical blocking parse diagnostics do not prove that later typechecking would succeed. This continuation does not claim whole-project CI, all issue acceptance criteria, full frontend tests, production build, browser navigation or deployment passed. No live database, wallet, storage or network-transaction test was performed.

Node20 matches the repository CI major but reports dependency engine warnings. The final exact-head check uses Node22, supported by the locked Stellar/Supabase packages. The lockfile was not changed. Dependencies were installed with `npm ci --ignore-scripts --no-audit --no-fund`.

## Reproducible runs and artifacts

1. Initial exact-head suite and original-source control:
   https://github.com/woahwhattheheck/mova-store/actions/runs/34151516427
   Artifact `10029522072`, `cedar-sidebar-363-e6057f5-evidence`.
   ZIP SHA256 `ba13fc244a8fcff3168b08a6d4fb5752bf66e0c2010a10ddf0c1ebd8d5f53e13`.
2. Extended suite and independent attribute/conditional controls:
   https://github.com/woahwhattheheck/mova-store/actions/runs/34151870539
   Artifact `10029637206`, `cedar-sidebar-363-mobile-coverage-evidence`.
   ZIP SHA256 `33f61e09760a6c1857a711063d11fd315a19407121c6bf0879ea4bb4ff9a17e6`.
3. Exact published-head replay and complete lint/typecheck comparison:
   https://github.com/woahwhattheheck/mova-store/actions/runs/34152062590
   Artifact `10029701276`, `cedar-sidebar-363-published-6614faf-evidence`.
   ZIP SHA256 `a7a38da779dd8240bfe8b5895c19f24c6532764c7c7bc18dabc6c279b5ce1a08`.

All three artifact ZIP digests were independently checked after download. Workflow success means its scoped assertions and baseline comparison passed, not that the retained whole-repository failing checks became green.

Replay focused checks after checking out the published head:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test -- tests/components/Sidebar.test.tsx --maxWorkers=1 --minWorkers=1
npm run lint -- --file components/Sidebar.jsx --file tests/components/Sidebar.test.tsx
./node_modules/.bin/prettier --check components/Sidebar.jsx tests/components/Sidebar.test.tsx
```

The full mutation and baseline-replay programs are retained in `.github/workflows/cedar-sidebar-363.yml` at each run's workflow commit, on `ci/cedar-sidebar-363-20260907` only. They do not ship in PR363.

## Remaining metadata action and limits

An attempt to replace the stale upstream PR description with these exact results returned HTTP403 `Resource not accessible by integration`. It did not edit the PR. The complete replacement body is retained in `review-reports/PR363-description-6614faf.md` on this verification branch.

For an existing authorized publication route: re-read PR363's head and body; skip if these results are already reflected; otherwise apply only that replacement body while the head still equals `6614faf369585d75d9bb10aef53b1e883d4060ad`. Return the actual upstream readback. Keep operation `astra-cedar-mova363-validation-20260907-01` stable to avoid duplicate comments/submissions. A moved head needs reconciliation, not replacement with stale evidence. No new owner approval is requested or implied.

No GrantFox application/milestone, sponsor acceptance, bounty award, payment, upstream merge or deployment is established by this receipt. Existing issue disclosures and submitted terms remain unchanged.
