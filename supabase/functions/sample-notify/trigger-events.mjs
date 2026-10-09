// Which sample-notify events each caller may send, whether an unsigned
// (trigger) event describes what actually happened, and the key that makes
// each delivery happen once. Pure, so node tests run it
// (scripts/tests/sample-notify-trigger-events.test.mjs).
//
// Security audit 2026-10-08, review cycles 1-2: the function is public
// (verify_jwt off), so an unsigned caller must not be able to announce a
// transition that did not happen, repeat one, or race several copies of one
// past a "sent already?" read. The trigger now signs its calls
// (x-silo-trigger-secret, 20261008120000); once SAMPLE_NOTIFY_TRIGGER_SECRET is
// set, an unsigned call without it is refused outright. Delivery is made
// once-only by an atomic claim (sample_notification_claims) taken BEFORE any
// send, keyed by claimKeyFor().

export const RECEIVED_STATUSES = ['received', 'pps_received', 'full_run_received'];

// What notify_sample_events() sends (the trigger; no user JWT).
export const TRIGGER_TYPES = ['SAMPLE_REQUESTED', 'SAMPLE_RECEIVED', 'SAMPLE_SIZE_REQUEST'];
// What a signed-in browser sends ("Notify now" on v2/products.html).
export const SIGNED_IN_TYPES = ['SAMPLE_ASSIGNED'];

// Before the trigger secret is configured, an INSERT event must arrive while
// its row is new (pg_net delivers in seconds).
export const INSERT_EVENT_WINDOW_MS = 15 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** May this caller send this event at all? */
export function callerMaySend(signedIn, type) {
  return (signedIn ? SIGNED_IN_TYPES : TRIGGER_TYPES).includes(type);
}

/** Does the row's CURRENT state match the event notify_sample_events() would
 *  have sent for it? Mirrors that trigger function exactly. */
export function rowSupportsTriggerEvent(type, r) {
  const sizes = String(r?.size_requests ?? '').trim();
  const routed = r?.assigned_to != null || r?.request_source != null;
  const received = RECEIVED_STATUSES.includes(String(r?.sample_status ?? ''));
  if (type === 'SAMPLE_REQUESTED') return routed && !sizes && !received;
  if (type === 'SAMPLE_RECEIVED') return routed && !sizes && received;
  if (type === 'SAMPLE_SIZE_REQUEST') return r?.request_source === 'catalog_photo_request' && !!sizes;
  return false;
}

/** Unsigned INSERT events without a trigger secret: only while the row is new. */
export function insertEventIsFresh(createdAt, now = Date.now()) {
  const created = Date.parse(String(createdAt ?? ''));
  return Number.isFinite(created) && now - created <= INSERT_EVENT_WINDOW_MS;
}

/** The once-only key for an unsigned (trigger) delivery, or null to refuse.
 *  - requested / received happen once per sample (an INSERT): 'insert'.
 *  - a size request recurs, once per TRANSITION: with a verified trigger,
 *    the trigger's own per-transition event_id; before the secret is set,
 *    the size list itself (a list already announced is not announced again). */
export function claimKeyFor(type, { verifiedTrigger, eventId, row }) {
  if (type === 'SAMPLE_REQUESTED' || type === 'SAMPLE_RECEIVED') return 'insert';
  if (type !== 'SAMPLE_SIZE_REQUEST') return null;
  if (verifiedTrigger) return UUID_RE.test(String(eventId ?? '')) ? `evt:${String(eventId).toLowerCase()}` : null;
  const sizes = String(row?.size_requests ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return sizes ? `sizes:${sizes}` : null;
}
