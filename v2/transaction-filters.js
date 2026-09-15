/* Which transactions a filter position selects.
 *
 * Extracted from transactions.html for the same reason inventory-signals.js
 * was extracted: the rules that decide what the register SHOWS -- and
 * therefore what a count claims -- need to be somewhere a test can reach. The
 * page had two copies of the filter predicate (codingRows for the table,
 * dateDisplayRows for the AI candidate list) that were already drifting; both
 * now call matches() here, so a row the table hides can never quietly still be
 * a candidate.
 *
 * Three rules this module exists to hold:
 *
 *  1. MERCHANT IS THE SOURCE'S MERCHANT. card_transactions carries both
 *     `clean_merchant` (Plaid's merchant_name, or the issuer's own cleaned
 *     name from the CSV -- null when neither supplied one) and `merchant`
 *     (coalesce(merchant_name, name), so it falls back to the raw descriptor).
 *     Only the first is a merchant. 1,234 of 2,274 production rows have no
 *     merchant at all; showing the description in that column would turn "the
 *     bank told us nothing" into "the merchant is CHECKCARD 0412 SQ *TST".
 *     merchantOf() returns '' there, and the column stays blank.
 *
 *  2. A SPLIT ROW MATCHES ON ITS LINES, ONCE. Filtering by account has to
 *     reach the accounts a split actually codes to, which live on
 *     card_transaction_splits, not on the parent (whose own qbo_account_id is
 *     null by construction). The predicate is evaluated against the PARENT and
 *     asks whether any line matches, so a split across four accounts appears
 *     once, not four times.
 *
 *  3. SIGN IS DIRECTION, MAGNITUDE IS AMOUNT. card_transactions.amount is
 *     signed: positive is money out (a charge), negative is money in (a refund
 *     or deposit) -- the same reading the register's own Amount column prints.
 *     An amount filter therefore compares |amount| and lets `direction` decide
 *     the sign, so "500 to 1000" never silently means "-1000 to -500" as well.
 *     Comparisons are in integer cents: 0.1 + 0.2 is not 0.3, and an exact
 *     amount filter that misses the row it was typed from is worse than none.
 */
(function (global) {
  'use strict';

  const NO_MERCHANT = '__none__';
  const NO_ACCOUNT = '__none__';

  const STATUSES = ['all', 'uncoded', 'conflict', 'low', 'ai', 'excluded'];
  const DIRECTIONS = ['any', 'out', 'in'];
  const AMOUNT_MODES = ['any', 'exact', 'range'];

  const EMPTY = {
    status: 'all',
    search: '',
    text: '',
    merchant: '',
    account: '',
    type: '',
    dateStart: '',
    dateEnd: '',
    direction: 'any',
    amountMode: 'any',
    amountExact: '',
    amountMin: '',
    amountMax: '',
  };

  const str = (v) => (v == null ? '' : String(v));
  const trimmed = (v) => str(v).trim();
  const lower = (v) => trimmed(v).toLowerCase();
  const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(str(v));

  /* Money as integer cents. Returns null for anything that is not a finite
     number, so a half-typed "12." narrows nothing rather than matching every
     row or no rows. */
  function cents(value) {
    if (value == null || value === '') return null;
    const n = Number(str(value).replace(/[$,\s]/g, ''));
    if (!isFinite(n)) return null;
    return Math.round(n * 100);
  }

  /** Coerce anything -- a stored position, a partial patch -- into a full state. */
  function normalize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const f = {
      status: oneOf(r.status, STATUSES, 'all'),
      search: trimmed(r.search),
      text: trimmed(r.text),
      merchant: trimmed(r.merchant),
      account: trimmed(r.account),
      type: trimmed(r.type),
      dateStart: isDate(r.dateStart) ? r.dateStart : '',
      dateEnd: isDate(r.dateEnd) ? r.dateEnd : '',
      direction: oneOf(r.direction, DIRECTIONS, 'any'),
      amountMode: oneOf(r.amountMode, AMOUNT_MODES, 'any'),
      amountExact: trimmed(r.amountExact),
      amountMin: trimmed(r.amountMin),
      amountMax: trimmed(r.amountMax),
    };
    // A reversed range is a typo, not an empty result set: read it in order.
    if (f.dateStart && f.dateEnd && f.dateStart > f.dateEnd) {
      const swap = f.dateStart; f.dateStart = f.dateEnd; f.dateEnd = swap;
    }
    if (f.amountMode === 'range') {
      const lo = cents(f.amountMin); const hi = cents(f.amountMax);
      if (lo != null && hi != null && lo > hi) {
        const swap = f.amountMin; f.amountMin = f.amountMax; f.amountMax = swap;
      }
    }
    return f;
  }

  /* An amount mode with nothing typed in it narrows nothing. Kept separate
     from normalize() so the picker can stay on "range" while someone is still
     typing the second box. */
  function amountBounds(f) {
    if (f.amountMode === 'exact') {
      const c = cents(f.amountExact);
      return c == null ? null : { min: c, max: c };
    }
    if (f.amountMode === 'range') {
      const min = cents(f.amountMin);
      const max = cents(f.amountMax);
      if (min == null && max == null) return null;
      return { min: min == null ? -Infinity : min, max: max == null ? Infinity : max };
    }
    return null;
  }

  /** The merchant the SOURCE supplied, or '' when it supplied none. */
  function merchantOf(row) {
    return trimmed(row && row.clean_merchant);
  }

  /** 'out' for a charge, 'in' for a refund or deposit, null for a zero row. */
  function directionOf(row) {
    const n = Number((row && row.amount) || 0);
    if (n > 0) return 'out';
    if (n < 0) return 'in';
    return null;
  }

  const splitsOf = (row, ctx) => {
    const lines = ctx && typeof ctx.splitsFor === 'function' ? ctx.splitsFor(row) : null;
    return Array.isArray(lines) ? lines : [];
  };

  /* id and name together, because they have to stay in step: a split line
     carrying an account id but no cached name would otherwise shift every
     later name onto the wrong id in options(). */
  function accountPairs(row, ctx) {
    const lines = splitsOf(row, ctx);
    const source = lines.length
      ? lines.map((l) => ({ id: str(l && l.qbo_account_id), name: trimmed(l && l.qbo_account_name) }))
      : [{ id: str(row && row.qbo_account_id), name: trimmed(row && row.qbo_account_name) }];
    return source.filter((a) => a.id);
  }

  /** Every QBO account id this row codes to -- its split lines, or its own. */
  function accountKeys(row, ctx) {
    return accountPairs(row, ctx).map((a) => a.id);
  }

  /** Account names for display, split lines included. */
  function accountNames(row, ctx) {
    return accountPairs(row, ctx).map((a) => a.name).filter(Boolean);
  }

  /* The merchant/description filter. Deliberately narrower than the quick
     search: it reads the fields a person means by "who was this and what did
     it say", and not the account, card or location -- otherwise typing a
     vendor's name into it would also match every row merely CODED to that
     vendor's account. */
  function matchesText(row, q, ctx) {
    if (!q) return true;
    const key = ctx && typeof ctx.merchantKey === 'function' ? ctx.merchantKey(row) : '';
    return [row.description, row.clean_merchant, key, row.memo, row.vendor_name]
      .some((v) => lower(v).includes(q));
  }

  /* The quick search, which stays broad on purpose: it is the "find it
     wherever it is" box, and it reaches a split's own lines so a split cannot
     disappear from a search for the account it is coded to. */
  function matchesSearch(row, q, ctx) {
    if (!q) return true;
    if (q === '(no card name)') return !row.card_name;
    const key = ctx && typeof ctx.merchantKey === 'function' ? ctx.merchantKey(row) : '';
    const sourceName = ctx && typeof ctx.sourceName === 'function' ? ctx.sourceName(row) : '';
    return [
      row.description, row.clean_merchant, key, row.qbo_account_name,
      row.qbo_location_name, row.entity_name, row.card_name, row.cardholder,
      row.cardholder_email, row.vendor_name, row.memo, row.exclude_reason,
      sourceName, String(row.amount), row.txn_date,
      ...splitsOf(row, ctx).flatMap((l) => [l.qbo_account_name, l.qbo_location_name, l.memo]),
    ].some((v) => lower(v).includes(q));
  }

  function matchesStatus(row, status, ctx) {
    if (status === 'all') return true;
    if (status === 'uncoded') return row.status === 'uncoded';
    if (status === 'excluded') return row.status === 'excluded';
    if (status === 'conflict') return !!row.coding_conflict;
    if (status === 'low') {
      return row.status !== 'excluded' && (row.confidence == null ? 1 : row.confidence) < 0.6;
    }
    if (status === 'ai') {
      const suggested = ctx && typeof ctx.hasSuggestion === 'function' && ctx.hasSuggestion(row);
      return row.coding_source === 'ai' || !!suggested;
    }
    return true;
  }

  /** Does one transaction survive the whole filter position? */
  function matches(row, filters, ctx) {
    return matchesNormalized(row, normalize(filters), ctx);
  }

  /* The predicate itself, against an ALREADY normalized position. apply()
     normalizes once and calls this per row rather than re-normalizing a few
     thousand times. */
  function matchesNormalized(row, f, ctx) {
    if (!row) return false;
    const context = ctx || {};

    if (!matchesStatus(row, f.status, context)) return false;
    if (!matchesSearch(row, lower(f.search), context)) return false;
    if (!matchesText(row, lower(f.text), context)) return false;

    if (f.merchant) {
      const merchant = merchantOf(row);
      if (f.merchant === NO_MERCHANT) { if (merchant) return false; }
      else if (merchant.toLowerCase() !== f.merchant.toLowerCase()) return false;
    }

    if (f.account) {
      const keys = accountKeys(row, context);
      if (f.account === NO_ACCOUNT) { if (keys.length) return false; }
      // A split matches when ANY of its lines does, and the parent is still
      // one row: this is a predicate over the parent, never a flatMap.
      else if (!keys.includes(f.account)) return false;
    }

    if (f.type && str(row.accounting_treatment || 'unknown') !== f.type) return false;

    const date = str(row.txn_date);
    if (f.dateStart && (!date || date < f.dateStart)) return false;
    if (f.dateEnd && (!date || date > f.dateEnd)) return false;

    if (f.direction !== 'any' && directionOf(row) !== f.direction) return false;

    const bounds = amountBounds(f);
    if (bounds) {
      const value = Math.abs(cents(row.amount) == null ? NaN : cents(row.amount));
      if (!isFinite(value)) return false;
      if (value < bounds.min || value > bounds.max) return false;
    }

    return true;
  }

  /** The filtered rows, in their incoming order. One row in, at most one out. */
  function apply(rows, filters, ctx) {
    const f = normalize(filters);
    return (rows || []).filter((row) => matchesNormalized(row, f, ctx));
  }

  /** Is anything narrowing the set? */
  function isActive(filters) {
    const f = normalize(filters);
    return describe(f, {}).length > 0;
  }

  const MONEY = (c) => (c / 100).toLocaleString('en-US',
    { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* One chip per active filter, each naming what it did and carrying the key
     that clears it. The labels are what the header prints, so "no merchant"
     and "Uncategorized" read as the deliberate choices they are rather than as
     an empty box. */
  function describe(filters, ctx) {
    const f = normalize(filters);
    const context = ctx || {};
    const name = (id) => (typeof context.accountName === 'function' && context.accountName(id)) || id;
    const typeLabel = (v) => (typeof context.typeLabel === 'function' && context.typeLabel(v)) || v;
    const statusLabel = (v) => (typeof context.statusLabel === 'function' && context.statusLabel(v)) || v;
    const chips = [];

    if (f.status !== 'all') chips.push({ key: 'status', label: statusLabel(f.status) });
    if (f.search) chips.push({ key: 'search', label: `Search “${f.search}”` });
    if (f.text) chips.push({ key: 'text', label: `Merchant or description “${f.text}”` });
    if (f.merchant) {
      chips.push({
        key: 'merchant',
        label: f.merchant === NO_MERCHANT ? 'No merchant from the source' : `Merchant: ${f.merchant}`,
      });
    }
    if (f.account) {
      chips.push({
        key: 'account',
        label: f.account === NO_ACCOUNT ? 'Uncategorized' : `Account: ${name(f.account)}`,
      });
    }
    if (f.type) chips.push({ key: 'type', label: `Type: ${typeLabel(f.type)}` });
    if (f.dateStart || f.dateEnd) {
      chips.push({
        key: 'date',
        label: f.dateStart && f.dateEnd ? `${f.dateStart} to ${f.dateEnd}`
          : f.dateStart ? `From ${f.dateStart}` : `Up to ${f.dateEnd}`,
      });
    }
    if (f.direction !== 'any') {
      chips.push({ key: 'direction', label: f.direction === 'in' ? 'Money in' : 'Money out' });
    }
    const bounds = amountBounds(f);
    if (bounds) {
      chips.push({
        key: 'amount',
        label: bounds.min === bounds.max ? `Amount ${MONEY(bounds.min)}`
          : bounds.min === -Infinity ? `Amount up to ${MONEY(bounds.max)}`
            : bounds.max === Infinity ? `Amount from ${MONEY(bounds.min)}`
              : `Amount ${MONEY(bounds.min)} – ${MONEY(bounds.max)}`,
      });
    }
    return chips;
  }

  /** A copy with one chip's filter cleared. 'all' clears everything. */
  function clear(filters, key) {
    const f = normalize(filters);
    if (!key || key === 'all') return Object.assign({}, EMPTY);
    if (key === 'date') { f.dateStart = ''; f.dateEnd = ''; return f; }
    if (key === 'amount') {
      f.amountMode = 'any'; f.amountExact = ''; f.amountMin = ''; f.amountMax = ''; return f;
    }
    if (key === 'status') { f.status = 'all'; return f; }
    if (key === 'direction') { f.direction = 'any'; return f; }
    if (Object.prototype.hasOwnProperty.call(EMPTY, key)) f[key] = EMPTY[key];
    return f;
  }

  /* What the pickers offer: only values PRESENT in the loaded dataset, so a
     filter can never select an empty screen, plus the two explicit absences
     ("no merchant", "uncategorized") when the data actually has any. Counts
     come along so the picker can say how many rows each choice holds. */
  function options(rows, ctx) {
    const merchants = new Map();
    const accounts = new Map();
    const types = new Map();
    let noMerchant = 0;
    let noAccount = 0;

    for (const row of rows || []) {
      const merchant = merchantOf(row);
      if (merchant) merchants.set(merchant, (merchants.get(merchant) || 0) + 1);
      else noMerchant += 1;

      const pairs = accountPairs(row, ctx);
      if (!pairs.length) noAccount += 1;
      // One row contributes at most one count to each distinct account, so a
      // split with two lines on the same account is not counted twice.
      const seen = new Set();
      for (const pair of pairs) {
        if (seen.has(pair.id)) continue;
        seen.add(pair.id);
        const existing = accounts.get(pair.id);
        accounts.set(pair.id, {
          id: pair.id,
          name: (existing && existing.name) || pair.name || pair.id,
          count: (existing ? existing.count : 0) + 1,
        });
      }

      const type = str(row.accounting_treatment || 'unknown');
      types.set(type, (types.get(type) || 0) + 1);
    }

    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    return {
      merchants: [...merchants].map(([name, count]) => ({ name, count })).sort(byName),
      noMerchant,
      accounts: [...accounts.values()].sort(byName),
      noAccount,
      types: [...types].map(([type, count]) => ({ type, count })).sort((a, b) => a.type.localeCompare(b.type)),
    };
  }

  global.SiloTransactionFilters = {
    EMPTY, NO_MERCHANT, NO_ACCOUNT, STATUSES, DIRECTIONS, AMOUNT_MODES,
    normalize, matches, apply, isActive, describe, clear, options,
    merchantOf, directionOf, accountKeys, accountNames, accountPairs, amountBounds, cents,
  };
})(typeof window === 'undefined' ? globalThis : window);
