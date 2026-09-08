/* Planning Scenarios: the page presented scope, the growth assumption and
 * every advanced input at once, so it could not be started without already
 * understanding all of it. And the three plan tables are typed straight into
 * the DOM and persisted nowhere — a refresh discarded an afternoon of work
 * with no warning.
 *
 * These assertions cover the workflow ordering, the progressive disclosure,
 * the active-scenario readout, and the edit protection.
 *
 * NOT covered, because it does not exist: saving or duplicating a named
 * scenario. There is no scenario table behind this page — `txtScenarioName`
 * is a label on the CSV export. Adding persistence would be a schema change,
 * which this work deliberately keeps out.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const MONTHS = ['2026-04', '2026-05', '2026-06'];
const SALES = [];
MONTHS.forEach((m) => {
  ['Tee', 'Shorts'].forEach((t) => {
    ['online', 'retail'].forEach((loc) => {
      SALES.push({
        month_key: m, month_start: m + '-01', product_type: t, location: loc,
        rows: 10, unique_skus: 5, units: 500, net: 12000, gross: 13000,
        discounts: 400, refunds: 200, total_sales: 12000,
      });
    });
  });
});

const INVENTORY = [
  { variant_sku: 'T-1', product_title: 'Tee One', product_type: 'Tee', location_tag: 'online',
    total_available_quantity: 300, total_available_inventory_value: 6000, sold_30: 120, qty_365d: 1400 },
  { variant_sku: 'S-1', product_title: 'Short One', product_type: 'Shorts', location_tag: 'retail',
    total_available_quantity: 150, total_available_inventory_value: 4500, sold_30: 60, qty_365d: 700 },
];

const r = createReporter('planning-scenarios-ux');

(async () => {
  const suite = await startSuite({ viewport: { width: 1500, height: 980 } });
  try {
    const page = await suite.open('/v2/planning-scenarios.html', {
      sales_monthly_product_type_rollup_v: SALES,
      inventory_workboard_v: INVENTORY,
      v_po_open_planning_lines: [],
      revenue_projections: [],
      locations: [],
    }, {
      ready: () => {
        const n = document.getElementById('statusLine');
        return n && !/Loading/.test(n.textContent);
      },
    });
    await page.waitForTimeout(700);

    console.log('\n── the workflow is ordered and numbered ──');
    const steps = await page.evaluate(() =>
      [...document.querySelectorAll('#filtersCard .ps-step-t')].map((n) => n.textContent.trim()));
    r.ok('there are numbered steps', steps.length >= 3, JSON.stringify(steps));
    r.ok('step 1 is scope', /scope/i.test(steps[0] || ''), JSON.stringify(steps));
    r.ok('step 2 is the growth scenario', /scenario/i.test(steps[1] || ''), JSON.stringify(steps));
    r.ok('step 3 is advanced', /advanced/i.test(steps[2] || ''), JSON.stringify(steps));

    console.log('\n── advanced assumptions start collapsed ──');
    const adv = await page.evaluate(() => ({
      open: document.getElementById('advancedAssumptions').open,
      // checkVisibility(), not offsetParent: a closed <details> in Chromium
      // keeps layout boxes for its children, so offsetParent stays non-null
      // even though nothing is on screen.
      safetyVisible: document.getElementById('numSafetyPct').checkVisibility(),
    }));
    r.ok('the advanced panel is closed on arrival', adv.open === false, JSON.stringify(adv));
    r.ok('and its inputs are not competing for attention', adv.safetyVisible === false, JSON.stringify(adv));

    console.log('\n── a changed advanced setting is never hidden silently ──');
    let badge = await page.evaluate(() => {
      const b = document.getElementById('advancedCount');
      // checkVisibility as well as .hidden: .bcn-pill sets display:inline-flex,
      // which overrides the hidden attribute, so the badge rendered "0" while
      // reporting hidden===true.
      return { hidden: b.hidden, visible: b.checkVisibility(), text: b.textContent };
    });
    r.ok('no badge while everything is default', badge.hidden === true, JSON.stringify(badge));
    r.ok('and it is actually off screen, not just flagged hidden',
      badge.visible === false, JSON.stringify(badge));

    await page.evaluate(() => document.getElementById('advancedAssumptions').open = true);
    await page.fill('#numSafetyPct', '30');
    await page.waitForTimeout(400);
    badge = await page.evaluate(() => {
      const b = document.getElementById('advancedCount');
      return { hidden: b.hidden, text: b.textContent.trim() };
    });
    r.ok('changing the buffer raises a badge', badge.hidden === false && badge.text === '1', JSON.stringify(badge));
    await page.fill('#numSafetyPct', '10');
    await page.waitForTimeout(400);

    console.log('\n── the active scenario is stated where it is chosen ──');
    const atDefault = await page.evaluate(() => document.getElementById('activeScenarioChip').textContent.trim());
    r.ok('the chip names the lift', /\+25%/.test(atDefault), atDefault);

    await page.selectOption('#selScenario', '0');
    await page.waitForTimeout(400);
    r.ok('switching to plan reads as Baseline',
      /Baseline/i.test(await page.evaluate(() => document.getElementById('activeScenarioChip').textContent)),
      await page.evaluate(() => document.getElementById('activeScenarioChip').textContent));

    await page.selectOption('#selScenario', '50');
    await page.fill('#txtScenarioName', 'Holiday push');
    await page.waitForTimeout(400);
    const named = await page.evaluate(() => document.getElementById('activeScenarioChip').textContent.trim());
    r.ok('the scenario name joins the lift in the chip',
      /Holiday push/.test(named) && /\+50%/.test(named), named);

    console.log('\n── baseline and scenario are shown together ──');
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('#scenarioCards .ps-kpi-card')].map((c) => ({
        label: c.querySelector('.ps-kpi-label')?.textContent.trim(),
        selected: c.classList.contains('is-selected'),
      })));
    r.ok('several scenarios are on screen at once', cards.length >= 3, JSON.stringify(cards.map((c) => c.label)));
    r.ok('the baseline is one of them', cards.some((c) => /at plan/i.test(c.label || '')), JSON.stringify(cards.map((c) => c.label)));
    r.ok('the selected one is marked', cards.some((c) => c.selected), JSON.stringify(cards));

    console.log('\n── typed plan inputs are protected ──');
    const dirtyBefore = await page.evaluate(() => {
      const c = document.getElementById('dirtyChip');
      return { hidden: c.hidden, visible: c.checkVisibility() };
    });
    r.ok('nothing claims unsaved edits before you type', dirtyBefore.hidden === true, JSON.stringify(dirtyBefore));
    r.ok('and the chip is genuinely not rendered', dirtyBefore.visible === false, JSON.stringify(dirtyBefore));

    const typed = await page.evaluate(() => {
      const input = document.querySelector('#revenuePlanBody input');
      if (!input) return null;
      input.value = '99000';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.id;
    });
    r.ok('there is a plan input to type into', !!typed, String(typed));
    await page.waitForTimeout(300);
    r.ok('typing raises the unsaved-edits chip',
      await page.evaluate(() => document.getElementById('dirtyChip').hidden) === false);
    r.ok('and the edit is kept as a local draft',
      await page.evaluate(() => !!localStorage.getItem('silo_planning_scenario_draft_v1')));
    r.ok('the chip explains that the edits are not stored',
      /not stored anywhere|browser tab/i.test(
        await page.evaluate(() => document.getElementById('dirtyChip').title)));

    console.log('\n── a reload offers the draft back rather than restoring it ──');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const n = document.getElementById('statusLine');
      return n && !/Loading/.test(n.textContent);
    }, { timeout: 20000 });
    await page.waitForTimeout(700);

    const afterReload = await page.evaluate(() => ({
      noteShown: !document.getElementById('draftNote').hidden,
      noteText: document.getElementById('draftNoteText').textContent,
      inputValue: (document.querySelector('#revenuePlanBody input') || {}).value,
    }));
    r.ok('the draft is offered', afterReload.noteShown === true, JSON.stringify(afterReload));
    r.ok('it says the values were never stored to the database',
      /never stored to the database/i.test(afterReload.noteText), afterReload.noteText);
    r.ok('but nothing is refilled until you ask',
      afterReload.inputValue !== '99000', `input was "${afterReload.inputValue}"`);

    await page.evaluate(() => document.getElementById('btnRestoreDraft').click());
    await page.waitForTimeout(500);
    r.ok('restoring puts the typed value back',
      await page.evaluate(() => (document.querySelector('#revenuePlanBody input') || {}).value) === '99000');
    r.ok('and the note goes away',
      await page.evaluate(() => document.getElementById('draftNote').hidden) === true);

    console.log('\n── discarding is explicit ──');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const n = document.getElementById('statusLine');
      return n && !/Loading/.test(n.textContent);
    }, { timeout: 20000 });
    await page.waitForTimeout(700);
    await page.evaluate(() => document.getElementById('btnDiscardDraft').click());
    await page.waitForTimeout(300);
    r.ok('discard clears the stored draft',
      await page.evaluate(() => localStorage.getItem('silo_planning_scenario_draft_v1')) === null);

    console.log('\n── inputs carry units and short explanations ──');
    const helps = await page.evaluate(() => ({
      units: [...document.querySelectorAll('#filtersCard .ps-unit')].map((n) => n.textContent.trim()),
      helps: [...document.querySelectorAll('#filtersCard .ps-help')].length,
    }));
    r.ok('units are shown on numeric inputs', helps.units.length >= 2, JSON.stringify(helps.units));
    r.ok('short explanations are present, not paragraphs', helps.helps >= 3, JSON.stringify(helps));
    r.ok('the scenario-name field says it is not persisted',
      /not saved to the database/i.test(
        await page.evaluate(() => document.querySelector('#txtScenarioName').parentElement.textContent)));

    console.log('\n── narrow screen ──');
    await page.setViewportSize({ width: 480, height: 900 });
    await page.waitForTimeout(300);
    r.ok('the page body does not scroll horizontally',
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2));

  } catch (err) {
    r.ok('suite ran without throwing', false, err && err.stack ? err.stack : String(err));
  } finally {
    await suite.close();
  }

  const out = r.summary();
  process.exit(out.fail ? 1 : 0);
})();
