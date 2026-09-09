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
  isPublicAddress, allAddressesPublic,
  findHeaderEnd, parseResponseHead, decodeChunkedBody, buildRequest,
} from '../../supabase/functions/page-inspect/inspect-lib.mjs';
import { buildShopDomainRows, normalizeShopHost, runShopDomainsSync } from '../lib/shopify-sync-core.mjs';
import { createFakeSupabase } from './lib/fake-supabase.mjs';

let failures = 0;
let count = 0;
function test(name, fn) {
  count++;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((err) => { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); });
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

// https:// on purpose, so it is the HOST check being exercised rather than the
// scheme check short-circuiting first.
for (const [label, url] of [
  ['dotted IPv4 loopback', 'https://127.0.0.1/'],
  ['link-local metadata', 'https://169.254.169.254/latest/meta-data/'],
  ['private range', 'https://10.0.0.1/'],
  ['decimal IPv4', 'https://2130706433/'],
  ['octal IPv4', 'https://0177.0.0.1/'],
  ['IPv6 loopback', 'https://[::1]/'],
  ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/'],
  // No port: the non-443 port rule is asserted separately, and this case is
  // here to exercise the HOST check.
  ['localhost by name', 'https://localhost/'],
]) {
  test(`${label} is rejected by name`, () => {
    ok(rejected(url).startsWith('host_not_allowed'), 'rejected as a disallowed host');
  });
}

// The allowlist stops an attacker NAMING an internal address. It does nothing
// about an allowlisted name RESOLVING to one, which is why the address checks
// below exist and run at the fetch layer on every hop.
console.log('\n-- resolved addresses must be public unicast --');

for (const [label, ip] of [
  ['IPv4 loopback', '127.0.0.1'],
  ['IPv4 loopback, high', '127.255.255.254'],
  ['link-local / cloud metadata', '169.254.169.254'],
  ['RFC1918 10/8', '10.1.2.3'],
  ['RFC1918 172.16/12', '172.20.0.1'],
  ['RFC1918 192.168/16', '192.168.1.1'],
  ['CGNAT 100.64/10', '100.100.0.1'],
  ['this-host 0/8', '0.0.0.0'],
  ['multicast', '224.0.0.1'],
  ['broadcast', '255.255.255.255'],
  ['benchmark 198.18/15', '198.18.0.1'],
  ['IPv6 loopback', '::1'],
  ['IPv6 unspecified', '::'],
  ['IPv6 unique-local', 'fd00::1'],
  ['IPv6 link-local', 'fe80::1'],
  ['IPv6 multicast', 'ff02::1'],
  ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
  ['IPv4-mapped metadata', '::ffff:169.254.169.254'],
  ['NAT64 loopback', '64:ff9b::127.0.0.1'],
  ['6to4 wrapping RFC1918', '2002:c0a8:0101::1'],
]) {
  test(`${label} (${ip}) is not a public destination`, () => {
    ok(!isPublicAddress(ip), 'must be refused');
  });
}

for (const [label, ip] of [
  ['a normal public IPv4', '23.227.38.65'],
  ['another public IPv4', '8.8.8.8'],
  ['public IPv6', '2606:4700:4700::1111'],
  ['IPv4-mapped public', '::ffff:23.227.38.65'],
]) {
  test(`${label} (${ip}) is allowed`, () => {
    ok(isPublicAddress(ip), 'must be permitted');
  });
}

test('an unparseable or absent address is refused, not waved through', () => {
  ok(!isPublicAddress('not-an-ip'), 'garbage');
  ok(!isPublicAddress(''), 'empty');
  ok(!isPublicAddress(null), 'null');
  ok(!isPublicAddress('999.1.1.1'), 'out of range octet');
});

// 0177.0.0.1 is 127.0.0.1 in octal. Rather than trying to decode every
// alternate notation correctly, anything that is not an unambiguous dotted
// quad is refused outright.
test('octal and leading-zero IPv4 forms are refused rather than decoded', () => {
  ok(!isPublicAddress('0177.0.0.1'), 'octal loopback');
  ok(!isPublicAddress('010.0.0.1'), 'leading zero');
});

test('allAddressesPublic requires ALL of them, and refuses an empty list', () => {
  ok(allAddressesPublic(['23.227.38.65', '8.8.8.8']), 'all public');
  ok(!allAddressesPublic(['23.227.38.65', '127.0.0.1']), 'one private poisons it');
  ok(!allAddressesPublic([]), 'empty means we could not establish where it points');
  ok(!allAddressesPublic(null), 'null');
});

console.log('\n-- HTTPS only --');

test('http:// is refused even on an allowlisted host', () => {
  eq(rejected('http://www.baseballism.com/'), 'scheme_not_allowed: http', 'reason');
});

test('a redirect that downgrades to http is refused', () => {
  const r = admitRedirect('http://www.baseballism.com/x', 'https://www.baseballism.com/', ALLOWED);
  eq(r.error, 'scheme_not_allowed: http', 'reason');
});

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
  // https so the HOST check is what runs; the http downgrade case is asserted
  // separately above.
  const r = admitRedirect('https://169.254.169.254/', 'https://www.baseballism.com/a', ALLOWED);
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

console.log('\n-- reading HTTP ourselves, because fetch() re-resolves --');

// Validating an address and then calling fetch(host) is two lookups: the one
// we approved and the one the connection used. Nothing binds them, which is
// why the connection is made to the validated address and the response is
// parsed here rather than by fetch.
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

test('a non-443 port is refused even on an allowlisted host', () => {
  eq(rejected('https://www.baseballism.com:8443/admin'), 'port_not_allowed: 8443', 'reason');
  eq(admitUrl('https://www.baseballism.com:443/x', ALLOWED).error, undefined, '443 is fine');
});

test('findHeaderEnd locates the blank line, or reports absence', () => {
  const bytes = enc('HTTP/1.1 200 OK\r\nA: b\r\n\r\nBODY');
  eq(findHeaderEnd(bytes), enc('HTTP/1.1 200 OK\r\nA: b').length, 'offset of the CRLFCRLF');
  eq(findHeaderEnd(enc('HTTP/1.1 200 OK\r\nA: b\r\n')), -1, 'not yet complete');
});

test('a status line and headers are parsed, case-insensitively', () => {
  const r = parseResponseHead('HTTP/1.1 301 Moved Permanently\r\nLocation: /new\r\nContent-Type: text/html');
  eq(r.status, 301, 'status');
  eq(r.headers.get('location'), '/new', 'location');
  eq(r.headers.get('content-type'), 'text/html', 'header names lowercased');
});

test('a malformed status line is an error, not a guess', () => {
  eq(parseResponseHead('GARBAGE').error, 'malformed_status_line', 'reason');
  eq(parseResponseHead('').error, 'malformed_status_line', 'empty');
});

// Two Location headers is malformed. Taking the last would let a second header
// override the one any check already read.
test('a duplicated Location keeps the FIRST value', () => {
  const r = parseResponseHead('HTTP/1.1 302 Found\r\nLocation: https://www.baseballism.com/a\r\nLocation: https://evil.example/');
  eq(r.headers.get('location'), 'https://www.baseballism.com/a', 'first wins');
});

test('a chunked body is decoded and its terminator noted', () => {
  const raw = enc('4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n');
  const r = decodeChunkedBody(raw);
  eq(dec(r.body), 'Wikipedia', 'joined');
  eq(r.complete, true, 'saw the zero-length terminator');
  eq(r.truncated, false, 'not truncated');
});

// A connection cut mid-body must not read as a clean short page: a later
// comparison would report content that "shrank".
test('a chunked body with no terminator is marked incomplete', () => {
  const r = decodeChunkedBody(enc('4\r\nWiki\r\n'));
  eq(dec(r.body), 'Wiki', 'what arrived');
  eq(r.complete, false, 'incomplete');
});

test('chunk extensions are ignored, bad chunk sizes are refused', () => {
  eq(dec(decodeChunkedBody(enc('4;name=value\r\nWiki\r\n0\r\n\r\n')).body), 'Wiki', 'extension ignored');
  eq(decodeChunkedBody(enc('zz\r\nWiki\r\n')).error, 'bad_chunk_size', 'refused');
});

test('the byte cap applies to a chunked body too', () => {
  const r = decodeChunkedBody(enc('4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n'), 6);
  eq(dec(r.body), 'Wikipe', 'stopped at the cap');
  eq(r.truncated, true, 'flagged');
});

test('the request asks for the framing the reader can handle', () => {
  const req = buildRequest('www.baseballism.com', '/collections/tees?a=1', 'SILO/1.0');
  ok(req.startsWith('GET /collections/tees?a=1 HTTP/1.1\r\n'), 'request line with query');
  ok(req.includes('\r\nHost: www.baseballism.com\r\n'), 'Host header drives SNI-matched vhost');
  ok(req.includes('\r\nConnection: close\r\n'), 'no keep-alive framing to desynchronise');
  ok(req.includes('\r\nAccept-Encoding: identity\r\n'), 'no decompression in the path');
  ok(req.endsWith('\r\n\r\n'), 'terminated');
});

console.log('\n-- the allowlist must SHRINK when a shop stops serving a host --');

// An allowlist that only grows keeps authorising a custom domain that was
// changed, sold or transferred. The sweep is safe here specifically because
// shop.json is ONE non-paginated request: it either told us the whole truth or
// it threw before reaching the sweep. That is the property the collections
// registry cannot have, which is why that one gates on completed_at instead.
await test('a domain the shop no longer serves is deleted, and only that one', async () => {
  const supabase = createFakeSupabase();
  const conn = { company_entity_id: 'company-1', shop_domain: 'baseballism.myshopify.com', api_version: '2024-10', access_token: 'x' };

  await runShopDomainsSync(supabase, conn, {
    fetchJson: async () => ({ shop: { myshopify_domain: 'baseballism.myshopify.com', domain: 'old.example.com' } }),
  });
  eq(supabase.rows('shopify_shop_domains').length, 2, 'two hosts after the first sync');

  const res = await runShopDomainsSync(supabase, conn, {
    fetchJson: async () => ({ shop: { myshopify_domain: 'baseballism.myshopify.com', domain: 'www.baseballism.com' } }),
  });

  const hosts = supabase.rows('shopify_shop_domains').map((r) => r.host).sort();
  deepEq(hosts, ['baseballism.myshopify.com', 'www.baseballism.com'], 'old.example.com is gone');
  deepEq(res.hosts_retired, ['old.example.com'], 'and it is reported as retired');
});

await test('the sweep is scoped to this shop — another shop keeps its hosts', async () => {
  const supabase = createFakeSupabase();
  const connA = { company_entity_id: 'company-1', shop_domain: 'a.myshopify.com', api_version: '2024-10', access_token: 'x' };
  const connB = { company_entity_id: 'company-1', shop_domain: 'b.myshopify.com', api_version: '2024-10', access_token: 'x' };

  await runShopDomainsSync(supabase, connB, {
    fetchJson: async () => ({ shop: { myshopify_domain: 'b.myshopify.com', domain: 'shop-b.example.com' } }),
  });
  await runShopDomainsSync(supabase, connA, {
    fetchJson: async () => ({ shop: { myshopify_domain: 'a.myshopify.com', domain: 'shop-a.example.com' } }),
  });

  const hosts = supabase.rows('shopify_shop_domains').map((r) => r.host).sort();
  deepEq(hosts,
    ['a.myshopify.com', 'b.myshopify.com', 'shop-a.example.com', 'shop-b.example.com'],
    "syncing shop A must not retire shop B's hosts");
});

// If the shop object could not be read we know nothing, and deleting on the
// strength of nothing would empty the allowlist and break inspection for a
// shop that is perfectly fine.
await test('a failed shop fetch retires NOTHING', async () => {
  const supabase = createFakeSupabase();
  const conn = { company_entity_id: 'company-1', shop_domain: 'baseballism.myshopify.com', api_version: '2024-10', access_token: 'x' };

  await runShopDomainsSync(supabase, conn, {
    fetchJson: async () => ({ shop: { myshopify_domain: 'baseballism.myshopify.com', domain: 'www.baseballism.com' } }),
  });
  const before = supabase.rows('shopify_shop_domains').length;

  const res = await runShopDomainsSync(supabase, conn, {
    fetchJson: async () => { throw new Error('503 from Shopify'); },
  });

  ok(res.skipped, 'reported as skipped');
  eq(supabase.calls.deletes.length, 1, 'no second delete ran');
  eq(supabase.rows('shopify_shop_domains').length, before, 'allowlist untouched');
});

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
