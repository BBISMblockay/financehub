// Which sample-notify events each caller may send, and whether an unsigned
// (trigger) event describes what actually happened. Pure, so node tests run it
// (scripts/tests/sample-notify-trigger-events.test.mjs). Security audit
// 2026-10-08, cycle-1 review: the function is public (verify_jwt off), so an
// unsigned caller must not be able to announce a transition that did not
// happen, or repeat one.

export const RECEIVED_STATUSES = ['received', 'pps_received', 'full_run_received'];

// What notify_sample_events() sends (the trigger; no Authorization header).
export const TRIGGER_TYPES = ['SAMPLE_REQUESTED', 'SAMPLE_RECEIVED', 'SAMPLE_SIZE_REQUEST'];
// What a signed-in browser sends ("Notify now" on v2/products.html).
export const SIGNED_IN_TYPES = ['SAMPLE_ASSIGNED'];

export const INSERT_EVENT_WINDOW_MS = 15 * 60 * 1000;
export const SIZE_REQUEST_COOLDOWN_MS = 10 * 60 * 1000;

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

/** For an unsigned event that matches the row: is it fresh and not a repeat?
 *  `priorLogAt` is the newest sample_notification_log created_at for this
 *  sample and event (null if none). INSERT events (requested / received)
 *  happen once per sample, so they need a row created within the window and
 *  no earlier log at all; a size request may recur, so it needs only a
 *  cooldown since the last one. */
export function unsignedEventIsFresh(type, createdAt, priorLogAt, now = Date.now()) {
  const prior = priorLogAt ? Date.parse(priorLogAt) : NaN;
  if (type === 'SAMPLE_SIZE_REQUEST') {
    return !(Number.isFinite(prior) && now - prior < SIZE_REQUEST_COOLDOWN_MS);
  }
  const created = Date.parse(String(createdAt ?? ''));
  if (!Number.isFinite(created) || now - created > INSERT_EVENT_WINDOW_MS) return false;
  return !Number.isFinite(prior);
}
