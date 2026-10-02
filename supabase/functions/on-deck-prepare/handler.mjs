import { timingSafeEqual } from 'node:crypto';
import { prepareOne } from './provider.mjs';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
// The role a bearer JWT CLAIMS. Unverified on its own -- only ever used to
// decide whether to ask the auth server to verify the token.
function claimedRole(token) {
  try {
    const part = token.split('.')[1]; if (!part) return null;
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))).role ?? null;
  } catch { return null; }
}
export function createHandler({ createDb, serviceKey, apiKey, fetcher = fetch, verifyServiceToken = async () => false }) {
  return async request => {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    // Gateway JWT verification is retained. A normal user JWT is insufficient:
    // only the existing service credential may invoke this scheduler endpoint.
    const provided = request.headers.get('authorization') || '';
    const expected = `Bearer ${serviceKey || ''}`;
    const encoder = new TextEncoder(), left = encoder.encode(provided), right = encoder.encode(expected);
    // The key the platform injects here is not always byte-identical to the
    // service-role key the GitHub worker holds (both valid), and the exact
    // compare alone 401'd every scheduled run from 2026-09-29. So a token that
    // CLAIMS service_role is accepted only once the auth server confirms it
    // (an admin-only endpoint), never on the claim itself.
    const exact = !!serviceKey && left.length === right.length && timingSafeEqual(left, right);
    const token = provided.startsWith('Bearer ') ? provided.slice(7) : '';
    if (!serviceKey || (!exact && !(claimedRole(token) === 'service_role' && await verifyServiceToken(token).catch(() => false)))) return json({ error: 'unauthorized' }, 401);
    if (!apiKey) return json({ error: 'anthropic_secret_not_configured_in_supabase' }, 503);
    try {
      // Stream-limit even chunked bodies; callers may only name stored work.
      const reader = request.body?.getReader(); if (!reader) return json({ error: 'invalid_request' }, 400);
      let raw = '', bytes = 0; const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024) { await reader.cancel(); return json({ error: 'request_too_large' }, 413); }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
      let input; try { input = JSON.parse(raw); } catch { return json({ error: 'invalid_request' }, 400); }
      if (!input || !uuid(input.proposal_id) || !uuid(input.request_id) || !Number.isSafeInteger(input.version) || input.version < 1 || Object.keys(input).some(k => !['proposal_id', 'request_id', 'version'].includes(k))) return json({ error: 'invalid_request' }, 400);
      const db = createDb();
      const { data: proposal, error } = await db.from('on_deck_proposals').select('*').eq('id', input.proposal_id).eq('version', input.version).maybeSingle();
      if (error) return json({ error: 'proposal_read_failed' }, 503);
      if (!proposal) return json({ outcome: 'changed' });
      // The RPC checks company enablement, freshness, exact version, concurrency,
      // and budget before any paid call. Settlement remains in this same runtime.
      const outcome = await prepareOne({ db, proposal, apiKey, fetcher, requestId: input.request_id });
      return json({ outcome });
    } catch {
      // Do not return raw DB/provider errors, prompts, copy or credential values.
      // Any uncertain reservation remains charged; no blind paid retry.
      return json({ error: 'preparation_failed' }, 503);
    }
  };
}
