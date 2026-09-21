// What a customer onboarding submission MEANS, decided without a network, a
// database or a Deno runtime -- so scripts/tests/customer-onboarding.test.mjs
// executes the real decisions rather than a re-description of them.
//
// Everything here is a decision that would otherwise be spread across the
// handler and the page, and would then be made twice, differently. The page
// imports the same consent text and the same validation shape, so a form that
// looks complete cannot be one the function refuses.

// ── Consent ────────────────────────────────────────────────────────────────
// Stripe requires the customer authorise off-session use of a saved card, and
// requires that authorisation state HOW the amount is determined and WHEN a
// charge may occur. A generic "I agree to the terms" does not satisfy it.
//
// The version is bumped whenever this text changes. The stored record is the
// TEXT, not the version -- what matters later is what this person read, and a
// version string resolves to whatever that version says today.
export const CONSENT_VERSION = '2026-09-19.v1';

export const CONSENT_TEXT = [
  'I authorise this merchant to store my payment method and to charge it for',
  'amounts I owe on wholesale orders I place or that are placed on my account.',
  'Each charge will equal the total of the invoice it settles, including any',
  'agreed shipping and tax, and no more.',
  'Charges may be made when an invoice issued to this account becomes due under',
  'the payment terms agreed for it, or immediately on order where those terms',
  'are payment in advance.',
  'These charges may occur when I am not present to confirm them.',
  'I can withdraw this authorisation, or change the payment method on file, by',
  'contacting the merchant at any time.',
].join(' ');

/**
 * Is a recorded consent good enough to start a card-setup session?
 *
 * A consent recorded against an OLDER version of the text is not carried
 * forward: the applicant authorised different words. Re-consenting costs a
 * checkbox; treating the old one as current means charging a card under an
 * authorisation nobody gave.
 */
export function consentIsCurrent(account) {
  if (!account?.off_session_consent_at) return false;
  return account.off_session_consent_version === CONSENT_VERSION;
}

// ── Submission validation ──────────────────────────────────────────────────

export const ADDRESS_TYPES = ['business', 'shipping', 'billing'];

/* The account types the open form offers. Kept here rather than in the page
   so the dropdown cannot offer something customer_accounts' CHECK will
   refuse; the handler serves this list to the page on open_peek. */
export const ACCOUNT_TYPES = ['wholesale'];

// Only what SILO genuinely cannot proceed without. Everything else on the form
// is collected and left optional on purpose: a required field the applicant
// cannot answer produces a phone call, not better data.
const REQUIRED_TEXT = [
  ['legal_name', 'Legal business name'],
];

const REQUIRED_CONTACT = [
  ['first_name', 'Contact first name'],
  ['last_name', 'Contact last name'],
  ['email', 'Contact email'],
];

function blank(v) {
  return v == null || String(v).trim() === '';
}

/**
 * Validate and NORMALISE a submission payload.
 *
 * Returns { ok, errors, payload }. The returned payload is what goes to
 * submit_customer_account() -- built key by key from the input rather than
 * passed through, so a caller cannot smuggle a column in. Internal columns
 * (approved terms, credit limit, price tier), the Stripe/QBO/AR links and
 * every card column are not constructible from here at all.
 */
export function validateSubmission(input) {
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};

  for (const [key, label] of REQUIRED_TEXT) {
    if (blank(src[key])) errors.push(`${label} is required`);
  }

  // ── Addresses ────────────────────────────────────────────────────────────
  const rawAddresses = Array.isArray(src.addresses) ? src.addresses : [];
  const seen = new Set();
  const addresses = [];

  for (const a of rawAddresses) {
    const type = String(a?.address_type ?? '').trim();
    if (!ADDRESS_TYPES.includes(type)) {
      errors.push(`Unknown address type "${type}"`);
      continue;
    }
    if (seen.has(type)) {
      errors.push(`More than one ${type} address was supplied`);
      continue;
    }
    seen.add(type);

    const sameAs = blank(a?.same_as_address_type)
      ? null
      : String(a.same_as_address_type).trim();

    if (sameAs !== null) {
      // The database CHECKs bound this too, but a constraint violation
      // surfaces as an opaque 500 to someone filling in a form. Refusing here
      // means the applicant is told which box is wrong.
      // Self-reference is checked FIRST because it is the more specific
      // complaint: `billing same as billing` also fails the billing rule
      // below, and reporting "can only be the same as business or shipping"
      // sends someone looking at the wrong box. (Written the other way round
      // first, which made this branch unreachable -- caught by the test that
      // asserts the message, not merely the refusal.)
      if (sameAs === type) {
        errors.push(`An address cannot be the same as itself (${type})`);
      } else if (type === 'business') {
        errors.push('The business address cannot be "same as" another address');
      } else if (type === 'shipping' && sameAs !== 'business') {
        errors.push('A shipping address can only be the same as the business address');
      } else if (type === 'billing' && !['business', 'shipping'].includes(sameAs)) {
        errors.push('A billing address can only be the same as the business or shipping address');
      }
      // A pointer carries no street. Dropping any typed street here rather
      // than storing it is what keeps "same as" meaning one address instead of
      // two that agree today.
      addresses.push({
        address_type: type,
        same_as_address_type: sameAs,
        attention_name: text(a?.attention_name),
        recipient_name: text(a?.recipient_name),
        phone: text(a?.phone),
      });
      continue;
    }

    if (blank(a?.street1)) errors.push(`Street address is required for the ${type} address`);
    if (blank(a?.city)) errors.push(`City is required for the ${type} address`);
    if (blank(a?.country)) errors.push(`Country is required for the ${type} address`);

    addresses.push({
      address_type: type,
      same_as_address_type: null,
      recipient_name: text(a?.recipient_name),
      attention_name: text(a?.attention_name),
      street1: text(a?.street1),
      street2: text(a?.street2),
      city: text(a?.city),
      region: text(a?.region),
      postal_code: text(a?.postal_code),
      country: text(a?.country),
      phone: text(a?.phone),
    });
  }

  if (!seen.has('business')) errors.push('A business address is required');

  // A pointer at an address that was not supplied resolves to nothing, and the
  // resolving view would print an empty address rather than fail.
  for (const a of addresses) {
    if (a.same_as_address_type && !seen.has(a.same_as_address_type)) {
      errors.push(
        `The ${a.address_type} address refers to a ${a.same_as_address_type} address that was not supplied`);
    }
  }

  // ── Contacts ─────────────────────────────────────────────────────────────
  const rawContacts = Array.isArray(src.contacts) ? src.contacts : [];
  const contacts = [];
  let primaries = 0;

  for (const c of rawContacts) {
    const type = blank(c?.contact_type) ? 'primary' : String(c.contact_type).trim();
    if (!['primary', 'accounts_payable', 'buyer', 'other'].includes(type)) {
      errors.push(`Unknown contact type "${type}"`);
      continue;
    }
    if (type === 'primary') {
      primaries += 1;
      for (const [key, label] of REQUIRED_CONTACT) {
        if (blank(c?.[key])) errors.push(`${label} is required`);
      }
      if (!blank(c?.email) && !looksLikeEmail(c.email)) {
        errors.push('Contact email does not look like an email address');
      }
    }
    contacts.push({
      contact_type: type,
      first_name: text(c?.first_name),
      last_name: text(c?.last_name),
      title: text(c?.title),
      email: text(c?.email),
      phone: text(c?.phone),
    });
  }

  if (primaries === 0) errors.push('A primary contact is required');
  if (primaries > 1) errors.push('Only one primary contact may be supplied');

  return {
    ok: errors.length === 0,
    errors,
    payload: {
      legal_name: text(src.legal_name),
      dba_name: text(src.dba_name),
      website: text(src.website),
      requested_payment_terms: text(src.requested_payment_terms),
      applicant_notes: text(src.applicant_notes),
      federal_ein: text(src.federal_ein),
      resale_tax_id: text(src.resale_tax_id),
      addresses,
      contacts,
    },
  };
}

function text(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function looksLikeEmail(v) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v).trim());
}

// ── Card setup: what to do about a session that already exists ─────────────
//
// The rule that matters, and the one the Billing surface got wrong twice
// before it was right: a retry must REPLAY the same session, never mint a
// second payable one. So an open session is handed back, a completed one
// refuses, and only a session Stripe has DEFINITIVELY said is finished or
// gone releases the claim.
//
// `null`/unknown is never treated as "gone". A network blip or a Stripe 5xx
// reading as "expired" is how a second live session gets opened beside one the
// applicant still has in a tab.
export function decideSetupSession(stripeStatus) {
  switch (stripeStatus) {
    case 'open':      return { action: 'replay' };
    case 'complete':  return { action: 'refuse', reason: 'already_completed' };
    case 'expired':   return { action: 'restart' };
    case 'missing':   return { action: 'restart' };
    default:
      // Includes null, undefined, and any status a later Stripe API adds.
      return { action: 'refuse', reason: 'status_unknown' };
  }
}

/**
 * Which file extensions the resale certificate may be uploaded as, and the
 * storage path it takes.
 *
 * The path's FIRST segment is the customer account id, because that is what
 * the storage policy's EXISTS reads. Anything else and the object is
 * unreachable by every authenticated reader -- including the finance user who
 * needs it.
 */
export const CERTIFICATE_TYPES = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/heic', 'heic'],
]);

export function certificatePath(accountId, contentType) {
  const ext = CERTIFICATE_TYPES.get(String(contentType || '').toLowerCase());
  if (!ext) return null;
  // A fixed name, so re-uploading replaces rather than accumulating orphans
  // nobody will ever look at or clean up.
  return `${accountId}/resale-certificate.${ext}`;
}
