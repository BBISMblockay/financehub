# Ask SILO: keeping a claim tied to the evidence it came from

**Status:** implemented 2026-09-16. Migration `20260916140000` and an edge
function deploy are both required and neither ships by merging — see
*Deployment* at the bottom.

## What happened

Two answers, traced from `silo_chat_audit_log`:

| audit id | question |
|---|---|
| `c0b642ca-3bc4-4703-be94-995cb7f0a7b9` | four weeks of spend vs return, then three actions |
| `7c90b2cd-84a2-4ce8-888f-a2186ba0927c` | was the Sonic subscriber campaign effective at building demand |

Every statement they ran was valid. Every figure they published existed. The
labels did not.

**1. A combined-platform total published as one platform's.** The first answer
opened with *"Meta ad spend jumped … to $118,946 the week of Aug 24-30"*, then
paired that with *"what Meta itself claims it drove … $115,638"* and a ROAS of
1.01. Re-measured 2026-09-16 for 24–30 Aug: Meta `$114,334.99`, Google
`$4,610.92`, **combined `$118,945.91`**. The headline number was the combined
one; the value and the ratio beside it were Meta-only. The per-platform split
was returned by *the very next query in the same request*.

The mechanism is visible in the SQL. Query 8 summed `ad_spend` from
`marketing_daily_totals_v` — a view with **no `platform`, `campaign_name` or
`ad_id` column at all**, so every figure in it is already pooled. Nothing about
the returned array said so, and there is no column missing from the query to
give it away.

**2. A bucket straddling a launch, read as after it.** Query 12 bucketed by
week with edges `2026-08-17 / 08-23 / 08-24 / 08-30 / 08-31 / 09-06 / …`. Week
3 runs **31 Aug – 6 Sep** and the collab launched **1 Sep**. Measured:
`$17,500.00` of Subscribers spend on **31 August** — before launch — against
`$85,120.14` of attributed value landing 1 Sep onward, giving a 4.86. The
answer reported *"$17.5K spent post-launch on the same campaign returned
4.86"* and built its first recommendation ("throttle spend until launch day,
then scale up") on that before/after.

**3. One population, two campaigns.** The second answer selected ads with
`meta_ad_creatives.body ilike '%sonic%'` — no campaign predicate, no date
predicate — and reported *"Ad spend fell to $25,488 … the campaign had shifted
off lead-gen"*. Measured for 1–7 Sep across that population: **Purchase
Campaigns `$25,488.06`, Subscribers `$0.00`**. Two campaigns, one of which had
stopped spending. Also: `meta_ad_creatives` holds creative as it stands *now*,
overwritten each sync, so a set selected by today's copy is not evidence about
what any ad said on a past date.

**4. A recommendation the evidence did not reach.** Cutting
subscriber-acquisition spend was recommended on immediate purchase ROAS, with
no subscriber-to-order linkage anywhere in the request — the same answer
elsewhere correctly says no such linkage exists.

> These figures are **captured observations from 2026-09-16, not constants.**
> Historical attribution and synced data both move. A re-check that disagrees
> means the observation is stale, not that production is wrong.

## Confirmed causes, and what is only a contributing factor

**Confirmed, and shared by all three mislabellings: a query result carried no
record of its own scope.** `run_sql` returned `JSON.stringify(rows)`. Over
nineteen rounds the model accumulates a wall of anonymous arrays and must
remember which was all-platform, which was one campaign, and where a bucket's
edges fell. In trace 1 it had the correct per-platform split in hand and used
the pooled number anyway.

**Confirmed for failure 4: the budget-exhausted instruction demanded an
answer.** It ended *"state the assumption or caveat in one short line instead
of refusing to answer"*. Trace 1 stopped at round 19 of 20. A complete answer
to "give me three actions" is three actions, supported or not.

**Contributing, not confirmed: the schema slice is chosen once.**
`buildSchemaSection()` ranks relations on the opening question's own tokens and
freezes the top 8 for the request (it has to — it is the cached prompt prefix).
Replaying trace 1's question against the live catalog, the slice was
`shopify_landing_pages_daily, marketing_kpis_daily, launch_actuals_v,
meta_ad_performance_v, search_console_page_daily, shopify_collections,
demand_coverage_by_type_v, meta_ad_performance_daily` —
`marketing_daily_totals_v`, the view the wrong number came from, got a
one-liner. But that one-liner said *"total paid ad spend"*, so the guidance was
present and the label was still wrong. Retrieval is worth fixing; it is not
what caused this.

**Contributing, not confirmed: stale coverage guidance.**
`meta_ad_performance_daily`'s catalog card said *"COVERAGE: only about 7 weeks
of history (from 2026-07-08) … do not use it for launch comps."* Measured
2026-09-16: **415 days, 2025-07-28 → 2026-09-15**. A true sentence had become
an instruction to avoid the history it forbade using. Neither traced answer
made a launch-comp claim, so it did not cause these two — it was going to cause
the next one.

**Explicitly rejected as the fix:** a foreign key (nothing joins Meta leads to
Shopify orders, and inventing one would manufacture the linkage the answer
correctly said was absent), more prompt text on its own, and a larger time or
round budget (trace 1 had a round left; trace 2 finished in 11).

## What was built

### Controls in code

| | |
|---|---|
| **`evidence-scope.mjs`** | Derives, from the statement text and the catalog's `pg_catalog`-generated column lists: which relations were read; which scope dimensions (`platform`, `campaign_name`, `ad_id`, `location_name`, …) the result is **narrowed to** (with the literal values), **excludes**, is **restricted on with no readable values**, is **broken out** per value, or **pools**; which relations carry *none* of them and are therefore `totals_only`; what the date predicates bound; and whether the result hit the 1000-row page cap. `run_sql` returns `{ evidence_scope, rows }`, scope first. |
| **`describe_relations` tool** | Up to 6 relations per call, 3 calls per request: full columns, the full curated card (capped at 2400 chars, marked when truncated), and **measured** min/max of the day-grain date column. Widens guidance mid-investigation without touching the cached prompt prefix. |
| **Budget-exhausted instruction** | Two named parts — what the evidence supports, and which checks are still unrun — plus an explicit refusal to promote an observation to a recommendation to fill the shape of the question. The response carries `partial: true` and `partial_reason`. |
| **`silo_chat_audit_log.diagnostics`** | Per query: statement, derived scope, row count, duration, error. Plus which relations were in the up-front slice vs fetched mid-request. |
| **Catalog corrections (migration)** | The Meta ad-level card's hardcoded range is gone and **not replaced with a newer one** — `verify_v2_schema.sql` goes CRITICAL if any range returns. `marketing_daily_totals_v`'s card now states that it carries no platform or campaign column. |

### Guidance in the prompt

The scope rules — a figure may only wear a label its result supports; a ratio
names its own numerator and denominator from the same result; a period
spanning an event is on both sides of it; a name is not an objective and
current metadata is not historical fact; before/after is not cause and a
lead-gen campaign is not cut on purchase ROAS without the linkage; queried is
not reconciled. These are **prompt-only**. They are in `BASE_PROMPT_AFTER_SCHEMA`
so ordinary questions see them (a rule in `PRODUCT_CONCEPT_SYSTEM_BLOCK` reaches
concept-mode testers only — that is what `prompt.test.mjs` exists for), and
`prompt.test.mjs` asserts *which block* they land in, never merely that the text
exists.

## What the diagnostics column does and does not store

Stores: the statement, its derived evidence scope, row count, duration, error
text (capped at 400 chars), and context selection.

**Never stores result rows.** Not a sample, not the first row. A returned row is
the business data RLS exists to scope, and a second copy is a second policy to
get right; counts and shapes are what diagnose a mislabelled figure. A handler
test asserts a returned figure does not appear in the payload.

Access is unchanged: a column on a row that already lands through the caller's
own JWT under `company_entity_id = active_company_id() AND (created_by =
auth.uid() OR is_exec_or_owner())`. No new table, grant or reader.

Size is capped **before** the insert — detail is shed in order (scope objects,
then older entries) and what was shed is recorded — because an oversized
payload would fail the insert, and a logging failure must never turn a good
answer into a failed request. The function also retries the insert without the
column when it is absent, so the function and the migration can be applied in
either order.

Retention is deliberately unchanged. The table has no update or delete policy
at all — an audit log that can be edited is not one — so a sweep would have to
be a service-role job, and adding one here would be the first thing in this
change that could destroy a record. It belongs in its own change, covering the
whole row.

## Corrections from the independent review (cycle 1)

Two P2 findings, both reproduced against the module before fixing, and both the
same shape as the failures it was built for — the envelope asserting something
the statement did not support:

- **An exclusion was reported as an inclusion.** `platform <> 'meta_ads'`,
  `!= 'meta_ads'` and `NOT IN ('meta_ads')` all fed the same positive-value
  collector, so a correct *non*-Meta total came back carrying
  `narrowed_to: platform = ['meta_ads']` — the opposite of the query. Fixed:
  the operator decides the list, `excludes` is its own key, and a predicate
  whose effect cannot be written as values (a range, a `LIKE`, a null test)
  goes to `restricted_no_readable_values` rather than being reported as a
  narrowing to some value or as no filter at all.
- **A date window was manufactured from stray ISO literals.**
  `day_date >= current_date - 30` reported *"covers every date"* (a month of
  data described as all history), and `day_date >= '2026-09-01'` reported a
  window from 1 September **to** 1 September (an open range described as one
  day). Fixed: bounds are read from the **operators**, a window is published
  only when both ends are bounded and dates are written into the statement, and
  every other case names what it could not read. The right-hand side must be a
  literal or a date function, so `t.day_date = m.day_date` is a join key rather
  than a fully specified period — the same lesson as the `ad_id` join key on
  the value side.

Both now have regression tests, and four mutations restoring the old behaviour
each fail the suite.

## Tests, and the line between them

`evidence-scope.test.mjs`, `handler.test.mjs` and `prompt.test.mjs` are
**deterministic** and run in CI with no secrets. They assert what the code
computes, what the handler puts in front of the model, and what it writes to the
audit row. Every fix was mutation-tested: broken deliberately, and a test
failed.

`evals/evidence-scope.eval.mjs` is a **model evaluation**. It makes real, paid
Anthropic calls, is not deterministic, and is **not** in CI — only its
`--dry-run` is, which builds every prompt and transcript and sends nothing (it
scrapes constants out of `index.ts`, so a rename would otherwise surface
halfway through a paid run). It replays the traced failures as scripted
transcripts and can run a `--baseline` control arm with the envelope and scope
rules removed.

**A green CI run says the controls are wired. It says nothing about answer
quality.** Do not claim behavioural improvement without citing an eval run:
model id, run count, date, and whether the baseline arm was run.

## Deployment

1. Apply `supabase/migrations/20260916140000_silo_chat_evidence_diagnostics.sql`
   and run `supabase/verify_v2_schema.sql` — all rows `ok`. The migration ends
   with `refresh_chat_schema_catalog()` (two catalogued relations gain a
   column), which preserves the curated descriptions it sets.
2. Deploy `silo-chat` via `deploy-edge-function.yml`. Merging does not deploy.
3. Order does not matter: the function retries its audit insert without the
   column, and the schema-map changes are inert until the function is deployed.
