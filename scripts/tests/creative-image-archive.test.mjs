/* creative-image-archive.mjs -- keeping a copy of each Meta ad's image.
 *
 * Proven here, with a fake Graph API, a fake image CDN and a fake Supabase:
 *   1. A stored image lands at <company>/<sha256>.<ext> with the type read from
 *      the file's own bytes, and the row gets every image column at once.
 *   2. The row update is conditioned on the creative the image was fetched
 *      FOR: an ad edited mid-run is left unarchived, never mislabelled.
 *   3. A failure writes ONLY image_attempted_at / image_error, and the access
 *      token never reaches that stored message.
 *   4. Only https URLs on Meta's CDN are downloaded; a file that is not an
 *      image is refused whatever its Content-Type says.
 *   6. A connection's token is used only for its OWN ad account: another
 *      account's ad is not asked, and so cannot be put into backoff; an ad
 *      with no account id only when the company has one Meta connection.
 *   5. Already archived -> not asked; failed recently -> backs off; the limit
 *      holds; two ads sharing an image share one object.
 *
 * Mutations (each must make this file FAIL):
 *   ARCHIVE_MUTATION=no-creative-guard  (row update not conditioned on creative_id)
 *   ARCHIVE_MUTATION=trust-header       (type taken from Content-Type, not the bytes)
 *   ARCHIVE_MUTATION=token-in-error     (the scrub is removed)
 *   ARCHIVE_MUTATION=no-backoff         (a recent failure is retried immediately)
 *   ARCHIVE_MUTATION=any-host           (the CDN allowlist is removed)
 *   ARCHIVE_MUTATION=any-account        (another account's ads are asked with this token)
 *
 * No network, no database. Run: node scripts/tests/creative-image-archive.test.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mutation = process.env.ARCHIVE_MUTATION || '';
assert.ok(['', 'no-creative-guard', 'trust-header', 'token-in-error', 'no-backoff', 'any-host', 'any-account'].includes(mutation),
  `Unknown mutation ${mutation}`);
let src = readFileSync(join(ROOT, 'scripts/lib/creative-image-archive.mjs'), 'utf8');
const swap = (from, to) => { assert.ok(src.includes(from), `mutation anchor missing: ${from}`); src = src.replace(from, to); };
if (mutation === 'no-creative-guard') swap("        .eq('creative_id', r.creative_id)\n", '');
if (mutation === 'trust-header') swap('const kind = sniffImage(buf);',
  "const ct = res.headers?.get?.('content-type') || 'image/jpeg'; const kind = { ext: ct.includes('png') ? 'png' : 'jpg', type: ct, w: null, h: null };");
if (mutation === 'token-in-error') {
  // Both halves of the scrub go: the parameter pattern and the bare-token one.
  swap(".replace(/access_token=[^&\\s\"']+/gi, 'access_token=[redacted]')", '');
  swap(".replace(/(EAA[A-Za-z0-9]{20,})/g, '[redacted]')", '');
}
if (mutation === 'no-backoff') swap('now - Date.parse(row.image_attempted_at) < retryAfterHours * 3600_000', 'false');
if (mutation === 'any-host') swap('if (!ALLOWED_HOST.test(host))', 'if (false)');
if (mutation === 'any-account') swap('if (!ownedByConnection(r, connection, { soleConnection }))', 'if (false)');
const dir = mkdtempSync(join(tmpdir(), 'img-archive-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'archive.mjs');
writeFileSync(file, src);
const A = await import(pathToFileURL(file).href);

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`not ok - ${name}`); throw e; }
};

// ── Fixtures ────────────────────────────────────────────────────────────────
const CO = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7';
const TOKEN = 'EAAtesttokenABCDEFGHIJKLMNOPQRSTUVWXYZ';
function jpeg(w, h, seed = 0) {
  // SOI, APP0 (len 16), SOF0 carrying height/width, then filler and EOI.
  const b = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0),
    0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, ...Array(9).fill(seed), 0xff, 0xd9];
  return new Uint8Array(b);
}
function png(w, h) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
}
const sha = (b) => createHash('sha256').update(b).digest('hex');

function fakeSupabase(rows, { failUpload = false, changeCreativeFor = null } = {}) {
  const state = { rows: rows.map((r) => ({ ...r })), uploads: [], updates: [] };
  const sb = {
    state,
    storage: {
      from(bucket) {
        return {
          async upload(path, body, opts) {
            if (failUpload) return { error: { message: 'Bucket not found' } };
            state.uploads.push({ bucket, path, bytes: body.length, opts });
            return { data: { path }, error: null };
          },
        };
      },
    },
    from(table) {
      assert.equal(table, 'meta_ad_creatives');
      const q = { filters: [], patch: null, sel: false };
      const run = () => {
        let rs = state.rows.filter((r) => q.filters.every(([op, c, v]) => (op === 'in' ? v.map(String).includes(String(r[c])) : String(r[c]) === String(v))));
        if (q.patch) {
          if (changeCreativeFor) { // the ad was edited between the read and the write
            const r = state.rows.find((x) => x.ad_id === changeCreativeFor);
            if (r) r.creative_id = 'edited';
            rs = state.rows.filter((r) => q.filters.every(([op, c, v]) => String(r[c]) === String(v)));
          }
          state.updates.push({ patch: q.patch, filters: q.filters.slice(), matched: rs.map((r) => r.ad_id) });
          for (const r of rs) Object.assign(r, q.patch);
        }
        return { data: rs.map((r) => ({ ...r })), error: null };
      };
      Object.assign(q, {
        select() { q.sel = true; return q; },
        update(p) { q.patch = p; return q; },
        eq(c, v) { q.filters.push(['eq', c, v]); return q; },
        in(c, v) { q.filters.push(['in', c, v]); return q; },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      });
      return q;
    },
  };
  return sb;
}
function deps(images, { graph = {} } = {}) {
  const asked = [], downloaded = [];
  return {
    asked, downloaded,
    apiVersion: 'v25.0',
    graphGet: async (url) => {
      const id = decodeURIComponent(url.split('/v25.0/')[1].split('?')[0]);
      asked.push(id);
      assert.match(url, /thumbnail_width=1080&thumbnail_height=1080/);
      if (graph[id] instanceof Error) throw graph[id];
      return { thumbnail_url: graph[id] ?? `https://scontent.xx.fbcdn.net/${id}.jpg?oe=6ABE26B1` };
    },
    fetchImpl: async (url) => {
      downloaded.push(url);
      const id = url.split('/').pop().split('.')[0];
      const body = images[id];
      if (!body) return { ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0), headers: new Map() };
      return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        headers: { get: () => 'image/png' } };
    },
  };
}
const conn = { company_entity_id: CO, access_token: TOKEN, meta_ad_account_id: 'act_51281951' };
const row = (ad, cr, extra = {}) => ({ company_entity_id: CO, ad_id: ad, account_id: 'act_51281951', creative_id: cr, image_path: null,
  image_creative_id: null, image_attempted_at: null, image_error: null, ...extra });

// ── Tests ───────────────────────────────────────────────────────────────────
await test('sniffImage reads type and pixel size from the bytes', () => {
  assert.deepEqual(A.sniffImage(jpeg(1080, 1350)), { ext: 'jpg', type: 'image/jpeg', w: 1080, h: 1350 });
  assert.deepEqual(A.sniffImage(png(627, 627)), { ext: 'png', type: 'image/png', w: 627, h: 627 });
  assert.equal(A.sniffImage(new TextEncoder().encode('<html>nope</html>')), null);
});

await test('an image is stored content-addressed and the row gets every image column at once', async () => {
  const img = jpeg(1080, 1080, 1);
  const sb = fakeSupabase([row('A', 'crA')]);
  const d = deps({ crA: img });
  const r = await A.archiveCreativeImages(sb, conn, { adIds: ['A'], ...d });
  assert.equal(r.archived, 1);
  const path = `${CO}/${sha(img)}.jpg`;
  assert.deepEqual(sb.state.uploads.map((u) => [u.bucket, u.path, u.opts.contentType]), [['ad-creative-images', path, 'image/jpeg']]);
  const got = sb.state.rows[0];
  assert.equal(got.image_path, path);
  assert.equal(got.image_sha256, sha(img));
  assert.equal(got.image_width, 1080);
  assert.equal(got.image_creative_id, 'crA');
  assert.ok(got.image_archived_at && got.image_attempted_at);
  assert.equal(got.image_error, null);
});

await test('the update is conditioned on the creative it was fetched for', async () => {
  const sb = fakeSupabase([row('A', 'crA')], { changeCreativeFor: 'A' });
  const r = await A.archiveCreativeImages(sb, conn, { adIds: ['A'], ...deps({ crA: jpeg(10, 10) }) });
  assert.equal(r.archived, 0, 'the ad now runs another creative');
  assert.equal(sb.state.rows[0].image_path, null, 'and is not labelled with the old creative\'s image');
});

await test('a failure writes only attempted/error, and the token never reaches the stored message', async () => {
  const leak = new Error(`Meta creative crB image → 400: {"error":"bad"} https://graph.facebook.com/v25.0/crB?access_token=${TOKEN}`);
  const sb = fakeSupabase([row('B', 'crB', { image_path: null })]);
  const r = await A.archiveCreativeImages(sb, conn, { adIds: ['B'], ...deps({}, { graph: { crB: leak } }) });
  assert.equal(r.failed, 1);
  const upd = sb.state.updates.at(-1).patch;
  assert.deepEqual(Object.keys(upd).sort(), ['image_attempted_at', 'image_error']);
  assert.ok(!upd.image_error.includes(TOKEN), 'token scrubbed');
  assert.ok(!JSON.stringify(r.errors).includes(TOKEN), 'and from the run result');
});

await test('only https URLs on Meta\'s CDN are downloaded', async () => {
  const sb = fakeSupabase([row('C', 'crC'), row('D', 'crD')]);
  const d = deps({ crC: jpeg(5, 5), crD: jpeg(5, 5) }, { graph: {
    crC: 'https://evil.example.com/crC.jpg', crD: 'http://scontent.xx.fbcdn.net/crD.jpg' } });
  const r = await A.archiveCreativeImages(sb, conn, { adIds: ['C', 'D'], ...d });
  assert.equal(r.failed, 2);
  assert.equal(d.downloaded.length, 0, 'nothing off Meta\'s CDN, nothing over http');
});

await test('a file that is not an image is refused whatever its Content-Type says', async () => {
  const sb = fakeSupabase([row('E', 'crE')]);
  const r = await A.archiveCreativeImages(sb, conn, { adIds: ['E'], ...deps({ crE: new TextEncoder().encode('<html>login</html>') }) });
  assert.equal(r.failed, 1);
  assert.equal(sb.state.uploads.length, 0);
  assert.match(sb.state.rows[0].image_error, /not a JPEG/);
});

await test('already archived is not asked; a recent failure backs off; an old one is retried', async () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const sb = fakeSupabase([
    row('F', 'crF', { image_path: `${CO}/${'f'.repeat(64)}.jpg`, image_creative_id: 'crF' }),
    row('G', 'crG', { image_error: 'boom', image_attempted_at: '2026-09-27T06:00:00Z' }),
    row('H', 'crH', { image_error: 'boom', image_attempted_at: '2026-09-25T06:00:00Z' }),
    row('I', 'crI2', { image_path: `${CO}/${'e'.repeat(64)}.jpg`, image_creative_id: 'crI1' }),
  ]);
  const d = deps({ crH: jpeg(9, 9), crI2: jpeg(8, 8) });
  const r = await A.archiveCreativeImages(sb, conn, { adIds: ['F', 'G', 'H', 'I'], now, ...d });
  assert.deepEqual(d.asked.sort(), ['crH', 'crI2'], 'F is current, G failed six hours ago; I was edited so its image is stale');
  assert.equal(r.already, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.archived, 2);
});

await test('the limit holds and two ads sharing an image share one object', async () => {
  const same = png(627, 627);
  const sb = fakeSupabase([row('J', 'crJ'), row('K', 'crK'), row('L', 'crL')]);
  const d = deps({ crJ: same, crK: same, crL: same });
  const r = await A.archiveCreativeImages(sb, conn, { adIds: ['J', 'K', 'L'], limit: 2, ...d });
  assert.equal(r.asked, 2);
  assert.equal(r.skipped, 1, 'the third waits for the next run');
  const paths = new Set(sb.state.rows.filter((x) => x.image_path).map((x) => x.image_path));
  assert.equal(paths.size, 1, 'one template, one object');
});

await test('a storage failure is a recorded failure, not an exception', async () => {
  const sb = fakeSupabase([row('M', 'crM')], { failUpload: true });
  const r = await A.archiveCreativeImages(sb, conn, { adIds: ['M'], ...deps({ crM: jpeg(3, 3) }) });
  assert.equal(r.failed, 1);
  assert.match(sb.state.rows[0].image_error, /Bucket not found/);
  assert.equal(sb.state.rows[0].image_path, null);
});

await test('only the connection\'s own ad account is asked; another account\'s ad is untouched', async () => {
  const sb = fakeSupabase([row('P', 'crP'), row('Q', 'crQ', { account_id: '999' }), row('R', 'crR', { account_id: null })]);
  const d = deps({ crP: jpeg(4, 4), crQ: jpeg(4, 4), crR: jpeg(4, 4) });
  const r = await A.archiveCreativeImages(sb, conn, { adIds: ['P', 'Q', 'R'], ...d });
  assert.deepEqual(d.asked, ['crP'], 'act_ and bare ids compare equal; no account id is not claimed by default');
  assert.equal(r.other_account, 2);
  const q = sb.state.rows.find((x) => x.ad_id === 'Q');
  assert.equal(q.image_attempted_at, null, 'and is not put into backoff for the connection that can read it');
  assert.equal(q.image_error, null);
});

await test('an ad with no account id is claimed only by a company\'s sole Meta connection', async () => {
  assert.equal(A.ownedByConnection({ account_id: null }, conn, { soleConnection: true }), true);
  assert.equal(A.ownedByConnection({ account_id: null }, conn, { soleConnection: false }), false);
  assert.equal(A.ownedByConnection({ account_id: '51281951' }, conn), true);
  assert.equal(A.ownedByConnection({ account_id: 'act_1' }, { meta_ad_account_id: null }), false, 'a connection with no account claims nothing named');
});

await test('no token or no Graph client: disabled, nothing asked', async () => {
  const r = await A.archiveCreativeImages(fakeSupabase([row('N', 'crN')]), { company_entity_id: CO }, { adIds: ['N'], apiVersion: 'v25.0', graphGet: async () => ({}) });
  assert.equal(r.disabled, true);
});

console.log(`\n${passed} passed`);
