/* po-document -- one purchase order, as a PDF.
 *
 * TWO WAYS IN, and they are different kinds of caller:
 *
 *   1. ?t=<token>  -- the single-use key minted when an AI connection claimed
 *      that PO's queued email (20261128050000). It is stored hashed, it names
 *      exactly one purchase order, it dies after 24 hours or when the email is
 *      marked sent, and it is the ONLY thing it opens. This is what lets the
 *      person's own AI attach the PO to the email it sends; the model never
 *      gets a Supabase token.
 *
 *   2. Authorization: Bearer <the person's own session> -- the Download PDF
 *      button in SILO. The purchase order is read with THAT token through
 *      PostgREST, so RLS decides what comes back: this function has no
 *      opinion about who may read a PO, and cannot be talked into one.
 *
 * Deployed with verify_jwt OFF, because path 1 has no Supabase JWT at all.
 * Path 2 therefore verifies the caller itself, and its first read is a
 * caller-token PostgREST call whose error aborts -- which is what the
 * two-step-login and third-party-token rules in supabase/functions/CLAUDE.md
 * require of a function that accepts a caller token.
 *
 * The service role appears once: resolving a token hash to its purchase order
 * (path 1), and reading that PO's rows afterwards. A token is proof that a
 * person queued this exact PO and a connection they approved claimed it.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'GET, OPTIONS',
};

const fail = (status, code, message) =>
  new Response(JSON.stringify({ error: code, message }), { status, headers: { ...JSON_HEADERS, ...CORS } });

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

async function sha256Hex(text, cryptoImpl) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** One PostgREST GET. `auth` is the whole Authorization header value. */
async function rest(fetchImpl, env, path, auth) {
  const res = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: auth,
      accept: 'application/json',
    },
  });
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`postgrest_${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return body ? JSON.parse(body) : [];
}

export function createPoDocumentHandler({ env, fetchImpl, pdfLib, renderPurchaseOrder, identity, cryptoImpl }) {
  const crypto_ = cryptoImpl || globalThis.crypto;

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'GET') return fail(405, 'method_not_allowed', 'Use GET.');
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return fail(500, 'not_configured', 'This function is not configured.');
    }

    const url = new URL(req.url);
    const token = (url.searchParams.get('t') || '').trim();
    const wanted = (url.searchParams.get('po') || '').trim();
    const serviceAuth = env.SUPABASE_SERVICE_ROLE_KEY ? `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` : null;

    let poId = null;
    let auth = null;          // the Authorization used for the PO reads
    let filename = 'purchase-order.pdf';

    if (token) {
      if (!/^[0-9a-f]{16,128}$/i.test(token)) return fail(400, 'bad_token', 'That link is not valid.');
      if (!serviceAuth) return fail(500, 'not_configured', 'This function is not configured.');
      const hash = await sha256Hex(token, crypto_);
      let rows;
      try {
        rows = await rest(fetchImpl, env,
          `po_vendor_emails?select=po_header_id,status,doc_token_expires_at&doc_token_hash=eq.${hash}&limit=1`,
          serviceAuth);
      } catch {
        return fail(502, 'lookup_failed', 'Could not check that link.');
      }
      const row = rows[0];
      if (!row || row.status !== 'claimed') return fail(404, 'link_not_live', 'That link is no longer valid.');
      if (row.doc_token_expires_at && Date.parse(row.doc_token_expires_at) < Date.now()) {
        return fail(410, 'link_expired', 'That link has expired. Take the email again to get a new one.');
      }
      poId = row.po_header_id;
      auth = serviceAuth;
    } else {
      const header = req.headers.get('authorization') || '';
      if (!/^Bearer\s+\S+/i.test(header)) {
        return fail(401, 'not_authenticated', 'Sign in to open this purchase order.');
      }
      if (!isUuid(wanted)) return fail(400, 'po_required', 'Name the purchase order with ?po=<id>.');
      poId = wanted;
      auth = header;
    }

    // The PO itself. On the signed-in path this is the read that RLS judges,
    // and an empty result is "not yours", not "not found".
    let po;
    try {
      const rows = await rest(fetchImpl, env,
        `po_headers?select=id,po_name,factory_id,order_date,req_ship_date,expected_arrival_date,status,notes,is_new_product_po,company_entity_id&id=eq.${poId}&limit=1`,
        auth);
      po = rows[0];
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        return fail(401, 'not_authenticated', 'That sign-in is not valid any more.');
      }
      return fail(502, 'read_failed', 'Could not read that purchase order.');
    }
    if (!po) return fail(404, 'unknown_po', 'No such purchase order, or it is not yours to read.');

    // Everything else it prints. Each read is independent: a missing block is
    // left out of the document rather than failing the whole render.
    const safe = async (path) => { try { return await rest(fetchImpl, env, path, auth); } catch { return []; } };

    const [lines, factories, settings, entities] = await Promise.all([
      safe(`po_lines?select=title_snapshot,sku_snapshot,variant_title_snapshot,qty&po_header_id=eq.${po.id}&order=qty.desc&limit=400`),
      po.factory_id
        ? safe(`factories?select=factory_name,contact_name,contact_email,payment_terms,shipping_terms&id=eq.${po.factory_id}&limit=1`)
        : Promise.resolve([]),
      safe(`company_settings?select=legal_name,address_line1,address_line2,city,region,postal_code,country,phone,purchasing_contact_name,purchasing_contact_phone,purchasing_contact_email&company_entity_id=eq.${po.company_entity_id}&limit=1`),
      safe(`entities?select=title&id=eq.${po.company_entity_id}&limit=1`),
    ]);

    filename = `${String(po.po_name || 'purchase-order').replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`;

    let bytes;
    try {
      bytes = await renderPurchaseOrder({
        po,
        factory: factories[0] || {},
        lines,
        identity: identity({ settings: settings[0] || {}, entity: entities[0] || {} }),
      }, pdfLib);
    } catch (err) {
      return fail(500, 'render_failed', `Could not build the PDF: ${String(err && err.message || err).slice(0, 200)}`);
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        ...CORS,
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  };
}
