/* What GitHub Pages publishes from this repo, proved by running the real build.
 *
 * `_config.yml` excludes every directory that is not the app itself (data,
 * server, scripts, supabase, docs, tests, testing, config). The Meta App Review
 * reviewer page lives in testing/, so it is published back out by an `include`
 * allowlist -- and an allowlist is only worth anything if the things it does NOT
 * name stay out, so this test builds the site with Jekyll and looks at the
 * artifact:
 *
 *   1. the three review assets are there, byte for byte;
 *   2. every path the page loads resolves inside the artifact;
 *   3. the excluded directories and files are absent and the app is present;
 *   4. a file dropped into testing/, a subdirectory of testing/, and a file
 *      with an allowlisted BASENAME in another excluded directory all stay
 *      unpublished (the probes in step 4 are written into the worktree, built,
 *      and removed again).
 *
 * Needs Jekyll on PATH (or $JEKYLL_BIN): GitHub Pages builds with Jekyll 3.10,
 * and "Publication tests" installs the same version. There is no skip path --
 * a build this test cannot run is a claim it cannot make.
 *
 * Plain Jekyll, not the `github-pages` gem, on purpose: the gem's build calls
 * the GitHub API for site metadata and fails without network and credentials,
 * and the part that decides publication is the same code either way --
 * `include` and `exclude` appear in neither GitHubPages::Configuration's
 * OVERRIDES nor its DEFAULTS (github-pages 232), so the repo's lists reach
 * Jekyll's own EntryFilter unchanged.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const REVIEW_ASSETS = ['testing/meta-oauth.html', 'testing/meta-oauth.js', 'testing/meta-oauth-client.js'];
// Excluded by _config.yml. A directory here must not appear in the artifact at all.
const MUST_BE_ABSENT = [
  'data', 'server', 'scripts', 'supabase', 'docs', 'tests', 'config',
  'config.json', 'package.json', 'package-lock.json', 'deno.lock', 'CLAUDE.md',
];
// The app itself, so a build that published nothing cannot pass this file.
const MUST_BE_PRESENT = [
  'index.html', 'CNAME', 'demo.html', 'v2/projections.html', 'v2/nav-config.js',
  'v3', 'pages/config.js', 'assets', 'legal', 'oauth', 'legacy',
];

let n = 0; const t = (name, fn) => { fn(); console.log(`ok ${++n} - ${name}`); };

function jekyllBin() {
  const candidates = [process.env.JEKYLL_BIN, 'jekyll'].filter(Boolean);
  try {
    const dir = /EXECUTABLE DIRECTORY: (.+)/.exec(execFileSync('gem', ['environment'], { encoding: 'utf8' }))?.[1];
    if (dir) candidates.push(path.join(dir.trim(), 'jekyll'));
  } catch { /* no gem on PATH; the candidates above may still work */ }
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch { /* try the next one */ }
  }
  assert.fail('Jekyll is not available: install it (gem install jekyll -v 3.10.0) or set $JEKYLL_BIN. This test must not be skipped.');
}

const BIN = jekyllBin();

/** Build the repo as GitHub Pages does and return the artifact directory. */
function build(label) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `silo-pages-${label}-`));
  execFileSync(BIN, ['build', '--safe', '-s', REPO, '-d', out], { encoding: 'utf8', stdio: 'pipe' });
  return out;
}

const site = build('main');

t('the three Meta review assets are published, byte for byte', () => {
  for (const rel of REVIEW_ASSETS) {
    const built = path.join(site, rel);
    assert.ok(fs.existsSync(built), `${rel} is missing from the published artifact`);
    assert.deepEqual(
      fs.readFileSync(built),
      fs.readFileSync(path.join(REPO, rel)),
      `${rel} was rewritten by the build; the reviewer page must be served verbatim`,
    );
  }
});

t('every path the reviewer page loads resolves inside the artifact', () => {
  const html = fs.readFileSync(path.join(site, 'testing/meta-oauth.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const local = refs.filter((r) => !/^(?:https?:)?\/\//.test(r));
  // Both kinds exist on the page today: the Supabase SDK from a CDN, and local
  // CSS/JS. If the markup stops matching, this test is reading nothing.
  assert.ok(refs.length >= 5, `expected the page's asset references, found ${refs.length}`);
  assert.ok(local.length >= 5, `expected the page's local assets, found ${local.length}`);
  for (const ref of local) {
    const resolved = path.join(site, 'testing', ref.split(/[?#]/)[0]);
    assert.ok(fs.existsSync(resolved), `${ref} is referenced by meta-oauth.html but is not published`);
  }
  for (const expected of ['../v2/beacon.css', '../v2/silo-brand.css', '../pages/config.js', 'meta-oauth-client.js', 'meta-oauth.js']) {
    assert.ok(local.includes(expected), `${expected} is no longer loaded by the page -- re-read this test`);
  }
});

t('the excluded directories and files stay out, and the app stays in', () => {
  for (const rel of MUST_BE_ABSENT) {
    assert.equal(fs.existsSync(path.join(site, rel)), false, `${rel} is PUBLIC in the artifact`);
  }
  for (const rel of MUST_BE_PRESENT) {
    assert.ok(fs.existsSync(path.join(site, rel)), `${rel} is missing from the artifact -- the app would 404`);
  }
  // Nothing else from testing/ rode along with the three assets.
  assert.deepEqual(
    fs.readdirSync(path.join(site, 'testing')).sort(),
    ['meta-oauth-client.js', 'meta-oauth.html', 'meta-oauth.js'],
  );
});

t('a new file in testing/, a subdirectory of it, and an allowlisted basename elsewhere are all unpublished', () => {
  const probes = [
    'testing/pages-allowlist-probe.js',            // a new file beside the review assets
    'testing/nested-probe/meta-oauth.js',          // allowlisted basename, but testing/ has no included subdirectory
    'docs/meta-oauth.js',                          // allowlisted basename inside another excluded directory
  ];
  const created = [];
  try {
    for (const rel of probes) {
      const abs = path.join(REPO, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '/* publication probe */\n');
      created.push(rel);
      assert.ok(fs.existsSync(abs), `probe ${rel} was not written, so this test would prove nothing`);
    }
    const probed = build('probe');
    // Control: the same build still publishes the allowlist, so an empty
    // artifact cannot be what makes the assertions below pass.
    for (const rel of REVIEW_ASSETS) {
      assert.ok(fs.existsSync(path.join(probed, rel)), `${rel} is missing from the probe build`);
    }
    for (const rel of probes) {
      assert.equal(fs.existsSync(path.join(probed, rel)), false, `${rel} was published; the allowlist is not narrow`);
    }
    assert.equal(fs.existsSync(path.join(probed, 'testing/nested-probe')), false, 'testing/nested-probe/ was published');
    fs.rmSync(probed, { recursive: true, force: true });
  } finally {
    for (const rel of created) fs.rmSync(path.join(REPO, rel), { force: true });
    fs.rmSync(path.join(REPO, 'testing/nested-probe'), { recursive: true, force: true });
    fs.rmSync(path.join(REPO, 'docs/meta-oauth.js'), { force: true });
  }
});

t('the include allowlist names only the review assets, and un-excludes no other directory', () => {
  const cfg = fs.readFileSync(path.join(REPO, '_config.yml'), 'utf8');
  const section = /^include:\n((?:\s*-\s.*\n?)+)/m.exec(cfg);
  assert.ok(section, '_config.yml has no include: list -- the review assets would 404');
  const entries = [...section[1].matchAll(/^\s*-\s*([^\s#]+)/gm)].map((m) => m[1]);
  assert.deepEqual(entries.sort(), ['meta-oauth-client.js', 'meta-oauth.html', 'meta-oauth.js', 'testing']);
  const excluded = [...(/^exclude:\n((?:\s*-\s.*\n?)+)/m.exec(cfg)?.[1] ?? '').matchAll(/^\s*-\s*([^\s#]+)/gm)].map((m) => m[1]);
  assert.ok(excluded.includes('testing'), 'testing/ is no longer excluded, so every file in it is public');
  for (const dir of MUST_BE_ABSENT) {
    assert.equal(entries.includes(dir), false, `include: names ${dir}, which exclude: is meant to keep private`);
  }
});

fs.rmSync(site, { recursive: true, force: true });
console.log(`\n# ${n} publication checks passed`);
