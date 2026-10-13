import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { FN_DIR, slugOfPath, slugsFromLsFiles } from '../lib/function-drift-slugs.mjs';

let n = 0; const t = (name, fn) => { fn(); console.log(`ok ${++n} - ${name}`); };

t('a file inside a function directory belongs to that function', () => {
  assert.equal(slugOfPath('supabase/functions/silo-chat/index.ts'), 'silo-chat');
  assert.equal(slugOfPath('supabase/functions/shopify-sync-run/lib/shopify-sync-core.mjs'), 'shopify-sync-run');
});

t('a file directly under supabase/functions/ belongs to no function', () => {
  // The regression: CLAUDE.md read as a slug, so every run reported
  // "supabase/functions/CLAUDE.md exists on main but is not deployed".
  assert.equal(slugOfPath('supabase/functions/CLAUDE.md'), null);
  assert.equal(slugOfPath('supabase/functions'), null);
  assert.equal(slugOfPath(''), null);
  assert.equal(slugOfPath(null), null);
});

t('a path outside supabase/functions/ is never a slug', () => {
  assert.equal(slugOfPath('supabase/migrations/20261012210000_x.sql'), null);
  assert.equal(slugOfPath('scripts/lib/freshness-quiet.mjs'), null);
});

t('slugsFromLsFiles dedupes and drops the directory-level files', () => {
  assert.deepEqual([...slugsFromLsFiles([
    'supabase/functions/CLAUDE.md',
    'supabase/functions/silo-chat/index.ts',
    'supabase/functions/silo-chat/deno.json',
    'supabase/functions/notify-slack/index.ts',
    '',
  ].join('\n'))], ['silo-chat', 'notify-slack']);
  assert.deepEqual([...slugsFromLsFiles('')], []);
});

t('against this repo: every slug is a real directory, and CLAUDE.md is not one', () => {
  const slugs = slugsFromLsFiles(execFileSync('git', ['ls-files', '--', FN_DIR], { encoding: 'utf8' }));
  assert.ok(slugs.size > 20, `expected the repo's functions, got ${slugs.size}`);
  assert.ok(slugs.has('silo-chat'));
  // The file that caused this: still there, still not a function.
  const tracked = execFileSync('git', ['ls-files', '--', `${FN_DIR}/CLAUDE.md`], { encoding: 'utf8' }).trim();
  assert.equal(tracked, `${FN_DIR}/CLAUDE.md`, 'the directory rules file moved -- re-read this test');
  assert.equal(slugs.has('CLAUDE.md'), false);
  for (const slug of slugs) {
    const type = execFileSync('git', ['cat-file', '-t', `HEAD:${FN_DIR}/${slug}`], { encoding: 'utf8' }).trim();
    assert.equal(type, 'tree', `${slug} is not a directory`);
  }
});

console.log(`${n} function drift slug checks passed`);
