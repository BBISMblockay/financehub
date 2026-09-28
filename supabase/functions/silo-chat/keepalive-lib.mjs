// supabase/functions/silo-chat/keepalive-lib.mjs
//
// Lets an Ask SILO request run past Supabase's 150-second gateway limit.
//
// Supabase returns a bare 504 when a function has not STARTED its response
// within 150 s ("request idle timeout"), and the worker itself may run for
// 400 s on a paid plan (this project is on Pro). Broad questions -- "an
// executive summary of the business" -- need more than the ~95 s of
// investigation that fitted under 150 s, so they came back partial.
//
// So a slow request starts its response early: headers and a single space go
// out after FIRST_BYTE_MS, another space every HEARTBEAT_MS, and the real JSON
// body when the work finishes. Leading whitespace is valid JSON, so the
// browser's `await res.json()` reads the body unchanged.
//
// What that costs: the HTTP status is committed at 200 before the outcome is
// known. The real status therefore travels IN the body as `http_status`, and
// the page reads it from there (v2/silo-chat.html). A request that finishes
// before FIRST_BYTE_MS -- every refusal, every auth failure, most ordinary
// questions -- is returned exactly as before, status and all.
//
// The work is also registered with EdgeRuntime.waitUntil when available, so if
// anything between the browser and the function does cut the connection, the
// worker still finishes, writes the audit row, and the page recovers the
// answer from it by request id.

export const FIRST_BYTE_MS = 5_000;
export const HEARTBEAT_MS = 10_000;

// DEFERRED DELIVERY (2026-09-28, the mode the page now asks for).
//
// The heartbeat stream above was measured live and did NOT hold: the
// connection was closed at ~126s ("Http: connection closed before message
// completed") while the function went on to finish a complete 227s answer that
// never reached the screen. Holding a connection open is not a delivery path
// SILO controls. So a request that says `async: true` and carries a valid
// request_id gets `202 { pending: true, request_id }` once it has run for
// FIRST_BYTE_MS, the work continues under waitUntil, and the FINISHED response
// -- body and status, exactly what the page would have been sent -- is handed
// to `storeResponse` for the page to collect by request id
// (public.silo_chat_responses). Anything that finishes sooner, every refusal
// included, is returned directly as before. A caller that does not ask for it
// (an older page) still gets the heartbeat stream.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** { async, requestId } from a request body, without consuming the request. */
export async function deferralRequested(req) {
  try {
    if (req.method !== 'POST') return null;
    const body = await req.clone().json();
    const requestId = String(body?.request_id || '');
    return body?.async === true && UUID_RE.test(requestId) ? requestId : null;
  } catch {
    return null;
  }
}

export function withKeepAlive(handler, {
  firstByteMs = FIRST_BYTE_MS,
  heartbeatMs = HEARTBEAT_MS,
  headers = {},
  waitUntil = null,
  storeResponse = null,
} = {}) {
  return async (req) => {
    const deferId = typeof storeResponse === 'function' ? await deferralRequested(req) : null;
    const inner = Promise.resolve().then(() => handler(req));
    // Whether the page was told "pending". Decided once, by the race below, and
    // AWAITED by the store rather than read as a flag: a flag read when the work
    // finishes could be read a tick before the race sets it, and an answer that
    // lands in that tick would be neither returned nor stored.
    let decide;
    const wasDeferred = new Promise((resolve) => { decide = resolve; });
    // When deferring, the STORE is the work that must outlive the request:
    // registering only the handler would let the worker retire between the
    // answer and its delivery. A fast answer was returned directly and is not
    // stored a second time.
    const delivered = deferId
      ? inner
        .then(async (res) => finalParts(await res.clone().text(), res.status), (err) => ({
          body: failureBody(err), status: 500,
        }))
        .then(async ({ body, status }) => {
          if (await wasDeferred) await storeResponse(req, deferId, status, body);
        })
        .catch((err) => { console.error('[keepalive] could not store the finished response', err); })
      : null;
    if (typeof waitUntil === 'function') {
      try { waitUntil(delivered || inner.catch(() => {})); } catch { /* best effort */ }
    }

    let timer;
    const early = await Promise.race([
      inner.then((res) => ({ res }), (err) => ({ err })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), firstByteMs); }),
    ]);
    clearTimeout(timer);
    decide(!early && Boolean(deferId));
    if (early) {
      if ('err' in early) throw early.err;
      return early.res;
    }

    if (deferId) {
      return new Response(JSON.stringify({ pending: true, request_id: deferId }), {
        status: 202,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const enc = new TextEncoder();
    let beat = null;
    const stop = () => { if (beat) { clearInterval(beat); beat = null; } };
    const body = new ReadableStream({
      start(controller) {
        const send = (text) => { try { controller.enqueue(enc.encode(text)); return true; } catch { return false; } };
        send(' ');
        beat = setInterval(() => { if (!send(' ')) stop(); }, heartbeatMs);
        inner
          .then(async (res) => finalBody(await res.text(), res.status), (err) => JSON.stringify({
            error: 'Something went wrong while answering. Try again.',
            detail: String((err && err.message) || err),
            http_status: 500,
          }))
          .then((text) => {
            stop();
            send(text);
            try { controller.close(); } catch { /* client already gone */ }
          });
      },
      cancel() { stop(); },
    });
    return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } });
  };
}

function failureBody(err) {
  return {
    error: 'Something went wrong while answering. Try again.',
    detail: String((err && err.message) || err),
    retryable: true,
  };
}

/** A finished response as { body: object, status }, for storage. A body that
 *  is not a JSON object is wrapped, so the page always receives an object. */
export function finalParts(text, status) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { body: parsed, status };
  } catch { /* wrap below */ }
  return { body: { error: text || 'Unexpected response.' }, status };
}

/** The finished response's body with its real status carried inside it. */
export function finalBody(text, status) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, http_status: status });
    }
  } catch { /* not JSON -- wrap it below */ }
  return JSON.stringify({ error: text || 'Unexpected response.', http_status: status });
}
