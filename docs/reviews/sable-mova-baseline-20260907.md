# Mova baseline integration

SABLE-WORK assembled this fork-only baseline from `65d9dfb09cbf544edbd0d6ac2954219427f734c7`
for F's existing Mova submissions. F retains upstream integration and sponsor
communication. This branch is a combined adoption option; the original branches
and narrow PRs remain available.

The final frontend run passes **252 tests in 40 files**. Type checking and lint
both exit zero. Lint retains three existing warnings: two admin-page image
warnings and the StellarWalletButton effect dependency. The source manifest,
per-test results and exact commands are in the adjacent JSON receipt.

## Composition and credit

| Source | Adopted work |
| --- | --- |
| [LATTICE-ETA PR5](https://github.com/woahwhattheheck/mova-store/pull/5) | Toast duration, timer cleanup and lifecycle tests, exact published files |
| [ALDER PR6](https://github.com/woahwhattheheck/mova-store/pull/6) | Remove the redundant persistent ContactUs alert, exact published file |
| [CAIRN-WORK PR8](https://github.com/woahwhattheheck/mova-store/pull/8) | Checkout tests use the persisted-cart contract, exact published file |
| [Lany488 upstream PR353](https://github.com/Movalabs-crew/mova-store/pull/353) | CartContext item IDs and instance-specific removal; repository formatter applied |
| [zhangb06 upstream PR255](https://github.com/Movalabs-crew/mova-store/pull/255) | Remove the zero-byte validation test file that breaks collection |
| [SEDGE PR10](https://github.com/woahwhattheheck/mova-store/pull/10) | Exact SQL migration and standalone SQL regression/replay; timestamp expectation adapted from SEDGE-DELTA's shared check |
| [SEDGE-DELTA PR11](https://github.com/woahwhattheheck/mova-store/pull/11) | Exact Git attributes repair preserving binary asset bytes |

The application checkout behavior and `lib/products.js` remain unchanged.
The product test uses a fixed Date and asserts the existing complete update
payload, including its client timestamp. The other Stellar/checkout changes
from upstream PR353 are not part of this baseline.

## Integration repair

Both real shop pages still keyed duplicate cart rows by product ID even after
adopting CartContext's item IDs. SABLE connected their row keys to `cartItemId`
and added four tests rendering the actual shop and product-detail pages. They
remove either duplicate, require the surviving DOM row to retain its identity,
check persisted cart/count/price, and reject duplicate-key warnings. All four
fail with the original page keys and pass in the integrated frontend run.

Product fetching is mocked in these page tests. Existing email and service
mocks remain in the native suite. No real order, payment, email or hosted
database operation occurred.

## Reproduce and adopt

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test -- --maxWorkers=1 --minWorkers=1
npm run type-check
npm run lint
```

The SQL replay is documented in `tests/db/README.md`. Its two passing cases are
SEDGE's inherited execution evidence on byte-identical source. The twenty
binary-asset checks and text normalization control are SEDGE-DELTA's inherited
evidence; this integration did not rerun those unchanged batteries.

Next production build, browser visual QA, hosted service behavior and upstream
submission are not validated here. The combined frontend results do not certify
different feature branches. Apply this baseline or its selected commits before
running the affected feature checks in F's chosen branch. Do not also apply the
same narrow PR changes a second time.
