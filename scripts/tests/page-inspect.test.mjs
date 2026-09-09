/* page-inspect admission + extraction.
 *
 * The admission half is a security boundary: this function makes outbound
 * requests from our infrastructure, so the allowlist is the only thing
 * standing between "inspect our storefront" and "fetch anything the edge
 * runtime can reach". An allowlist nothing exercises is how a bypass ships,
 * so the known bypass shapes are asserted here by name.
 *
 * No network, no database, no install. Run:
 *   node scripts/tests/page-inspect.test.mjs
 */
import {
  admitUrl, admitRedirect, isHostAllowed, normalizeHost, extractPageFacts, decodeEntities,
} from '../../supabase/functions/page-inspect/inspect-lib.mjs';
import { buildShopDomainRows, normalizeShopHost } from '../lib/shopify-sync-core.mjs';

let failures = 0;
let count = 0;
function test(name, fn) {
  count++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(cond, what) { if (!cond) throw new Error(what); }
const deepEq = (a, b, what) => eq(JSON.stringify(a), JSON.stringify(b), what);

const ALLOWED = new Set(['www.baseballism.com', 'baseballism.myshopify.com']);
const rejected = (raw) => {
  const r = admitUrl(raw, ALLOWED);
  ok(r.error, `expected rejection for ${raw}, got ${JSON.stringify(r)}`);
  return r.error;
};

console.log('\n-- what gets in --');

test('an allowlisted https storefront URL is admitted', () => {
  const r = admitUrl('https://www.baseballism.com/collections/tees', ALLOWED);
  eq(r.error, undefined, 'no error');
  eq(r.host, 'www.baseballism.com', 'host');
});

test('the myshopify domain is admitted too', () => {
  eq(admitUrl('https://baseballism.myshopify.com/', ALLOWED).host, 'baseballism.myshopify.com', 'host');
});

test('host matching is case- and trailing-dot-insensitive', () => {
  eq(admitUrl('https://WWW.Baseballism.COM./x', ALLOWED).host, 'www.baseballism.com', 'normalised');
});

console.log('\n-- the classic allowlist bypasses --');

// endsWith('baseballism.com') would admit both of these.
test('a prefixed lookalike host is REJECTED (suffix matching would admit it)', () => {
  ok(rejected('https://evil-baseballism.com/').startsWith('host_not_allowed'), 'rejected as host');
});
test('a suffixed lookalike host is REJECTED', () => {
  ok(rejected('https://www.baseballism.com.attacker.net/').startsWith('host_not_allowed'), 'rejected as host');
});
test('a subdomain of an allowed host is REJECTED — allowlisting is exact', () => {
  ok(rejected('https://internal.www.baseballism.com/').startsWith('host_not_allowed'), 'rejected as host');
});

console.log('\n-- SSRF targets are excluded structurally, not filtered --');

// None of these is string-equal to a storefront domain, so no IP-range
// denylist is needed to keep them out.
for (const [label, url] of [
  ['dotted IPv4 loopback', 'http://127.0.0.1/'],
  ['link-local metadata', 'http://169.254.169.254/latest/meta-data/'],
  ['private range', 'http://10.0.0.1/'],
  ['decimal IPv4', 'http://2130706433/'],
  ['octal IPv4', 'http://0177.0.0.1/'],
  ['IPv6 loopback', 'http://[::1]/'],
  ['IPv4-mapped IPv6', 'http://[::ffff:127.0.0.1]/'],
  ['localhost by name', 'http://localhost:8000/'],
]) {
  test(`${label} is rejected`, () => {
    ok(rejected(url).startsWith('host_not_allowed'), 'rejected as a disallowed host');
  });
}

console.log('\n-- schemes and credentials --');

for (const [label, url, expected] of [
  ['javascript:', 'javascript:alert(1)', 'scheme_not_allowed'],
  ['data:', 'data:text/html,<h1>x</h1>', 'scheme_not_allowed'],
  ['file:', 'file:///etc/passwd', 'scheme_not_allowed'],
  ['ftp:', 'ftp://www.baseballism.com/', 'scheme_not_allowed'],
]) {
  test(`${label} is rejected before any host check`, () => {
    ok(rejected(url).startsWith(expected), `rejected as ${expected}`);
  });
}

test('userinfo in the URL is rejected even on an allowed host', () => {
  eq(rejected('https://attacker@www.baseballism.com/'), 'credentials_in_url', 'reason');
});

test('empty and unparseable input is rejected, never thrown', () => {
  eq(admitUrl('', ALLOWED).error, 'no_url', 'empty');
  eq(admitUrl(null, ALLOWED).error, 'no_url', 'null');
  eq(admitUrl('not a url', ALLOWED).error, 'unparseable_url', 'garbage');
});

test('an empty allowlist admits nothing', () => {
  ok(admitUrl('https://www.baseballism.com/', new Set()).error, 'nothing is allowed');
});

console.log('\n-- redirects get the SAME check, which is the whole point --');

test('a redirect to a disallowed host is rejected', () => {
  const r = admitRedirect('http://169.254.169.254/', 'https://www.baseballism.com/a', ALLOWED);
  ok(String(r.error).startsWith('host_not_allowed'), 'rejected');
});

test('a relative redirect resolves against the current URL and stays allowed', () => {
  const r = admitRedirect('/collections/new', 'https://www.baseballism.com/a/b', ALLOWED);
  eq(r.error, undefined, 'admitted');
  eq(r.url, 'https://www.baseballism.com/collections/new', 'resolved absolute');
});

test('a protocol-relative redirect to another host is rejected', () => {
  const r = admitRedirect('//attacker.net/x', 'https://www.baseballism.com/a', ALLOWED);
  ok(String(r.error).startsWith('host_not_allowed'), 'rejected');
});

test('a redirect with no Location is an error, not a silent pass', () => {
  eq(admitRedirect(null, 'https://www.baseballism.com/', ALLOWED).error, 'redirect_without_location', 'reason');
});

console.log('\n-- normalizeHost / isHostAllowed --');

test('normalizeHost strips port, userinfo and root dot', () => {
  eq(normalizeHost('User:Pass@WWW.Example.COM:8443.'), 'www.example.com', 'normalised');
  eq(normalizeHost('[::1]:9000'), '[::1]', 'ipv6 keeps brackets, loses port');
  eq(normalizeHost(undefined), '', 'undefined');
});

test('isHostAllowed accepts an array as well as a Set', () => {
  ok(isHostAllowed('www.baseballism.com', ['www.baseballism.com']), 'array');
  ok(!isHostAllowed('', ALLOWED), 'empty host');
});

console.log('\n-- reading what the page says --');

const HTML = `<!doctype html><html><head>
<title>  Doubles &amp; Bubbles Tee | Baseballism </title>
<meta content="A tee for the &quot;doubles&quot; crowd." name="description">
<meta name="robots" content="index,follow">
<meta property="og:title" content="Doubles Tee">
<link rel="stylesheet" href="/a.css"><link href="https://www.baseballism.com/products/doubles-tee" rel='canonical'>
<script type="application/ld+json">{"@type":"Product","name":"x"}</script>
<script type="application/ld+json">{"@graph":[{"@type":["BreadcrumbList","Thing"]}]}</script>
<script type="application/ld+json">{ this is not json }</script>
</head><body>
<h1>Doubles &amp; Bubbles</h1>
<h2>Details</h2><h2>Shipping</h2>
<p>Soft cotton tee.</p>
<img src="a.jpg" alt="front"><img src="b.jpg"><img src="c.jpg" alt="">
<script>var hidden = "aaa bbb ccc ddd eee";</script>
<style>.x{content:"zzz zzz"}</style>
<!-- a comment with words -->
</body></html>`;

const facts = extractPageFacts(HTML);

test('title is trimmed and entity-decoded', () => {
  eq(facts.title, 'Doubles & Bubbles Tee | Baseballism', 'title');
  eq(facts.title_length, 35, 'length measured on the decoded title');
});

test('meta description is found regardless of attribute order', () => {
  eq(facts.meta_description, 'A tee for the "doubles" crowd.', 'description');
});

test('canonical is found with rel after href and single quotes', () => {
  eq(facts.canonical_url, 'https://www.baseballism.com/products/doubles-tee', 'canonical');
});

test('a stylesheet link is not mistaken for the canonical', () => {
  ok(!String(facts.canonical_url).endsWith('a.css'), 'not the stylesheet');
});

test('robots is captured as the page directive', () => {
  eq(facts.meta_robots, 'index,follow', 'robots');
});

test('og:title is read from property=, not name=', () => {
  eq(facts.og_title, 'Doubles Tee', 'og:title');
  eq(facts.og_description, null, 'absent stays null, never empty string');
});

test('headings are collected and counted', () => {
  deepEq(facts.h1, ['Doubles & Bubbles'], 'h1 text decoded');
  eq(facts.h1_count, 1, 'h1 count');
  eq(facts.h2_count, 2, 'h2 count');
});

test('script, style and comment text are excluded from word count', () => {
  ok(facts.word_count > 0, 'counted something');
  ok(!/aaa|zzz/.test(String(facts.word_count)), 'sanity');
  // "Doubles & Bubbles Details Shipping Soft cotton tee." = 8 words
  eq(facts.word_count, 8, 'only visible prose');
});

test('images missing alt counts ONLY a missing attribute, not alt=""', () => {
  eq(facts.image_count, 3, 'three images');
  eq(facts.images_missing_alt, 1, 'alt="" is correct decorative markup and is not a defect');
});

test('JSON-LD types are collected across blocks, including @graph', () => {
  deepEq(facts.jsonld_types.sort(), ['BreadcrumbList', 'Product', 'Thing'], 'types');
});

test('one malformed JSON-LD block does not lose the others', () => {
  ok(facts.jsonld_types.includes('Product'), 'earlier block survived the bad one');
});

test('an empty or non-string page yields nulls and zeroes, not a throw', () => {
  const empty = extractPageFacts('');
  eq(empty.title, null, 'title');
  eq(empty.word_count, 0, 'words');
  eq(empty.image_count, 0, 'images');
  deepEq(empty.jsonld_types, [], 'types');
  eq(extractPageFacts(undefined).h1_count, 0, 'undefined input');
});

test('decodeEntities handles numeric entities', () => {
  eq(decodeEntities('caf&#233; &amp; bar'), 'café & bar', 'decoded');
});

console.log('\n-- the allowlist the sync writes must match the check that reads it --');

const CONN = { company_entity_id: 'company-1', shop_domain: 'baseballism.myshopify.com' };

test('both the myshopify and the primary custom domain are recorded', () => {
  const rows = buildShopDomainRows(
    { myshopify_domain: 'baseballism.myshopify.com', domain: 'www.baseballism.com' },
    CONN,
  );
  eq(rows.length, 2, 'two hosts');
  deepEq(rows.map((r) => r.kind), ['myshopify', 'primary'], 'kinds, myshopify first');
  deepEq(rows.map((r) => r.host), ['baseballism.myshopify.com', 'www.baseballism.com'], 'hosts');
  ok(!('first_seen_at' in rows[0]), 'first_seen_at stays out of the upsert payload');
});

test('a shop whose custom domain IS the myshopify domain yields one row', () => {
  const rows = buildShopDomainRows(
    { myshopify_domain: 'shop.myshopify.com', domain: 'shop.myshopify.com' },
    CONN,
  );
  eq(rows.length, 1, 'deduped, not two rows fighting the same unique index');
});

// The OAuth grant already proves the myshopify domain, so an unhelpful shop
// object must still leave the store inspectable on its permanent domain.
test('an empty shop object still records the connection myshopify domain', () => {
  const rows = buildShopDomainRows({}, CONN);
  eq(rows.length, 1, 'one host');
  eq(rows[0].host, 'baseballism.myshopify.com', 'from the connection');
  eq(rows[0].kind, 'myshopify', 'kind');
});

test('a pasted scheme, path, port or trailing dot is normalised away', () => {
  const rows = buildShopDomainRows(
    { myshopify_domain: 'x.myshopify.com', domain: 'HTTPS://WWW.Baseballism.com.:443/collections' },
    CONN,
  );
  eq(rows[1].host, 'www.baseballism.com', 'normalised to a bare host');
});

// If these two disagree the allowlist silently stops matching: the sync writes
// one string and the admission check looks up another. Neither module can
// catch that alone, so it is asserted across the boundary.
test('normalizeShopHost agrees with inspect-lib normalizeHost', () => {
  for (const input of [
    'WWW.Baseballism.COM', 'www.baseballism.com.', 'www.baseballism.com:8443',
    'user@www.baseballism.com', 'shop.myshopify.com', '', '   ',
  ]) {
    eq(normalizeShopHost(input), normalizeHost(input), `disagreement on ${JSON.stringify(input)}`);
  }
});

test('a host written by the sync is admitted by the checker', () => {
  const rows = buildShopDomainRows(
    { myshopify_domain: 'baseballism.myshopify.com', domain: 'www.baseballism.com' },
    CONN,
  );
  const allow = new Set(rows.map((r) => r.host));
  eq(admitUrl('https://www.baseballism.com/collections/tees', allow).error, undefined, 'admitted end to end');
});

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
