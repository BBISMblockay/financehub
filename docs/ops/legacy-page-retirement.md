# Legacy page retirement

## Scope and preflight

Requested cleanup, 2026-10-01. Baseline:
`7072325174049a0775cecaa6b49996a8bd455ea1` on `main`.
The repeated `v2/buyer.html` request was deduplicated. `v2/testmock` resolves
unambiguously to `v2/testmock.html`; no extensionless file or directory exists.

This change retires static entry points only. It does not remove database
records, storage files, shared libraries, sync jobs, auth logic, or Git history.
It is separate from the landing-page animation and billing work.

Before editing, the dependency audit covered all surviving HTML/JS/TS sources,
iframe `data-tool` configuration, current navigation, profile landing choices,
login/index routing, scripts, workflows, tests, agent guidance, and ops docs.
A read-only production aggregate on 2026-10-01 found **zero stored profile
landing defaults** for the requested paths and `v2/checkwriter.html`, including
query/hash, absolute-origin, leading-slash and extensionless variants. No
profile was changed. External bookmarks and third-party links remain unknown.

## File matrix

| Requested path | Outcome | Reason / preservation |
| --- | --- | --- |
| `employeehub.html` | Removed | Superseded; archived shell links now use `/v2/finance.html` |
| `v2/buyer.html` | Removed | Unused wrapper; unlisted root `buyer.html` remains |
| `executive.html` | Removed | Old cockpit; its archived menu entry is removed, with no invented replacement |
| `inventory.html` | Removed | Root only; `/v2/inventory.html` is unchanged |
| `mailroom.html` | Removed | Root only; `/v2/mailroom.html` is unchanged |
| `checkwriter.html` | Removed 2026-10-06 | Keepsake saved; removed with its wrapper `v2/checkwriter.html` (see below) |
| `legacy/ops.html` | Removed | Archived entry; no surviving consumer |
| `projections.html` | Removed | Root only; `/v2/projections.html` is unchanged |
| `silo-pitch.html` | Removed | Standalone unused pitch page |
| `v2/testmock` → `v2/testmock.html` | Removed | Unique repository match; unused mock |
| `legacy/pages/purchase-request.html` | Removed | Archived; current purchase-request flows unchanged |
| `legacy/pages/planning-scenarios.html` | Removed | Current engine is inlined in `/v2/planning-scenarios.html`; docs link the historical source |
| `legacy/pages/launch-calendar.html` | Removed | Archived; current calendar unchanged |
| `legacy/pages/request-manager.html` | Removed | Archived; current request manager unchanged |
| `legacy/pages/reallycoolbars.html` | Removed | Keepsake saved and verified before removal |
| `pages/product-manager.html` | Removed | Legacy tags tool; archived shell now links to Products' Catalog tab |
| `legacy/pages/intern.html` | Removed | Archived entry; no surviving consumer |
| `legacy/pages/po-report.html` | Removed | Archived; current PO reporting unchanged |
| `legacy/pages/sales-reports.html` | Removed | Archived entry; no surviving consumer |
| `legacy/pages/backend.html` | Removed | Archived; `/v2/backend.html` unchanged |
| `legacy/executive.html` | Removed | Archived entry; no surviving consumer |
| `legacy/pages/sales-db.html` | Removed | Archived entry; no surviving consumer |
| `legacy/marketing.html` | Removed | Archived entry; no surviving consumer |
| `v2/licensing/index.html` | Removed | Unlinked microsite entry; unlisted assets remain |
| `v2/wholesale.html` | Removed | Unused wrapper; `pages/wholesale.html` and BBISM receivables remain |
| `legacy/pages/po-builder.html` | Removed | Archived; current PO builder/costing unchanged |
| `legacy/pages/testing.html` | Removed | Archived entry; no surviving consumer |
| `legacy/app-status.html` | Removed | Historical static architecture snapshot; no agent/tool/workflow dependency |

Missing targets: **none**. Removed: **27**. Retained from the requested list: **1**.
`v2/checkwriter.html` was retained at the time, pending a decision on retiring both
checkwriter entry points together; both went on 2026-10-06 (see the follow-up below). No replacement check-printing workflow was found.

## Surviving reference changes

- `legacy/finance.html`: Dashboard → `/v2/finance.html`; Mailroom, Projections,
  Inventory → their current `/v2/` pages; Product Tags → `/v2/products.html?tab=catalog`;
  remove the old Executive menu entry
- `legacy/retail.html`: Dashboard → `/v2/finance.html`
- `v2/launch-calendar-guide.html` and the incident runbook: architecture → current
  `CLAUDE.md`, rather than the retired pre-v2 snapshot
- Current architecture/wrapper inventory docs reflect the removals. Historical
  planning references link to the source at the baseline commit

These are minimal URL/documentation updates. Existing unrelated broken “Classic
v1” links were already absent on `main`; they are not repaired in this request.
Current login, auth callbacks, navigation definitions, company/role checks,
current purchase orders, inventory, and mailroom files are byte-identical to the
baseline. No compatibility redirects or new entry points are introduced.

## Follow-up, 2026-10-06

Root `buyer.html`, root `checkwriter.html` and the unlisted wrapper
`v2/checkwriter.html` were removed on Blake's decision, ahead of due
diligence: both root pages loaded for anyone with no sign-in. Copies are kept
privately (the checkwriter keepsake below, plus Blake's own saves). No runtime
source, nav entry or workflow referenced any of the three; the retirement test
now lists them as retired.

## Keepsakes and recovery

Two separate ZIPs were saved privately for the requester **before deletion**:

- `silo-checkwriter-keepsake-7072325.zip`
- `silo-reallycoolbars-keepsake-7072325.zip`

Each ZIP contains the byte-for-byte original Git HTML at the baseline commit,
a per-file SHA-256 manifest, README limits, and a separate `OPEN-OFFLINE.html`
convenience copy. Checkwriter includes its local embed asset. Really Cool Bars
includes the original script dependencies, system-font fallback, and an empty
data set instead of downloading financial records. Offline copies disallow
network connections. No browser state, credentials, or runtime records were
captured. The original HTML is retained unchanged for provenance and can still
request its original online dependencies if opened while connected.

Original source SHA-256:

- Checkwriter: `0920e8f025f9722a590c9129a48b9f2e6b6caa83e5fc74ef8c17392dd982091d`
- Really Cool Bars: `8df3c60b9115773fee799dbbfca3b6eb4e7eeb784b0ca4a564815488176d32b0`

ZIP integrity, each manifest entry, and exact original-byte equality were checked.
The archives are private deliverables, not new public app endpoints. Git history
also preserves every retired page. For recovery, restore the exact file from the
baseline commit in a new branch, review its consumers, and use a new PR. Do not
restore all legacy files blindly or rewrite repository history.

## Verification and release limits

- `node v2/tests/run.js --unit`: 26 suites passed, including the new retirement suite
- `node --test tests/public-landing.test.mjs`: 15 tests passed, including guest links,
  signed-in routing, invite/recovery callbacks and failure cases
- Retirement suite: exact deleted/protected paths, 319 surviving runtime sources,
  actual archived route definitions, verified successors, both current nav profiles
- Four mutation checks correctly failed: resurrected retired file, dead runtime
  reference, missing modern inventory, and wrong replacement route
- 22 protected auth/navigation/current-workflow files compared byte-for-byte to baseline
- `git diff --check` and JavaScript syntax checks passed
- Local browser suites and offline visual QA could not run: Chromium's process
  launch fails on a restricted socket, including an approved escalation attempt.
  This is not a browser-test pass. Head CI must be checked separately
- No live test-user sign-in or production UI mutation was performed

After deployment, removed URLs receive the static host's normal missing-page
behavior. There is no traffic-log evidence about external bookmarks. No merge,
deployment, SQL apply, edge-function deploy, secret change, or production data
change is part of this PR. Migration/deployment prerequisites: **none**.
