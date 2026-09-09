/* Pure logic for page-inspect: URL admission, redirect checking, and reading
 * what a page says about itself.
 *
 * Plain JavaScript in a .mjs file rather than TypeScript, so Deno imports it
 * in the edge function AND Node imports it in
 * scripts/tests/page-inspect.test.mjs. The alternative -- putting this inside
 * index.ts -- makes the security-critical half of this function untestable
 * without a Deno toolchain, and an allowlist nothing exercises is how a
 * bypass ships.
 *
 * NOTHING HERE MAKES A CLAIM ABOUT SEARCH. Every field extracted is something
 * the page states about itself. meta_robots is a DIRECTIVE the page gives; it
 * is not evidence that anything indexed, crawled or ranked the page, and SILO
 * holds no data that could support such a claim.
 */

/** Hosts we will fetch must match one of these EXACTLY.
 *
 * Exact match, never a suffix test. `host.endsWith('baseballism.com')` also
 * accepts `evil-baseballism.com` and `baseballism.com.attacker.net`, which is
 * the classic allowlist bypass. It also means an IP literal in any notation
 * (dotted, decimal, octal, IPv6, IPv4-mapped) can never be admitted, because
 * none of them is string-equal to a storefront domain -- so private-range
 * access is excluded structurally rather than filtered.
 */
export function isHostAllowed(host, allowedHosts) {
  if (!host) return false;
  const set = allowedHosts instanceof Set ? allowedHosts : new Set(allowedHosts || []);
  return set.has(normalizeHost(host));
}

/** Lowercase, strip a trailing root dot, drop any userinfo/port that snuck in.
 * Returns '' for anything unusable rather than throwing. */
export function normalizeHost(host) {
  if (typeof host !== 'string') return '';
  let h = host.trim().toLowerCase();
  if (!h) return '';
  const at = h.lastIndexOf('@');
  if (at !== -1) h = h.slice(at + 1);          // strip user:pass@
  if (h.startsWith('[')) {                      // IPv6 literal — keep bracketed
    const close = h.indexOf(']');
    if (close !== -1) h = h.slice(0, close + 1);
  } else {
    const colon = h.indexOf(':');
    if (colon !== -1) h = h.slice(0, colon);    // strip :port
  }
  while (h.endsWith('.')) h = h.slice(0, -1);   // 'example.com.' === 'example.com'
  return h;
}

// HTTPS only. A storefront on a custom domain is served over TLS, and http://
// bought nothing except a downgrade path: an on-path attacker can rewrite a
// plaintext response, and the redirect chain is only as trustworthy as the
// responses carrying it.
const ALLOWED_SCHEMES = new Set(['https:']);

// ── Destination address validation ──────────────────────────────────────────
//
// The host allowlist is necessary and NOT sufficient, and the first version of
// this file overstated it. An allowlisted custom domain is a name we do not
// control the resolution of: www.baseballism.com is whatever DNS says it is,
// and DNS can say 127.0.0.1, 169.254.169.254 or a ULA address -- by
// misconfiguration, by a hijacked zone, or deliberately. Exact-match hostnames
// stop an attacker NAMING an internal address; they do nothing about one being
// RESOLVED to.
//
// So every hop's host is resolved and every returned address must be public
// unicast. This is checked at the fetch layer, per hop, not once at admission.
//
// RESIDUAL RISK, stated rather than glossed: this is a check-then-connect, so
// a zone that returns a public address to our lookup and a private one to the
// connection a moment later (DNS rebinding) is not defeated by it. Closing
// that needs connecting to the validated address with an explicit Host header,
// which fetch() does not expose. The mitigation stack is therefore: an
// exact-match allowlist of domains Shopify vouched for, HTTPS only, resolution
// checked on every hop, and stale domains retired from the allowlist promptly.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Parse a dotted-quad into 4 octets, or null. Strict: no octal, no decimal
 * shorthand, no leading zeros -- those forms are how denylists get walked past,
 * and anything that is not an unambiguous dotted quad is simply not accepted. */
export function parseIpv4(s) {
  const m = IPV4_RE.exec(String(s ?? '').trim());
  if (!m) return null;
  const parts = m.slice(1, 5).map((p) => {
    if (p.length > 1 && p[0] === '0') return -1;   // leading zero => octal-ish
    const n = Number(p);
    return n >= 0 && n <= 255 ? n : -1;
  });
  return parts.some((p) => p < 0) ? null : parts;
}

function ipv4IsPublic([a, b, c]) {
  if (a === 0) return false;                                   // 0.0.0.0/8 "this host"
  if (a === 10) return false;                                  // RFC1918
  if (a === 127) return false;                                 // loopback
  if (a === 169 && b === 254) return false;                    // link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return false;           // RFC1918
  if (a === 192 && b === 168) return false;                    // RFC1918
  if (a === 192 && b === 0 && c === 0) return false;           // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false;           // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return false;        // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;         // TEST-NET-3
  if (a === 192 && b === 88 && c === 99) return false;         // 6to4 relay anycast
  if (a === 100 && b >= 64 && b <= 127) return false;          // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return false;       // benchmarking
  if (a >= 224) return false;                                  // multicast + reserved + broadcast
  return true;
}

/** Expand an IPv6 literal (with or without ::) to 8 groups, or null. */
export function parseIpv6(s) {
  let str = String(s ?? '').trim().toLowerCase();
  if (str.startsWith('[') && str.endsWith(']')) str = str.slice(1, -1);
  if (!str.includes(':')) return null;
  const zone = str.indexOf('%');
  if (zone !== -1) str = str.slice(0, zone);

  // A trailing dotted quad (IPv4-mapped / NAT64 / 6to4-style) becomes 2 groups.
  const lastColon = str.lastIndexOf(':');
  const tail = str.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    str = str.slice(0, lastColon + 1)
      + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }

  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tailGroups = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tailGroups.length;
  if (fill < 0 || (halves.length === 2 && fill < 1)) return null;

  const groups = [
    ...head,
    ...Array(halves.length === 2 ? fill : 0).fill('0'),
    ...tailGroups,
  ].map((g) => {
    if (g === '') return -1;
    if (!/^[0-9a-f]{1,4}$/.test(g)) return -1;
    return parseInt(g, 16);
  });
  return groups.length === 8 && !groups.some((g) => g < 0) ? groups : null;
}

function ipv6IsPublic(g) {
  const isZero = (n) => g.slice(0, n).every((x) => x === 0);
  if (isZero(8)) return false;                                  // ::
  if (isZero(7) && g[7] === 1) return false;                    // ::1 loopback
  // IPv4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::/96 carry a v4 address; judge
  // it as v4, or 127.0.0.1 walks straight through wearing a v6 hat.
  if (isZero(5) && g[5] === 0xffff) {
    return ipv4IsPublic([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  if (g[0] === 0x0064 && g[1] === 0xff9b
      && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return ipv4IsPublic([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  // 6to4 2002::/16 embeds a v4 address in the next 32 bits.
  if (g[0] === 0x2002) {
    return ipv4IsPublic([g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff]);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return false;                 // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return false;                 // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return false;                 // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;         // 2001:db8::/32 docs
  if (g[0] === 0x2001 && g[1] === 0x0000) return false;         // Teredo
  return true;
}

/** Is this literal address a public unicast destination we are willing to
 * connect to? Anything unparseable is REFUSED, not waved through -- an address
 * we cannot classify is one we cannot vouch for. */
export function isPublicAddress(ip) {
  const v4 = parseIpv4(ip);
  if (v4) return ipv4IsPublic(v4);
  const v6 = parseIpv6(ip);
  if (v6) return ipv6IsPublic(v6);
  return false;
}

/** Every resolved address must be public. An empty list is a refusal: "we
 * could not establish where this points" is not permission to connect. */
export function allAddressesPublic(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) return false;
  return addresses.every((a) => isPublicAddress(a));
}

/** Admit a URL for fetching, or say precisely why not.
 * Returns { url, host } or { error }. Never throws. */
export function admitUrl(raw, allowedHosts) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'no_url' };
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { error: 'unparseable_url' };
  }
  // javascript:, data:, file:, ftp:, gopher: and friends never reach a fetch.
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { error: `scheme_not_allowed: ${parsed.protocol.replace(':', '')}` };
  }
  // Credentials in a URL are never legitimate here and can confuse host
  // parsing in downstream tools even where URL got it right.
  if (parsed.username || parsed.password) return { error: 'credentials_in_url' };

  const host = normalizeHost(parsed.hostname);
  if (!host) return { error: 'no_host' };
  if (!isHostAllowed(host, allowedHosts)) return { error: `host_not_allowed: ${host}` };
  return { url: parsed.toString(), host };
}

/** Resolve a Location header against the current URL and re-admit it.
 * A redirect is a brand-new request to a brand-new host, so it gets the SAME
 * admission check as the original -- this is the only path by which a
 * disallowed host could otherwise be reached. */
export function admitRedirect(location, currentUrl, allowedHosts) {
  if (!location) return { error: 'redirect_without_location' };
  let absolute;
  try {
    absolute = new URL(location, currentUrl).toString();
  } catch {
    return { error: 'unparseable_redirect' };
  }
  return admitUrl(absolute, allowedHosts);
}

// ── Reading the page ────────────────────────────────────────────────────────

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

export function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      return n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : _;
    });
}

const clean = (s) => (s == null ? null : decodeEntities(String(s).replace(/\s+/g, ' ').trim()) || null);

/** Pull one attribute out of a tag string, single or double quoted. */
function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return m[2] ?? m[3] ?? null;
}

/** Find a <meta> tag whose `name` or `property` equals `key`. Attribute order
 * varies between themes, so the whole tag is matched and then read. */
function metaContent(html, key) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const k = (attr(tag, 'name') || attr(tag, 'property') || '').toLowerCase();
    if (k === key) return clean(attr(tag, 'content'));
  }
  return null;
}

const stripTags = (s) => s.replace(/<[^>]*>/g, ' ');

/** Everything the page states about itself.
 *
 * Regex over HTML, not a DOM parse -- deliberately dependency-free, and
 * adequate because Shopify storefronts server-render their markup. The real
 * limitation to remember is that word_count measures the SERVER-RENDERED
 * HTML: content a theme injects with JavaScript is not counted, so a low
 * count is evidence about the HTML, not about what a visitor sees.
 */
export function extractPageFacts(html) {
  const src = typeof html === 'string' ? html : '';

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  const title = clean(titleMatch ? stripTags(titleMatch[1]) : null);

  const metaDescription = metaContent(src, 'description');

  let canonical = null;
  const linkRe = /<link\b[^>]*>/gi;
  let lm;
  while ((lm = linkRe.exec(src)) !== null) {
    if ((attr(lm[0], 'rel') || '').toLowerCase().trim() === 'canonical') {
      canonical = clean(attr(lm[0], 'href'));
      break;
    }
  }

  const h1 = [];
  const h1Re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi;
  let hm;
  while ((hm = h1Re.exec(src)) !== null) {
    const t = clean(stripTags(hm[1]));
    if (t) h1.push(t);
  }
  const h2Count = (src.match(/<h2\b[^>]*>/gi) || []).length;

  // Body text: the BODY, not the document. The <title> element's text sits
  // between tags and so survives tag-stripping -- counting it would add the
  // title's words to every page's content length and make a thin page look
  // longer than it is. Falls back to the document minus <head> when a theme
  // omits an explicit <body>.
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(src);
  const scope = bodyMatch ? bodyMatch[1] : src.replace(/<head\b[\s\S]*?<\/head>/i, ' ');
  const body = scope
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = decodeEntities(stripTags(body)).replace(/\s+/g, ' ').trim();
  const wordCount = text ? text.split(' ').filter(Boolean).length : 0;

  const imgTags = src.match(/<img\b[^>]*>/gi) || [];
  // Counts images with NO alt attribute at all. An EMPTY alt (alt="") is the
  // correct markup for a decorative image and is deliberately not counted --
  // reporting it as a defect would send someone to "fix" accessible markup.
  const imagesMissingAlt = imgTags.filter((t) => attr(t, 'alt') === null).length;

  const jsonldTypes = [];
  const ldRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ld;
  while ((ld = ldRe.exec(src)) !== null) {
    try {
      collectTypes(JSON.parse(ld[1].trim()), jsonldTypes);
    } catch {
      // A theme with one malformed block should not lose the others, and a
      // parse failure is not a claim that no structured data exists.
    }
  }

  return {
    title,
    title_length: title ? title.length : null,
    meta_description: metaDescription,
    meta_description_length: metaDescription ? metaDescription.length : null,
    canonical_url: canonical,
    meta_robots: metaContent(src, 'robots'),
    og_title: metaContent(src, 'og:title'),
    og_description: metaContent(src, 'og:description'),
    h1,
    h1_count: h1.length,
    h2_count: h2Count,
    word_count: wordCount,
    image_count: imgTags.length,
    images_missing_alt: imagesMissingAlt,
    jsonld_types: [...new Set(jsonldTypes)],
  };
}

function collectTypes(node, out) {
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const t = node['@type'];
  if (typeof t === 'string') out.push(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.push(x);
  if (node['@graph']) collectTypes(node['@graph'], out);
}
