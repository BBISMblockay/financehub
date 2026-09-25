/* The report workbench: pick a source, summarise, filter, sort, preview,
 * save. Covers the curation rules too (plumbing columns hidden, matview
 * scoping forced) since those are safety properties, not cosmetics. */
'use strict';
const { startSuite } = require('../lib/harness');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { console.log('  ok   ' + n); pass++; } else { console.log('  FAIL ' + n + (x ? '  [' + x + ']' : '')); fail++; } };

(async () => {
  const suite = await startSuite({ viewport: { width: 1440, height: 940 } });
  const { BASE, ctx } = suite;
  const { page: p, errors: errs } = await suite.newPage();
 p.on('pageerror',e=>errs.push(String(e))); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
 await p.goto(`${BASE}/v3/report-builder.html`);
 await p.waitForSelector('.rb-src',{timeout:15000});

 // Must be first: once anything has previewed, there IS a lastRun.
 await p.click('#btnSave'); await p.waitForTimeout(200);
 ok('refuses to save something never previewed',
    (await p.textContent('#status')).includes('Preview it first'));

 // ── source rail ──
 const names=await p.$$eval('.rb-src-name',n=>n.map(x=>x.textContent.trim()));
 ok('lists tables and views from the catalog', names.length>=4, names.join(','));
 ok('HIDDEN objects (credential tables) are not offered', !names.includes('ad_platform_connections'));
 ok('finance/HR tables are not offered even though Ask SILO can see them',
    !names.includes('payroll_register_lines'), names.join(','));
 ok('the rail says why some tables are missing',
    (await p.textContent('#srcList')).includes('deliberately not offered'));
 const groups=await p.$$eval('.rb-group-label',n=>n.map(x=>x.textContent.trim()));
 ok('the rail leads with "Start here": '+JSON.stringify(groups), groups[0].startsWith('Start here'));
 ok('and the rest are still listed below', groups.length>=2);
 await p.fill('#srcSearch','velocity'); await p.waitForTimeout(150);
 ok('search filters the rail',(await p.locator('.rb-src').count())===1);
 await p.fill('#srcSearch',''); await p.waitForTimeout(150);

 // ── plumbing columns ──
 // The field-type grid is gone -- the rail's field browser is now the only
 // place detail columns are picked from, so that is what this checks.
 await p.click('.rb-src[data-rel="meta_ad_performance_daily"]');
 await p.waitForSelector('#genSql', { state: 'attached' });
 let chips=await p.$$eval('#fieldBrowserList [data-field]',n=>n.map(x=>x.dataset.field));
 ok('ids and sync stamps are hidden by default: '+JSON.stringify(chips),
    !chips.includes('id') && !chips.includes('company_entity_id') && !chips.includes('row_hash') && !chips.includes('synced_at'));
 ok('real columns are shown', chips.includes('spend') && chips.includes('day_date'));
 ok('a TEXT id survives', chips.includes('account_id'));
 let gen=await p.textContent('#genSql');
 ok('the generated SQL selects business columns, not *', !/select \*/.test(gen) && /"spend"/.test(gen), gen);
 ok('...and never a hidden one', !/"row_hash"|"company_entity_id"/.test(gen), gen);
 ok('a toggle offers them back', (await p.locator('#btnToggleCols').count())===1);
 await p.click('#btnToggleCols'); await p.waitForTimeout(250);
 chips=await p.$$eval('#fieldBrowserList [data-field]',n=>n.map(x=>x.dataset.field));
 ok('showing all reveals the plumbing', chips.includes('company_entity_id') && chips.includes('row_hash'));
 await p.click('#btnToggleCols'); await p.waitForTimeout(250);
 ok('and hiding them again drops them from the SQL',
    !/"row_hash"/.test(await p.textContent('#genSql')));

 // ── guided build over a VIEW ──
 await p.click('.rb-src[data-rel="sales_by_product_title_daily_v"]');
 await p.waitForSelector('#genSql', { state: 'attached' });
 // No source ever pre-picks a date column or window: a table's own column
 // order is an accident of how it was built, and the "first dateish column"
 // is a forecast (est_oos_date) on some sources, not an event date -- see
 // report-builder-ui.js's selectSource(). A deliberate choice is required
 // every time, even on a source where day_date is the obvious pick.
 ok('no date column is picked automatically', (await p.inputValue('#selDateCol'))==='');
 ok('and no window is applied by default', (await p.inputValue('#selDateRange'))==='');
 let sql=await p.textContent('#genSql');
 ok('generated SQL targets the chosen view', /from "sales_by_product_title_daily_v"/.test(sql), sql);
 ok('...with no date predicate until one is chosen', !/current_date/.test(sql), sql);

 // Choosing a date window IS still one click away.
 await p.selectOption('#selDateCol','day_date'); await p.waitForTimeout(150);
 await p.selectOption('#selDateRange','30'); await p.waitForTimeout(150);
 sql=await p.textContent('#genSql');
 ok('and carries the date predicate once chosen on purpose', /"day_date" >= current_date - 30/.test(sql), sql);

 // summarise
 await p.click('label:has(#chkSummarise)');
 await p.waitForTimeout(200);
 // No default total either: it used to sum whichever numeric column
 // happened to be first, which on inventory_on_hand_current_v is
 // retail_price -- summed across every SKU row, before anyone asked for a
 // total of anything. "+ Add a total" is the one and only way in now.
 ok('summarising adds no total on its own', (await p.locator('[data-m-agg]').count())===0);
 sql=await p.textContent('#genSql');
 ok('...so there is nothing to summarise yet', sql.includes('choose at least one total'), sql);
 await p.click('#btnAddMeasure'); await p.waitForTimeout(200);
 ok('"+ Add a total" adds exactly one', (await p.locator('[data-m-agg="0"]').count())===1);
 await p.selectOption('[data-m-col="0"]','units_sold'); await p.waitForTimeout(150);
 await p.click('[data-field="product_title"][data-field-kind="dim"]');
 await p.waitForTimeout(200);
 sql=await p.textContent('#genSql');
 ok('group by appears once a dimension is chosen', /group by 1/.test(sql), sql);
 ok('the total is aggregated', /sum\("units_sold"\)/.test(sql), sql);

 // chip bar reflects the same configuration
 ok('the chip bar shows the chosen row field', (await p.textContent('#chipBar')).includes('Product Title'));
 ok('...and the chosen total', (await p.textContent('#chipBar')).includes('Units Sold'));

 // filter
 await p.click('#btnAddFilter'); await p.waitForTimeout(200);
 await p.selectOption('[data-f-col="0"]','location_tag');
 await p.waitForTimeout(150);
 await p.fill('[data-f-val="0"]','online'); await p.waitForTimeout(200);
 sql=await p.textContent('#genSql');
 ok('a filter reaches the SQL, quoted', /"location_tag" = 'online'/.test(sql), sql);

 // preview
 await p.click('#btnPreview');
 await p.waitForFunction(()=>!/Running/.test(document.getElementById('previewBody').textContent),null,{timeout:10000});
 const meta=await p.textContent('#previewMeta');
 ok('preview runs and reports rows + timing: '+meta, /row/.test(meta));

 // ── the matview guard, which is the real safety story ──
 await p.click('.rb-src[data-rel="sales_velocity_by_sku_location_mv"]');
 await p.waitForSelector('#genSql', { state: 'attached' });
 ok('a matview shows the RLS warning', (await p.locator('.rb-warn').count())===1);
 sql=await p.textContent('#genSql');
 ok('and its SQL is force-scoped to the company',
    /"company_entity_id" = active_company_id\(\)/.test(sql), sql);

 // ── SQL tab ──
 await p.click('[data-tab="sql"]'); await p.waitForTimeout(200);
 ok('SQL tab shows the editor', await p.isVisible('#sqlText'));
 ok('the guided query carries across', (await p.inputValue('#sqlText')).includes('active_company_id'));
 await p.fill('#sqlText','select * from sales_velocity_by_sku_location_mv');
 await p.waitForTimeout(200);
 ok('raw SQL over a matview warns about cross-tenant rows',
    (await p.textContent('#sqlWarn')).toLowerCase().includes("every company's rows"));
 await p.fill('#sqlText','select sku from sales_velocity_by_sku_location_mv where company_entity_id = active_company_id()');
 await p.waitForTimeout(200);
 ok('...and stops warning once it is scoped', (await p.textContent('#sqlWarn')).trim()==='');

 // ── saving ──
 await p.fill('#sqlText','select product_title, net_sales, units from sales');
 await p.click('#btnPreview');
 await p.waitForFunction(()=>!/Running/.test(document.getElementById('previewBody').textContent),null,{timeout:10000});
 await p.click('#btnSave'); await p.waitForSelector('#saveBackdrop.open');
 await p.fill('#saveName','My manual report');
 await p.fill('#saveDesc','Built from a view');
 await p.click('#btnConfirmSave'); await p.waitForTimeout(400);
 const saved=await p.evaluate(()=>window.__FAKE_DB__.silo_chat_saved_reports.find(r=>r.title==='My manual report'));
 ok('saved a report row', !!saved);
 ok('...tagged source=manual', saved && saved.source==='manual');
 ok('...company-scoped, never global', saved && saved.company_entity_id!==null);
 ok('...with the SQL that was previewed', saved && saved.queries_run[0].includes('product_title'));
 ok('...and no chat question/answer', saved && saved.question===null && saved.answer===null);

 // ── the compact workbench: field browser, command search, chart toggle,
 //    rail collapse, friendly parameter control ──
 console.log('\n── compact workbench ──');
 await p.reload();
 await p.waitForSelector('.rb-src',{timeout:15000});
 await p.click('.rb-src[data-rel="sales_by_product_title_daily_v"]');
 await p.waitForSelector('#genSql', { state: 'attached' });

 // Field browser: a second, always-available way to add/remove a field.
 ok('the field browser lists this source\'s columns',
    (await p.locator('[data-field="net_sales"][data-field-kind="col"]').count())===1);
 await p.click('[data-field="net_sales"][data-field-kind="col"]');
 await p.waitForTimeout(150);
 let cols = await p.evaluate(()=>window.__siloReportBuilder.cfg.columns);
 ok('clicking a selected field row removes it', !cols.includes('net_sales'), JSON.stringify(cols));
 await p.click('[data-field="net_sales"][data-field-kind="col"]');
 await p.waitForTimeout(150);
 cols = await p.evaluate(()=>window.__siloReportBuilder.cfg.columns);
 ok('clicking it again re-adds it', cols.includes('net_sales'), JSON.stringify(cols));

 // Command search: deterministic, not AI -- every result is a concrete
 // action already reachable some other way.
 await p.click('label:has(#chkSummarise)'); await p.waitForTimeout(150);
 await p.fill('#cmdSearch','group by product title'); await p.waitForTimeout(150);
 const cmdText = await p.textContent('#cmdResults');
 ok('command search finds a matching field action', /Group by Product Title/.test(cmdText), cmdText);
 await p.click('.rb-cmd-result.is-active'); await p.waitForTimeout(150);
 let dims = await p.evaluate(()=>window.__siloReportBuilder.cfg.dimensions);
 ok('selecting a command result performs it', dims.includes('product_title'), JSON.stringify(dims));
 ok('...and clears the search box rather than leaving stale text', (await p.inputValue('#cmdSearch'))==='');

 // Chart above the table, offered only when the shape supports one.
 await p.click('#btnAddMeasure'); await p.waitForTimeout(150);
 await p.selectOption('[data-m-col="0"]','net_sales'); await p.waitForTimeout(150);
 await p.click('#btnPreview');
 await p.waitForFunction(()=>!/Running/.test(document.getElementById('previewBody').textContent),null,{timeout:10000});
 await p.waitForTimeout(300);
 ok('a chart/table toggle appears above a groupable result', await p.isVisible('#previewModeToggle'));
 ok('...and the chart itself is drawn', await p.isVisible('#previewChart'));
 ok('chart is the active segment by default', await p.locator('[data-preview-mode="chart"].is-active').count()===1);
 await p.click('[data-preview-mode="table"]'); await p.waitForTimeout(150);
 ok('the toggle switches to table-only', !(await p.isVisible('#previewChart')));
 ok('...and the table segment becomes active', await p.locator('[data-preview-mode="table"].is-active').count()===1);

 // Rail collapse -- a keyboard/touch-safe alternative to always showing it.
 const wasExpanded = await p.getAttribute('#btnToggleRail','aria-expanded');
 await p.click('#btnToggleRail'); await p.waitForTimeout(150);
 ok('collapsing the rail is reflected in aria-expanded',
    (await p.getAttribute('#btnToggleRail','aria-expanded'))!==wasExpanded);
 await p.click('#btnToggleRail'); await p.waitForTimeout(150);

 // Parameters: a date default gets a familiar control, not a bare text field.
 await p.click('#btnAddParam'); await p.waitForTimeout(150);
 ok('a fresh (date) parameter gets a friendly preset control',
    (await p.locator('[data-param-preset="0"]').count())===1);
 ok('...defaulting to Today, matching the underlying default', (await p.inputValue('[data-param-preset="0"]'))==='today');
 await p.selectOption('[data-param-preset="0"]','today-7d'); await p.waitForTimeout(150);
 const paramDefault = await p.evaluate(()=>window.__siloReportBuilder.cfg.parameters[0].default);
 ok('choosing a preset writes the same field the advanced editor shows', paramDefault==='today-7d');

 ok('no page errors', errs.length===0||(console.log(errs.slice(0,5)),false));
 // Debug artefact, opt-in: V3_TEST_SCREENSHOTS=1 writes it, otherwise the
 // suite leaves no files behind (and CI has nowhere to put them).
 if (process.env.V3_TEST_SCREENSHOTS) await p.screenshot({ path: 'report-builder.png' });
 await suite.close();
 console.log(`\n${pass}/${pass+fail} checks passed`); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
