Closes #25.

The Shop sidebar uses real routes with matching labels on desktop and mobile:

| Label | Route |
| --- | --- |
| Home | `/` |
| Shop | `/shop` |
| Collections | `/collections` |
| Admin, when `isAdmin` | `/admin` |

Entries for the nonexistent `/about`, `/contact` and `/categories` routes are removed. Mobile links expose matching accessible names and tooltips through `aria-label` and `title`. The existing admin condition, layout and destinations are preserved; no category-filter feature or additional navigation destination is introduced.

The change is confined to `components/Sidebar.jsx` and its existing `tests/components/Sidebar.test.tsx` assertions. The route cases remain in place; the label assertions cover both rendered desktop and mobile links. Two additional guest/admin cases independently require each mobile link's accessible label, tooltip and matching destination. Existing contributor attribution and earlier recorded evidence remain in the commit history.

### Executed validation

Published head: `6614faf369585d75d9bb10aef53b1e883d4060ad`.

A separate fork-only [verification run](https://github.com/woahwhattheheck/mova-store/actions/runs/34152062590) checked out that exact head with Node 22.23.2 / npm 10.9.8 and the unchanged lockfile:

- `npm test -- tests/components/Sidebar.test.tsx --maxWorkers=1 --minWorkers=1`: **8/8 passed**.
- `npm run lint -- --file components/Sidebar.jsx --file tests/components/Sidebar.test.tsx`: **passed, no warnings or errors**.
- `./node_modules/.bin/prettier --check components/Sidebar.jsx tests/components/Sidebar.test.tsx`: **passed**.
- Whole-repository `npm run lint`: **failed**, with the same three warnings and `components/Toast.jsx` parse error as the exact base `65d9dfb09cbf544edbd0d6ac2954219427f734c7`.
- `npm run type-check -- --incremental false`: **failed**, with the same `components/Toast.jsx(14,22)` TS8010 parse error as that base. Both complete logs match their baseline counterparts; later type errors cannot be ruled out while parsing is blocked.

The [coverage-control run](https://github.com/woahwhattheheck/mova-store/actions/runs/34151870539), using Node 20.20.2 to match the repository CI major, also passed the eight candidate cases. Removing mobile `title` attributes or independently removing `aria-label` attributes leaves the original six cases passing but causes both new cases to fail. Removing only the Admin tooltip fails only the admin case. These are isolated test mutations, not changes to the published component.

Execution artifacts, source/test blob identities and reports are retained on those runs. This is focused validation, not a claim that upstream CI, the full frontend suite, production build, browser navigation, deployment or all acceptance checks are green. No workflow or dependency changes are included in this PR.

This AI-assisted contribution is submitted under `@woahwhattheheck`. As already disclosed in the linked issue, no GrantFox application or milestone ID is recorded for this work; this PR does not claim funded-bounty approval, acceptance or payment.
