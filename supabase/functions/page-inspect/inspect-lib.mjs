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

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

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
