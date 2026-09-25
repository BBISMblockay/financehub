/* Link and image cells.
 *
 * These are the only cells that put a database value into an HTML ATTRIBUTE
 * rather than a text node, so the safety cases matter more than the
 * rendering ones: a value that is not an http(s) URL must never reach an
 * href or a src. */
'use strict';
const { loadV3, PURE_MODULES } = require('../lib/load');
const { createReporter } = require('../lib/assert');

const g = loadV3(PURE_MODULES);
const C = g.SiloChart;
const F = g.SiloFieldSemantics;
const R = createReporter('link-image-cells');
const { test, eq, has, not, truthy } = R;

const rowsWith = (col, vals) => vals.map((v) => ({ name: 'x', [col]: v }));

// ── Profiling: decided by the values, not the name ────────────────────
console.log('\n── profiling ──');
test('a column of http(s) URLs profiles as url', () => {
  const prof = C.profileColumns(rowsWith('ad_link', [
    'https://adsmanager.facebook.com/adsmanager/manage/ads?act=1&selected_ad_ids=2',
    'http://example.com/a']));
  eq(prof.find((c) => c.name === 'ad_link').type, 'url');
});
test('an image-ish NAME of URLs profiles as image', () => {
  const prof = C.profileColumns(rowsWith('thumbnail_url', ['https://cdn.example.com/a', 'https://cdn.example.com/b']));
  eq(prof.find((c) => c.name === 'thumbnail_url').type, 'image');
});
test('"creative" counts as an image name', () => {
  const prof = C.profileColumns(rowsWith('creative', ['https://cdn.example.com/a']));
  eq(prof.find((c) => c.name === 'creative').type, 'image');
});
test('URLs ending in an image extension are images whatever the column is called', () => {
  const prof = C.profileColumns(rowsWith('asset', ['https://x.com/a.png', 'https://x.com/b.jpg?v=2']));
  eq(prof.find((c) => c.name === 'asset').type, 'image');
});
test('a column merely NAMED link is not a url', () => {
  const prof = C.profileColumns(rowsWith('link', ['see the deck', 'ask marketing']));
  eq(prof.find((c) => c.name === 'link').type, 'string');
});
test('MIXED urls and text is not a url column', () => {
  const prof = C.profileColumns(rowsWith('c', ['https://a.com/x', 'not a url']));
  eq(prof.find((c) => c.name === 'c').type, 'string');
});
test('ordinary text is untouched', () => {
  const prof = C.profileColumns(rowsWith('product_title', ['Bubbles and Doubles Tee']));
  eq(prof.find((c) => c.name === 'product_title').type, 'string');
});

// ── Semantics ─────────────────────────────────────────────────────────
console.log('\n── semantics ──');
test('url resolves to link', () => eq(F.resolve('ad_link', 'url', {}).semantic, 'link'));
test('image resolves to image', () => eq(F.resolve('creative', 'image', {}).semantic, 'image'));
test('a report can still override', () =>
  eq(F.resolve('creative', 'image', { reportMetadata: { creative: { semantic: 'category' } } }).semantic, 'category'));

// ── Rendering ─────────────────────────────────────────────────────────
console.log('\n── rendering ──');
test('a link cell renders an anchor that opens safely', () => {
  const html = C.tableHtml([{ ad_link: 'https://adsmanager.facebook.com/adsmanager/manage/ads?act=1' }], {}, null);
  has(html, 'href="https://adsmanager.facebook.com/adsmanager/manage/ads?act=1"');
  has(html, 'target="_blank"');
  has(html, 'rel="noopener noreferrer"');
});
test('an image cell renders a lazy img wrapped in a link', () => {
  const html = C.tableHtml([{ thumbnail_url: 'https://cdn.example.com/a.png' }], {}, null);
  has(html, '<img class="dw-thumb"');
  has(html, 'src="https://cdn.example.com/a.png"');
  has(html, 'loading="lazy"');
});
test('the link label is host + last path segment, full URL on title', () => {
  const long = 'https://adsmanager.facebook.com/adsmanager/manage/ads?act=51281951&selected_ad_ids=52607408061549';
  const html = C.tableHtml([{ ad_link: long }], {}, null);
  has(html, `title="${long.replace(/&/g, '&amp;')}"`);
  has(html, '>adsmanager.facebook.com/ads<');
  not(html, `>${long}<`);
});
test('a bare host with no path labels as the host', () =>
  has(C.tableHtml([{ ad_link: 'https://example.com/' }], {}, null), '>example.com<'));

// ── Safety: the part that matters ─────────────────────────────────────
console.log('\n── safety ──');
for (const [label, value] of [
  ['javascript:', 'javascript:alert(document.cookie)'],
  ['data: html', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
  ['vbscript:', 'vbscript:msgbox(1)'],
  ['file:', 'file:///etc/passwd'],
  ['protocol-relative', '//evil.example.com/steal'],
  ['whitespace-smuggled', 'https://ok.com/a javascript:alert(1)'],
]) {
  test(`${label} never becomes an href`, () => {
    // Force the semantic on, so this tests the RENDER guard rather than
    // relying on the profiler having refused the column.
    const html = C.tableHtml([{ c: value }], {}, { c: 'link' });
    not(html, 'href=');
    not(html, '<a ');
  });
  test(`${label} never becomes an img src`, () => {
    const html = C.tableHtml([{ c: value }], {}, { c: 'image' });
    not(html, 'src=');
    not(html, '<img');
  });
}

test('a refused value still renders as escaped TEXT, not dropped', () => {
  const html = C.tableHtml([{ c: 'javascript:alert(1)' }], {}, { c: 'link' });
  has(html, 'javascript:alert(1)');   // visible to the reader
  not(html, 'href=');                 // but inert
});

test('a URL carrying quotes cannot break out of the attribute', () => {
  // Not a valid http URL (the guard rejects the quote), so it must render
  // as text -- and the quote must still be entity-escaped.
  const html = C.tableHtml([{ c: 'https://x.com/a"onload="alert(1)' }], {}, { c: 'link' });
  not(html, 'onload="alert(1)"');
  not(html, 'href=');
});

test('markup in an ordinary cell is still escaped', () => {
  const html = C.tableHtml([{ c: '<script>alert(1)</script>' }], {}, null);
  not(html, '<script>');
  has(html, '&lt;script&gt;');
});

// ── Missing images and fallbacks ──────────────────────────────────────
console.log('\n── image fallbacks ──');
test('a null image draws a placeholder the size of a thumbnail, not an empty cell', () => {
  const html = C.tableHtml([{ image: null, sku: 'A' }, { image: 'https://cdn.example.com/a.png', sku: 'B' }], {}, { image: 'image' });
  has(html, 'dw-thumb--none');
  has(html, 'aria-label="No image available"');
  has(html, 'src="https://cdn.example.com/a.png"');
});
test('a refused image URL draws the placeholder too, never the URL', () => {
  const html = C.tableHtml([{ image: 'javascript:alert(1)' }], {}, { image: 'image' });
  has(html, 'dw-thumb--none');
  not(html, 'javascript:');
});
test('the placeholder the renderer swaps in on a load error is the same markup', () => {
  has(C.tableHtml([{ image: null }], {}, { image: 'image' }), C.imagePlaceholderHtml());
});
test('a thumbnail can open a bigger preview named by the report', () => {
  const html = C.tableHtml([{ thumbnail: 'https://scontent.example.com/t.jpg', ad_preview: 'https://fb.me/abc' }], {},
    { thumbnail: 'image', ad_preview: 'link' }, { imageLinks: { thumbnail: 'ad_preview' } });
  has(html, 'href="https://fb.me/abc"');
  has(html, 'title="Open the full preview"');
  has(html, 'src="https://scontent.example.com/t.jpg"');
});
test('with no preview on the row, the thumbnail links to itself', () => {
  const html = C.tableHtml([{ thumbnail: 'https://scontent.example.com/t.jpg', ad_preview: null }], {},
    { thumbnail: 'image', ad_preview: 'link' }, { imageLinks: { thumbnail: 'ad_preview' } });
  has(html, 'href="https://scontent.example.com/t.jpg"');
});
test('a hostile preview link is never the href', () => {
  const html = C.tableHtml([{ thumbnail: 'https://scontent.example.com/t.jpg', ad_preview: 'javascript:alert(1)' }], {},
    { thumbnail: 'image' }, { imageLinks: { thumbnail: 'ad_preview' } });
  not(html, 'href="javascript');
});
test('a report label names the column header', () => {
  const html = C.tableHtml([{ platform_credited_revenue: 10 }], {}, { platform_credited_revenue: 'currency' },
    { labels: { platform_credited_revenue: 'Revenue Credited by Platform' } });
  has(html, '>Revenue Credited by Platform<');
});

test('an id the report declares a category renders as the id, not a number', () => {
  const html = C.tableHtml([{ ad_id: '120238471650190610', spend: 5 }, { ad_id: '120238471650190611', spend: 6 }], {},
    { ad_id: 'category', spend: 'currency' });
  has(html, '>120238471650190610<');
  not(html, '120,238');
});

// ── Not a measure, not a dimension ────────────────────────────────────
console.log('\n── chart pickers ──');
test('a url column is never offered as a dimension or measure', () => {
  const rows = [{ ad_name: 'A', ad_link: 'https://x.com/1', spend: 10 },
                { ad_name: 'B', ad_link: 'https://x.com/2', spend: 20 }];
  const rec = C.recommend(rows, null);
  truthy(rec.visual_config.x_field !== 'ad_link', 'url must not be the dimension');
  truthy(rec.visual_config.y_field !== 'ad_link', 'url must not be the measure');
});
test('an image column is never the dimension either', () => {
  const rows = [{ creative: 'https://x.com/a.png', ad_name: 'A', spend: 10 },
                { creative: 'https://x.com/b.png', ad_name: 'B', spend: 20 }];
  const rec = C.recommend(rows, null);
  truthy(rec.visual_config.x_field !== 'creative', 'image must not be the dimension');
});

const r = R.summary();
process.exit(r.fail ? 1 : 0);
