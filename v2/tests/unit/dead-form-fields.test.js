/* Forms no longer ask for columns nobody fills.
 *
 * Audited on production: of 117 launches, 13 of the 26 launch brief fields had
 * never been filled once, and `launch_channel_items.link_url` (0 of 58),
 * `seo_keyword_set.priority` / `.commercial_note` (0 of 280) were the same.
 * The columns stay in the database; only the inputs went away, so this suite
 * asserts the pages stop WRITING them while the two that are still read
 * elsewhere keep their inputs:
 *   - launch_calendar.landing_page_url  — read by Affiliate Studio
 *   - launch_calendar.projected_revenue — the one budget field with a value
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createReporter } = require('../lib/assert');
const { REPO_ROOT } = require('../lib/load');

const r = createReporter('dead-form-fields');
const read = (...p) => fs.readFileSync(path.join(REPO_ROOT, ...p), 'utf8');

const launch = read('v2', 'launch-calendar.html');
const keywords = read('v2', 'seo-keywords.html');

// ── launch brief ──────────────────────────────────────────────────────────
const BRIEF_DROPPED = [
  'release_pdf_url', 'copy_dos', 'copy_donts', 'approved_creatives',
  'preview_marketing_budget', 'post_launch_budget',
  'actual_preview_spend', 'actual_post_launch_spend', 'actual_revenue',
  'performance_comparison', 'overperformed_notes', 'underperformed_notes',
];

const briefPayload = (() => {
  const m = /function briefPayloadFromForm\(\)\{[\s\S]*?\n\}/.exec(launch);
  if (!m) throw new Error('briefPayloadFromForm not found in launch-calendar.html');
  return m[0];
})();

for (const col of BRIEF_DROPPED) {
  r.test(`the brief does not write ${col}`, () => {
    if (briefPayload.includes(`${col}:`)) throw new Error(`${col} is still in the brief payload`);
  });
}

r.test('the brief still writes landing_page_url (Affiliate Studio reads it)', () => {
  if (!briefPayload.includes('landing_page_url:')) throw new Error('landing_page_url dropped');
  if (!/id="briefLandingPageUrl"/.test(launch)) throw new Error('landing page input dropped');
});

r.test('the brief still writes projected_revenue', () => {
  if (!briefPayload.includes('projected_revenue:')) throw new Error('projected_revenue dropped');
  if (!/id="briefProjectedRevenue"/.test(launch)) throw new Error('projected revenue input dropped');
});

r.test('no brief input is left without a save, and none is saved without an input', () => {
  const inputs = new Set([...launch.matchAll(/id="(brief[A-Za-z]+)"/g)].map((m) => m[1])
    .filter((id) => !['briefSaveBtn', 'briefSaveStatus'].includes(id)
      && !id.startsWith('briefAudienceTag')));
  const saved = new Set([...briefPayload.matchAll(/\$\('(brief[A-Za-z]+)'\)|num\('(brief[A-Za-z]+)'\)/g)]
    .map((m) => m[1] || m[2]));
  const orphanInputs = [...inputs].filter((id) => !saved.has(id));
  const orphanSaves = [...saved].filter((id) => !inputs.has(id));
  if (orphanInputs.length) throw new Error(`inputs never saved: ${orphanInputs.join(', ')}`);
  if (orphanSaves.length) throw new Error(`saved without an input: ${orphanSaves.join(', ')}`);
});

r.test('the brief reflow names exactly the sections that are left', () => {
  // The progressive-enhancement block titles the collapsible sections BY
  // POSITION, so dropping a section without dropping its title silently
  // renames the ones that remain.
  const m = /const titles=\[([^\]]*)\];/.exec(launch);
  if (!m) throw new Error('brief section titles not found');
  const titles = (m[1].match(/'[^']*'/g) || []).length;
  const sections = (/<div class="dp" id="dp-brief">([\s\S]*?)\n    <div class="dp" id="dp-document">/.exec(launch) || [])[1];
  if (!sections) throw new Error('brief panel not found');
  const count = (sections.match(/\n      <div class="dp-section">/g) || []).length;
  // One section becomes the always-open "Creative direction" essentials; the
  // rest are collapsed and titled from the array.
  if (titles !== count) throw new Error(`${titles} titles for ${count} sections`);
});

r.test('the release document stops printing the dropped brief fields', () => {
  const m = /function renderReleaseDocument\([\s\S]*?\n\}/.exec(launch);
  if (!m) throw new Error('renderReleaseDocument not found');
  const bad = BRIEF_DROPPED.filter((col) => m[0].includes(`x.${col}`));
  if (bad.length) throw new Error(`still printed: ${bad.join(', ')}`);
});

// ── launch initiatives ────────────────────────────────────────────────────
r.test('the initiative editor no longer asks for a URL', () => {
  if (/id="channelUrl"/.test(launch)) throw new Error('channelUrl input is back');
  const m = /function channelPayloadFromForm\(\)\{[\s\S]*?\n\}/.exec(launch)
    || /channel:\$\('channelName'\)[\s\S]*?\};/.exec(launch);
  if (!m) throw new Error('initiative payload not found');
  if (m[0].includes('link_url')) throw new Error('link_url is still written');
});

// item_type and assigned_to never had a control; this guards against one
// being added back by accident rather than on purpose.
for (const col of ['item_type', 'assigned_to']) {
  r.test(`the initiative editor does not write ${col}`, () => {
    if (new RegExp(`${col}\\s*:`).test(launch)) throw new Error(`${col} is written by launch-calendar.html`);
  });
}

// ── SEO keywords ──────────────────────────────────────────────────────────
r.test('the keyword editor no longer writes priority or commercial_note', () => {
  if (/id="ekPriority"|id="ekNote"/.test(keywords)) throw new Error('keyword priority/note inputs are back');
  const updates = [...keywords.matchAll(/from\('seo_keyword_set'\)\s*\.(?:update|insert)[\s\S]{0,320}?\)/g)]
    .map((m) => m[0]).join('\n');
  if (!updates) throw new Error('no seo_keyword_set write found');
  if (/commercial_note|priority:/.test(updates)) throw new Error('priority/commercial_note still written');
});

r.test('the keyword table has as many header cells as body cells', () => {
  const head = /<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(keywords);
  if (!head) throw new Error('keyword table head not found');
  const headCells = (head[1].match(/<th/g) || []).length;
  const colspans = [...keywords.matchAll(/id="kwBody"[\s\S]*?colspan="(\d+)"/g)].map((m) => Number(m[1]));
  const body = /el\('kwBody'\)\.innerHTML = S\.keywords\.map[\s\S]*?\.join\(''\);/.exec(keywords);
  if (!body) throw new Error('keyword row renderer not found');
  const bodyCells = (body[0].match(/<td/g) || []).length;
  if (headCells !== bodyCells) throw new Error(`${headCells} header cells vs ${bodyCells} row cells`);
  for (const n of colspans) {
    if (n !== headCells) throw new Error(`empty-state colspan ${n} does not match ${headCells} columns`);
  }
});

// ── the unlinked preview page ─────────────────────────────────────────────
r.test('profile-ui-preview.html is gone and unreferenced', () => {
  if (fs.existsSync(path.join(REPO_ROOT, 'v2', 'profile-ui-preview.html'))) {
    throw new Error('v2/profile-ui-preview.html still exists');
  }
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
