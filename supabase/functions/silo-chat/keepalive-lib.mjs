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

export function withKeepAlive(handler, {
  firstByteMs = FIRST_BYTE_MS,
  heartbeatMs = HEARTBEAT_MS,
  headers = {},
  waitUntil = null,
} = {}) {
  return async (req) => {
    const inner = Promise.resolve().then(() => handler(req));
    if (typeof waitUntil === 'function') {
      try { waitUntil(inner.catch(() => {})); } catch { /* best effort */ }
    }

    let timer;
    const early = await Promise.race([
      inner.then((res) => ({ res }), (err) => ({ err })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), firstByteMs); }),
    ]);
    clearTimeout(timer);
    if (early) {
      if ('err' in early) throw early.err;
      return early.res;
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
