// Turning what somebody typed into what Stripe will be sent. Pure -- no
// network, no Deno -- and unit-tested from node
// (scripts/tests/stripe-edge-logic.test.mjs).
//
// This module exists because the conversion from "1,250.00" to an integer
// number of minor units is the one arithmetic step between a person and a real
// customer's card, and it must have exactly ONE definition. Doing it in the
// page would put it in the browser, where the currency's exponent is not
// known and where a second page would eventually do it differently.
//
// Currency exponents, and why three-decimal currencies are REFUSED rather
// than supported: Stripe takes amounts in the currency's minor unit, but for
// BHD/JOD/KWD/OMR/TND it requires the value to be a multiple of 10 in a
// three-decimal representation. Guessing at that is how you undercharge a
// customer by a factor of ten. Nothing here needs those currencies today, so
// they are named and refused, which is recoverable; silently mis-scaling is
// not.

export const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg',
  'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

export const UNSUPPORTED_THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

export class InvoiceInputError extends Error {}

/**
 * "1,250.00" (major units, as typed) -> 125000 (minor units, as Stripe wants).
 *
 * Refuses rather than rounds silently when more decimals are given than the
 * currency has: "10.005" in USD is not a price, it is a typo or a unit
 * mistake, and rounding it to 10.01 invents a number the person never agreed
 * to.
 */
export function toMinorUnits(value, currency) {
  const code = String(currency || '').toLowerCase();
  if (!/^[a-z]{3}$/.test(code)) throw new InvoiceInputError(`Unknown currency "${currency}"`);
  if (UNSUPPORTED_THREE_DECIMAL.has(code)) {
    throw new InvoiceInputError(
      `${code.toUpperCase()} is a three-decimal currency and is not supported yet — `
      + 'Stripe requires those amounts in units of ten and SILO would have to guess. '
      + 'Invoice in another currency, or add explicit support.');
  }

  const raw = String(value ?? '').trim().replace(/,/g, '');
  if (raw === '') throw new InvoiceInputError('Amount is required');
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new InvoiceInputError(`"${value}" is not an amount`);

  const exponent = ZERO_DECIMAL.has(code) ? 0 : 2;
  const [whole, fraction = ''] = raw.replace('-', '').split('.');
  if (fraction.replace(/0+$/, '').length > exponent) {
    throw new InvoiceInputError(
      exponent === 0
        ? `${code.toUpperCase()} has no minor unit, so "${value}" cannot be charged`
        : `"${value}" has more than ${exponent} decimal places`);
  }

  const padded = (fraction + '0'.repeat(exponent)).slice(0, exponent);
  const minor = BigInt(whole || '0') * BigInt(10 ** exponent) + BigInt(padded || '0');
  const signed = raw.startsWith('-') ? -minor : minor;

  // Stripe's own ceiling. Beyond it the API errors anyway; saying so here
  // names the field instead of surfacing a raw Stripe error at the end of a
  // multi-step create.
  if (signed > 99999999999n || signed < -99999999999n) {
    throw new InvoiceInputError(`"${value}" is outside the amount Stripe accepts`);
  }
  return Number(signed);
}

/**
 * Validate and normalise the whole set of lines for one invoice.
 *
 * Every line is checked BEFORE anything is created in Stripe. A create that
 * fails on line 7 leaves a draft invoice with six items in the client's real
 * Stripe account -- recoverable, but it is their books, and the cheap fix is
 * to not start.
 */
export function normalizeInvoiceLines(lines, currency) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new InvoiceInputError('An invoice needs at least one line');
  }
  if (lines.length > 100) {
    throw new InvoiceInputError('An invoice is limited to 100 lines');
  }

  const out = lines.map((line, i) => {
    const at = `Line ${i + 1}`;
    const description = String(line?.description ?? '').trim();
    if (!description) throw new InvoiceInputError(`${at}: a description is required`);
    if (description.length > 500) {
      throw new InvoiceInputError(`${at}: description is longer than 500 characters`);
    }

    const quantityRaw = line?.quantity ?? 1;
    const quantity = Number(quantityRaw);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new InvoiceInputError(`${at}: quantity must be a positive number`);
    }
    if (!Number.isInteger(quantity)) {
      // Stripe's invoice items take an integer quantity; a fractional one
      // belongs in the unit price, and accepting it here would silently
      // truncate to a different invoice than the one on screen.
      throw new InvoiceInputError(`${at}: quantity must be a whole number — put fractions in the unit price`);
    }

    const unitAmount = toMinorUnits(line?.unit_amount, currency);
    if (unitAmount === 0) throw new InvoiceInputError(`${at}: a zero-amount line has no effect`);
    // Negative lines are legitimate (a discount or a credit) but a whole
    // invoice that nets to zero or below cannot be collected, which is
    // checked on the total below rather than per line.

    return {
      description,
      quantity,
      unit_amount: unitAmount,
      amount: unitAmount * quantity,
    };
  });

  const total = out.reduce((sum, l) => sum + l.amount, 0);
  if (total <= 0) {
    throw new InvoiceInputError(
      'The invoice totals zero or less. Stripe cannot collect that — '
      + 'issue a credit note in Stripe instead.');
  }

  return { lines: out, total };
}

/**
 * A stable fingerprint of what was asked for, recorded beside the request id.
 *
 * It is NOT an idempotency key (the request id is). It is there so that when a
 * retry comes back with the same id and a DIFFERENT invoice, the log can say
 * so -- which is the difference between "the response was lost" and "somebody
 * edited the form and pressed the button again".
 */
export function fingerprintInvoice({ customer, currency, dueDays, lines, memo }) {
  const parts = [
    String(customer ?? ''),
    String(currency ?? '').toLowerCase(),
    String(dueDays ?? ''),
    String(memo ?? '').trim(),
    ...lines.map((l) => `${l.description}\u0001${l.quantity}\u0001${l.unit_amount}`),
  ];
  return parts.join('\u0002');
}

/**
 * Did this failure leave anything behind at Stripe?
 *
 * `invoices.create` can fail two ways and they demand opposite recoveries.
 * Stripe REJECTED the request (4xx: a bad parameter, a disabled account) --
 * nothing was created, so the next attempt should start clean. Or the answer
 * was lost (a timeout, a reset, a 5xx) -- Stripe may well have committed the
 * invoice, and a clean restart mints a new request id, hence a new Stripe
 * idempotency key, hence A SECOND REAL DRAFT for the client's customer.
 *
 * So an ambiguous failure keeps its request id. The retry replays the SAME
 * `silo-invoice-<request_id>` key and Stripe returns the original object
 * instead of making another one.
 *
 * Unknown is treated as ambiguous on purpose: the cost of re-using a key that
 * created nothing is one wasted key, and the cost of the opposite mistake is
 * an invoice a real customer receives twice.
 */
export function createOutcome(err) {
  const status = Number(err?.statusCode ?? err?.status ?? NaN);
  if (Number.isFinite(status) && status >= 400 && status < 500) return 'failed';
  return 'ambiguous';
}
