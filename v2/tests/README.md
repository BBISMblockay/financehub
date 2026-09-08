# /v2/ inventory tests

```
node v2/tests/run.js            everything (browser suite skipped if
                                playwright is not installed)
node v2/tests/run.js --unit     unit only — needs nothing installed
node v2/tests/run.js --browser  browser only
node v2/tests/run.js cover      any suite whose filename matches
```

Runs in CI on every change to `v2/inventory.html`, `v2/inventory-signals.js`
or this directory (`.github/workflows/v2-inventory-tests.yml`). No secrets:
nothing here talks to a real database.

## Why these exist

The inventory page had three reported bugs and all three were the same bug
wearing different clothes: **a value that was missing got read as zero, and
was then presented with confidence.**

`inventory_workboard_v.days_oos` is `NULL` whenever there is no demand basis
to divide by. The page read it through a `num()` helper that returns 0 for
null, so "no cover figure exists" and "zero days of cover" became the same
number, and every consumer downstream inherited the confusion.

Measured against Baseballism on 2026-09-07 (66,745 rows):

| | rows |
|---|---|
| have a measurable days-cover basis | 8,361 |
| no matched sales history at all (**unknown**) | 26,947 |
| …of those, holding stock | 3,267 (141,242 units) |
| matched, but no sales in the recent windows | 31,227 |
| negative units on hand | 1,452 |

So the old "cover ≤ 7 days" lens was mostly returning rows it knew nothing
about. That is not a rendering problem; it is the page asserting something
false about 87% of the inventory.

A bug of that shape is invisible to someone reading the screen — the number
looks like a number. It has to be checked by a machine, which is why the
rules were pulled out of the page into `v2/inventory-signals.js` and why this
directory exists.

## Layout

```
lib/assert.js      tiny dependency-free reporter (copy of v3's)
lib/load.js        evaluates a v2 IIFE module in a node VM
lib/harness.js     static server + Chromium + stubbed Supabase
fixtures/          REAL rows captured from inventory_workboard_v
unit/              the rules, no browser
browser/           the real page in Chromium, driven end to end
```

`fixtures/sonic-rows.js` is not invented data. Every row is the exact shape
the view returns, captured while reproducing the reported bugs — including
the `days_oos: null` that started all of this. A suite that passes here is
asserting against what production actually serves.

## The suites

| suite | covers |
|---|---|
| `unit/cover-basis` | **Bug 2.** Null cover stays null; a cover lens never matches a row it cannot measure; the five stock states are distinct; unmeasurable rows sort last, not to an extreme |
| `unit/filter-lenses` | **Bug 1.** Clear lenses clears only lens-owned fields; Reset all stays separate; chips remove one thing; filters persist across view levels |
| `unit/inventory-vs-transfer` | **Bug 3.** Inventory status and transfer eligibility are separate answers; transfer never says OK; OK is earned, never fallen into |
| `unit/inventory-page-scope` | The purchasing surfaces are gone and stay gone; tagging, selection, exports and the four view levels survived; the performance fixes are still in place |
| `browser/inventory-page` | All three bugs again, end to end, against the real page in a real browser |

## Adding to them

The unit suites must keep running on a bare checkout — `node v2/tests/run.js
--unit` with nothing installed. If a suite needs a dependency, it belongs in
`browser/`.

Browser suites need:

```
cd v2/tests && npm install && npx playwright install chromium
```

The pages themselves are served **unmodified** from the checkout. Only the
outside world is faked (credentials, the Supabase SDK, fonts). If a suite
starts needing the page changed to be testable, change the page's design, not
the harness.
