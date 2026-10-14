# Test before release

Short checklist. Skip sections that your PR did not touch.

Use the acceptance criteria and evidence gates in
[working-method.md](../agents/working-method.md). For documentation-only work,
check accuracy, links, instruction consistency and applicable format validation;
page-load, login and runtime checks are not applicable unless behavior changes.
For behavior changes, verify the affected end-to-end result and recovery path
in an authorized environment, or document the unverified release gate (stage,
owner, steps and expected result). Identify mocks and what they do not prove.
Keep merged, deployed, runtime-verified and user-enabled states separate.

This checklist grants no permission to deploy, apply SQL, dispatch a mutating
workflow, change account/security settings or write production data. Obtain
Blake's explicit authorization for those actions; record pending gates when
authorization or access is unavailable.

---

## Every PR (quick)

- [ ] Page loads locally: `npx --yes serve .` → open the page you changed  
- [ ] Sign in works with a test user  
- [ ] No secrets committed (service role, Shopify tokens)

---

## PR touches database / Supabase SQL

- [ ] Run [`supabase/verify_v2_schema.sql`](../../supabase/verify_v2_schema.sql) in Supabase SQL Editor → all `ok`  
- [ ] If anything missing → [`apply_all_post_merge.sql`](../../supabase/apply_all_post_merge.sql) → verify again  

---

## PR touches PO builder, costing, or profile

- [ ] `/v2/po-builder.html` — create header + line  
- [ ] `/v2/po-costing.html` — FOB → shipped → freight → landed unit  
- [ ] `/v2/profile.html` — save name and default page  

---

## PR touches Planning Scenarios

Use [planning-scenarios-filter-scope.md](../planning-scenarios-filter-scope.md) acceptance checklist (filters, seed, export).

---

## PR touches sync scripts or GitHub Actions

- [ ] Run script locally with env vars set (see script header comments)  
- [ ] Or trigger workflow **workflow_dispatch** and confirm green run  

**Scripts**

| Script | Command |
|--------|---------|
| Silo nightly | `node scripts/sync-silo-inventory-sales.mjs` |
| AR | `npm run sync:ar` |
| Shopify API | `npm start` then `POST /api/sync/shopify` |

---

## PR touches v2 UI only

- [ ] Matches [SILO-BRAND.md](../../v2/SILO-BRAND.md) asset order and shell if applicable  
- [ ] Mobile nav closes (Escape / tap outside) if page has drawers  
