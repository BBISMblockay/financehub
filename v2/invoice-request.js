/* ==========================================================================
   SiloInvoiceRequest — the idempotency key for creating something billable,
   held across a RELOAD rather than across a dialog.

   The migration that added `stripe_invoice_requests` says the failure
   atomicity does not cover is the LOST RESPONSE: the invoice commits at
   Stripe, the answer never arrives, the person tries again. The first version
   of the invoicing page then defeated exactly that, by minting a fresh
   `crypto.randomUUID()` every time the dialog opened — so the retry that
   actually happens (reload the page, fill it in again) carried a NEW key and
   created a SECOND real invoice for somebody's customer.

   A key that lives in a JS variable protects against a double-click. Only a
   key that outlives the document protects against the reload.

   Storage: `sessionStorage`, per tab, keyed by company. Per tab is right —
   two tabs creating two different invoices are two legitimate requests, and a
   shared key would collapse them into one. It survives reload and back/forward,
   which is the whole requirement, and not a browser restart, by which point
   the invoice is visible in the list anyway. Every access is wrapped: private
   mode and blocked site data throw, and an invoicing page that refuses to open
   because storage is unavailable would be worse than one that degrades to
   the old behaviour — so it does, and says so.
   ========================================================================== */
(function (global) {
  'use strict';

  function storage() {
    try {
      const s = global.sessionStorage;
      const probe = '__silo_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (_) {
      return null;
    }
  }

  function read(store, key) {
    if (!store) return null;
    try {
      const raw = store.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // A marker with no request id is not a marker. Treat a corrupted or
      // half-written value as absent rather than throwing on every open.
      return parsed && typeof parsed.request_id === 'string' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function write(store, key, value) {
    if (!store) return false;
    try { store.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }

  function drop(store, key) {
    if (!store) return;
    try { store.removeItem(key); } catch (_) { /* nothing to do */ }
  }

  /**
   * A stable description of WHAT was asked for, so a resumed attempt can tell
   * "the response was lost" from "somebody edited the form and pressed the
   * button again". Not the server's `payload_fingerprint` — that one is
   * recorded for diagnostics; this one decides whether a stored key may be
   * reused, and the two must not be confused for each other.
   */
  function formSignature(parts) {
    const lines = (parts && parts.lines) || [];
    return [
      String((parts && parts.customer) || ''),
      String((parts && parts.currency) || '').toLowerCase(),
      String(parts && parts.dueDays == null ? '' : parts.dueDays),
      String((parts && parts.memo) || '').trim(),
      ...lines.map((l) => [
        String(l.description || '').trim(),
        String(l.quantity == null ? '' : l.quantity),
        String(l.unit_amount == null ? '' : l.unit_amount).trim(),
      ].join('\u0001')),
    ].join('\u0002');
  }

  /**
   * What to do about a stored marker, given what the server says became of it.
   *
   *   serverStatus: 'succeeded' | 'pending' | 'failed' | 'unknown'
   *     'unknown' means no row came back — the create never reached the
   *     database, so nothing was made and the key is free.
   *
   * `objectId` is what makes 'failed' two different situations, and treating
   * them alike is how a retry made a second real draft: the handler records
   * the Stripe id alongside the failure whenever Stripe had ALREADY created
   * the invoice before a later step failed. A fresh key then means a fresh
   * Stripe idempotency key, so Stripe will not collapse the retry either.
   *
   * Returns one of:
   *   { action: 'reuse',     request_id }  resume the same attempt
   *   { action: 'fresh' }                  nothing was created; mint a new key
   *   { action: 'completed', request_id, object_id }
   *                                        the attempt DID make something at
   *                                        Stripe — succeeded, or failed after
   *                                        the draft existed. Show it; never
   *                                        resend.
   *   { action: 'blocked',   request_id }  an attempt with a DIFFERENT form is
   *                                        still in flight. Refusing is the
   *                                        point: we cannot tell whether that
   *                                        one created an invoice, and a fresh
   *                                        key here would create a second.
   */
  function decide(marker, currentSignature, serverStatus, objectId) {
    if (!marker) return { action: 'fresh' };
    if (serverStatus === 'succeeded') {
      return { action: 'completed', request_id: marker.request_id, object_id: objectId || null };
    }
    if (serverStatus === 'failed') {
      return objectId
        ? { action: 'completed', request_id: marker.request_id, object_id: objectId, partial: true }
        : { action: 'fresh' };
    }
    if (serverStatus === 'unknown') return { action: 'fresh' };
    // still pending
    if (marker.signature === currentSignature) {
      return { action: 'reuse', request_id: marker.request_id };
    }
    return { action: 'blocked', request_id: marker.request_id };
  }

  /**
   * Claim a key for this attempt, writing it down BEFORE the network call.
   * Reuses the stored one when the form is unchanged.
   */
  function begin(key, signature, mint) {
    const store = storage();
    const existing = read(store, key);
    if (existing && existing.signature === signature) {
      return { request_id: existing.request_id, resumed: true, durable: true };
    }
    const request_id = (mint || (() => global.crypto.randomUUID()))();
    const durable = write(store, key, { request_id, signature, at: Date.now() });
    return { request_id, resumed: false, durable };
  }

  global.SiloInvoiceRequest = {
    formSignature,
    decide,
    begin,
    pending: (key) => read(storage(), key),
    clear: (key) => drop(storage(), key),
    storageAvailable: () => storage() !== null,
    // Exposed for tests, which supply their own store rather than a real one.
    _internals: { read, write, drop },
  };
})(typeof window !== 'undefined' ? window : globalThis);
