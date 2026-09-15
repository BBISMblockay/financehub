/* Split one card or bank transaction across several accounts.
 *
 * WHY THIS IS ITS OWN FILE. transactions.html is already 3,200 lines, and the
 * part of a split that is easy to get wrong is arithmetic, not markup: a
 * $25,187.68 loan payment divided into principal and interest has to total
 * $25,187.68 to the cent or the journal entry silently stops balancing. That
 * arithmetic lives in createSplitModel() below, which touches no DOM at all
 * and is unit tested directly. The drawer is a thin renderer over it.
 *
 * CENTS, NEVER FLOATS. Every amount is held as an integer number of cents.
 * 0.1 + 0.2 is 0.30000000000000004, and a split editor whose running total
 * disagrees with its own lines by a fraction of a cent is worse than no
 * editor -- it makes a correct entry look wrong, and a wrong one look
 * correct. The parent amount is converted once on the way in and every line
 * is compared against it as an integer.
 *
 * AMOUNTS ARE TYPED, NEVER REMEMBERED. A saved split rule stores the ordered
 * ACCOUNTS only. Applying one fills the account, location, entity and memo of
 * each line and leaves every amount box EMPTY, because an amortizing payment
 * divides differently every month and a remembered amount would be wrong by
 * construction while looking authoritative. "Use remainder" exists so the
 * last line is one click rather than mental arithmetic -- it is an explicit
 * action on a number the person can see, not a default.
 */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const money = (cents) => (cents < 0 ? '-' : '') +
    '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /** A stored numeric(14,2) into integer cents. */
  function toCents(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  }

  /** Integer cents back into the string the RPC's numeric cast reads. */
  function centsToFixed(cents) {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  }

  /* What someone types into an amount box.
   *
   * Accepts what a statement actually looks like: "1,234.56", "$1234.56",
   * "(500)" for a credit, a leading "+"/"-", and ".68" with no leading zero
   * (the same leading-decimal shape the QBO ledger archive had to handle).
   * Refuses more than two decimal places rather than rounding them away: a
   * third digit is a typo or a number from somewhere else, and silently
   * rounding it is how a split ties on screen and not on the books.
   *
   * Returns integer cents, or null for anything it will not accept. Null is
   * "not a number", which is a different state from an empty box. */
  function parseAmount(text) {
    if (text === null || text === undefined) return null;
    let s = String(text).trim();
    if (!s) return null;
    let negative = false;
    if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
    s = s.replace(/[$\s]/g, '').replace(/,/g, '');
    if (/^[+-]/.test(s)) { if (s[0] === '-') negative = !negative; s = s.slice(1); }
    if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
    const [whole, frac] = s.split('.');
    if ((frac || '').length > 2) return null;
    const cents = Number(whole || '0') * 100 + Number(((frac || '') + '00').slice(0, 2));
    if (!Number.isSafeInteger(cents)) return null;
    return negative ? -cents : cents;
  }

  const blankLine = () => ({
    qbo_account_id: '', qbo_account_name: '', qbo_location_id: '', qbo_location_name: '',
    entity_qbo_id: '', entity_type: '', entity_name: '', memo: '', amountText: '',
  });

  /* The model. No DOM, no network, no page state -- everything the editor
   * knows how to decide is decided here so it can be tested without either.
   *
   * refs is optional and, where supplied, only adds warnings the RPC would
   * otherwise raise after a round trip: accountType(id) to spot a receivable
   * or payable line missing its entity, and the name lookups so a line shows
   * what it points at. */
  function createSplitModel(parentAmount, initial, refs) {
    const look = refs || {};
    const parent = toCents(parentAmount);
    let lines = (initial && initial.length ? initial : [blankLine(), blankLine()]).map(adopt);

    function adopt(line) {
      const l = Object.assign(blankLine(), line || {});
      // A line loaded from the database carries a real amount; a line from a
      // rule carries null, and null must render as an EMPTY box rather than
      // as a zero somebody could mistake for an entered figure.
      if (l.amountText === '' && l.amount !== null && l.amount !== undefined && l.amount !== '') {
        l.amountText = centsToFixed(toCents(l.amount));
      }
      delete l.amount;
      for (const k of ['qbo_account_id', 'qbo_location_id', 'entity_qbo_id', 'entity_type', 'memo']) {
        l[k] = l[k] == null ? '' : String(l[k]);
      }
      l.qbo_account_name = l.qbo_account_name || (look.accountName ? look.accountName(l.qbo_account_id) || '' : '');
      l.qbo_location_name = l.qbo_location_name || (look.locationName ? look.locationName(l.qbo_location_id) || '' : '');
      l.entity_name = l.entity_name || (look.entityName ? look.entityName(l.entity_type, l.entity_qbo_id) || '' : '');
      return l;
    }

    const api = {
      parentCents: parent,
      lines: () => lines,
      count: () => lines.length,

      add() { lines.push(blankLine()); return api; },

      remove(index) {
        if (index < 0 || index >= lines.length) return api;
        lines.splice(index, 1);
        return api;
      },

      set(index, field, value) {
        const l = lines[index];
        if (!l) return api;
        if (field === 'account') {
          l.qbo_account_id = value || '';
          l.qbo_account_name = look.accountName ? look.accountName(value) || '' : '';
          // An account that does not take an entity should not keep one that
          // was set while a receivable was selected.
          if (l.entity_qbo_id && look.accountType && !needsEntity(look.accountType(value))) {
            l.entity_qbo_id = ''; l.entity_type = ''; l.entity_name = '';
          }
        } else if (field === 'location') {
          l.qbo_location_id = value || '';
          l.qbo_location_name = look.locationName ? look.locationName(value) || '' : '';
        } else if (field === 'entity') {
          const [type, id] = String(value || '').split(':');
          l.entity_type = id ? type : ''; l.entity_qbo_id = id || '';
          l.entity_name = id && look.entityName ? look.entityName(type, id) || '' : '';
        } else if (field === 'memo') {
          l.memo = value == null ? '' : String(value);
        } else if (field === 'amount') {
          l.amountText = value == null ? '' : String(value);
        }
        return api;
      },

      /* Apply a learned shape. Amounts are NOT carried: a rule has none, and
       * anything already typed is discarded along with the old lines so the
       * person is never left with an amount that belonged to a different
       * account. */
      applyShape(shapeLines) {
        const shape = (shapeLines || []).slice().sort((a, b) => (a.line_no || 0) - (b.line_no || 0));
        if (!shape.length) return api;
        lines = shape.map((s) => adopt({
          qbo_account_id: s.qbo_account_id, qbo_account_name: s.qbo_account_name,
          qbo_location_id: s.qbo_location_id, qbo_location_name: s.qbo_location_name,
          entity_qbo_id: s.entity_qbo_id, entity_type: s.entity_type,
          memo: s.memo || s.memo_template || '', amountText: '',
        }));
        return api;
      },

      /** Cents entered so far, ignoring boxes that are empty or unreadable. */
      enteredCents() {
        return lines.reduce((n, l) => {
          const c = l.amountText.trim() === '' ? null : parseAmount(l.amountText);
          return n + (c === null ? 0 : c);
        }, 0);
      },

      /** What is left of the transaction once the readable boxes are counted. */
      remainderCents() {
        return parent === null ? null : parent - api.enteredCents();
      },

      /* Put the unallocated remainder on one line. Refuses to write a zero:
       * a zero line is an account somebody meant to delete, and the database
       * refuses it too. */
      useRemainder(index) {
        const l = lines[index];
        if (!l || parent === null) return { ok: false, error: 'This transaction has no readable amount.' };
        const others = lines.reduce((n, other, i) => {
          if (i === index) return n;
          const c = other.amountText.trim() === '' ? null : parseAmount(other.amountText);
          return n + (c === null ? 0 : c);
        }, 0);
        const rest = parent - others;
        if (rest === 0) {
          return { ok: false, error: 'The other lines already account for the whole transaction; there is nothing left for this one.' };
        }
        l.amountText = centsToFixed(rest);
        return { ok: true, cents: rest };
      },

      /* Every reason this split cannot be saved, in the order a person would
       * fix them. Problems are strings a person can act on, never codes. */
      problems() {
        const out = [];
        if (parent === null) out.push('This transaction has no readable amount to split.');
        if (lines.length < 2) out.push('A split needs at least two lines. Code it to one account instead.');
        lines.forEach((l, i) => {
          const n = i + 1;
          if (!l.qbo_account_id) out.push(`Line ${n} needs an account.`);
          const raw = l.amountText.trim();
          if (raw === '') out.push(`Line ${n} needs an amount. Enter it from the statement.`);
          else {
            const c = parseAmount(raw);
            if (c === null) out.push(`Line ${n}'s amount "${raw}" is not a number SILO can read. Use a figure like 1,234.56.`);
            else if (c === 0) out.push(`Line ${n} is zero. Remove the line instead of coding nothing to it.`);
          }
          if (l.qbo_account_id && look.accountType && needsEntity(look.accountType(l.qbo_account_id)) && !l.entity_qbo_id) {
            out.push(`Line ${n} is on a receivable or payable account, so QuickBooks needs a customer or vendor on it.`);
          }
        });
        const remainder = api.remainderCents();
        if (parent !== null && remainder !== 0 && !lines.some((l) => l.amountText.trim() !== '' && parseAmount(l.amountText) === null)) {
          out.push(remainder > 0
            ? `${money(remainder)} of this transaction is not allocated yet. The lines must total ${money(parent)}.`
            : `The lines are over by ${money(-remainder)}. They must total ${money(parent)}.`);
        }
        return out;
      },

      ready() { return api.problems().length === 0; },

      /* What set_card_transaction_splits reads. Amounts go as fixed-point
       * strings, not JS numbers: the RPC casts to numeric(14,2) and a float
       * that prints as 25187.680000000001 would be a different number. */
      payload() {
        return lines.map((l) => ({
          amount: centsToFixed(parseAmount(l.amountText)),
          qbo_account_id: l.qbo_account_id,
          qbo_location_id: l.qbo_location_id || null,
          entity_qbo_id: l.entity_qbo_id || null,
          entity_type: l.entity_qbo_id ? l.entity_type : null,
          memo: l.memo || null,
        }));
      },
    };
    return api;
  }

  const NEEDS_ENTITY = new Set(['Accounts Receivable', 'Accounts Payable']);
  const needsEntity = (accountType) => NEEDS_ENTITY.has(accountType || '');

  /* The journal lines a transaction contributes to the entry preview: its
   * split lines when it is split, otherwise itself. This mirrors the
   * card_coding_effective_lines view, and it exists for the same reason --
   * the preview and the posted entry must be one definition, or a split row
   * quietly disappears from the preview while still posting. */
  function effectiveLines(txn, splits) {
    const rows = splits && splits.length ? splits : null;
    if (!rows) return [{
      amount: Number(txn.amount), qbo_account_id: txn.qbo_account_id, qbo_account_name: txn.qbo_account_name,
      qbo_location_id: txn.qbo_location_id, qbo_location_name: txn.qbo_location_name,
      entity_qbo_id: txn.entity_qbo_id, entity_type: txn.entity_type, entity_name: txn.entity_name,
      memo: txn.memo, is_split: false, line_no: 1,
    }];
    return rows.slice().sort((a, b) => a.line_no - b.line_no).map((s) => ({
      amount: Number(s.amount), qbo_account_id: s.qbo_account_id, qbo_account_name: s.qbo_account_name,
      qbo_location_id: s.qbo_location_id, qbo_location_name: s.qbo_location_name,
      entity_qbo_id: s.entity_qbo_id, entity_type: s.entity_type, entity_name: s.entity_name,
      memo: s.memo, is_split: true, line_no: s.line_no,
    }));
  }

  /** The one-line label a split row shows where an account name would be. */
  function describe(splits) {
    const n = (splits || []).length;
    if (!n) return '';
    const names = splits.slice().sort((a, b) => a.line_no - b.line_no)
      .map((s) => s.qbo_account_name || s.qbo_account_id).filter(Boolean);
    return `Split · ${n} accounts — ${names.join(', ')}`;
  }

  // ─────────────────────────────────────────────────────────── the drawer

  let active = null;

  function render(ctx) {
    const { el, model, options } = ctx;
    const lines = model.lines();
    el('splitLines').innerHTML = lines.map((l, i) => `
      <tr data-line="${i}">
        <td class="txn-split-no">${i + 1}</td>
        <td><select class="bcn-field bcn-field--mono" data-field="account" data-selected="${esc(l.qbo_account_id)}" aria-label="Line ${i + 1} account"><option value="">— choose an account —</option>${options.accounts}</select></td>
        <td><select class="bcn-field" data-field="location" data-selected="${esc(l.qbo_location_id)}" aria-label="Line ${i + 1} location"><option value="">— account default —</option>${options.locations}</select></td>
        <td><select class="bcn-field" data-field="entity" data-selected="${esc(l.entity_qbo_id ? l.entity_type + ':' + l.entity_qbo_id : '')}" aria-label="Line ${i + 1} customer or vendor"><option value="">— none —</option>${options.entities}</select></td>
        <td><input class="bcn-field" data-field="memo" value="${esc(l.memo)}" placeholder="Memo" aria-label="Line ${i + 1} memo" /></td>
        <td class="num"><input class="bcn-field bcn-field--mono txn-split-amount" data-field="amount" inputmode="decimal" value="${esc(l.amountText)}" placeholder="0.00" aria-label="Line ${i + 1} amount" /></td>
        <td class="txn-split-acts">
          <button type="button" class="bcn-btn" data-remainder title="Put the unallocated remainder on this line">Remainder</button>
          <button type="button" class="bcn-btn" data-drop ${lines.length <= 2 ? 'disabled title="A split needs at least two lines"' : ''} aria-label="Remove line ${i + 1}">Remove</button>
        </td>
      </tr>`).join('');
    // The selects are built from the cached option HTML, so the stored value
    // is applied afterwards -- and a value QuickBooks no longer offers is
    // shown as itself rather than silently collapsing to blank.
    for (const field of el('splitLines').querySelectorAll('[data-selected]') || []) {
      const want = field.dataset.selected || '';
      field.value = want;
      if (want && field.value !== want) {
        field.insertAdjacentHTML('afterbegin', `<option value="${esc(want)}">⚠ ${esc(want)} — not in QuickBooks</option>`);
        field.value = want;
      }
    }
    renderTotals(ctx);
  }

  function renderTotals(ctx) {
    const { el, model } = ctx;
    const remainder = model.remainderCents();
    const problems = model.problems();
    el('splitTotals').innerHTML = `
      <div class="txn-split-total"><span>Transaction</span><b>${esc(money(model.parentCents ?? 0))}</b></div>
      <div class="txn-split-total"><span>Lines</span><b>${esc(money(model.enteredCents()))}</b></div>
      <div class="txn-split-total ${remainder === 0 ? 'is-tied' : 'is-open'}"><span>${remainder === 0 ? 'Allocated' : 'Left to allocate'}</span><b>${esc(remainder === 0 ? 'ties' : money(remainder))}</b></div>`;
    el('splitProblems').innerHTML = problems.length
      ? '<ul>' + problems.map((p) => `<li>${esc(p)}</li>`).join('') + '</ul>' : '';
    el('splitProblems').hidden = !problems.length;
    el('btnSplitSave').disabled = !!ctx.busy || !model.ready();
    el('btnSplitAdd').disabled = !!ctx.busy;
    el('btnSplitClear').disabled = !!ctx.busy || !ctx.hadSplits;
  }

  function say(ctx, message, kind) {
    const node = ctx.el('splitStatus');
    node.className = `bcn-status bcn-status--${kind || 'info'}`;
    node.textContent = message || '';
    node.hidden = !message;
  }

  function close(ctx) {
    ctx.el('splitDrawer').hidden = true;
    active = null;
  }

  /* Open the editor for one transaction.
   *
   * db        the supabase client
   * txn       the card_transactions row
   * splits    its stored split lines ([] when it is not split yet)
   * options   { accounts, locations, entities } -- cached <option> HTML from
   *           the page, so 450 accounts are not re-serialised per line
   * refs      { accountName, accountType, locationName, entityName }
   * onSaved   called with the RPC result once the database has accepted it
   */
  function open(config) {
    const el = config.el || ((id) => document.getElementById(id));
    const model = createSplitModel(config.txn.amount, config.splits && config.splits.length
      ? config.splits.map((s) => ({ ...s, amount: s.amount }))
      : null, config.refs);
    const ctx = {
      el, model, options: config.options || { accounts: '', locations: '', entities: '' },
      db: config.db, txn: config.txn, onSaved: config.onSaved,
      hadSplits: !!(config.splits && config.splits.length), busy: false,
    };
    active = ctx;

    el('splitDrawer').hidden = false;
    el('splitSub').textContent = `${config.txn.txn_date || ''} · ${config.txn.description || ''} · ${money(toCents(config.txn.amount) ?? 0)}`;
    el('splitLearn').checked = false;
    say(ctx, ctx.hadSplits
      ? 'Change the accounts or the amounts. The lines must still total the transaction.'
      : 'Enter each account and the amount from the statement. Amounts are never filled in for you.', 'info');
    render(ctx);

    // A saved shape is offered only for a transaction that is not split yet,
    // and only when nothing has been typed. Overwriting typed lines with a
    // rule would throw away the part nobody can reconstruct.
    if (!ctx.hadSplits) loadSuggestion(ctx, false);
    return ctx;
  }

  async function loadSuggestion(ctx, explicit) {
    try {
      const { data, error } = await ctx.db.rpc('suggest_card_transaction_splits', { p_transaction_id: ctx.txn.id });
      if (error) throw new Error(error.message);
      if (active !== ctx) return;
      if (data && data.conflict) {
        say(ctx, data.reason || 'A merchant rule and a card rule split this differently; neither is applied. Enter the lines yourself.', 'info');
        return;
      }
      const shape = (data && data.lines) || [];
      if (!shape.length) {
        if (explicit) say(ctx, 'No saved split matches this merchant or card yet. Save one below and it will be offered next time.', 'info');
        return;
      }
      if (!explicit && ctx.model.lines().some((l) => l.qbo_account_id || l.amountText.trim())) return;
      ctx.model.applyShape(shape);
      render(ctx);
      say(ctx, `Saved split applied — ${shape.length} accounts. Enter each amount from the statement; a saved split never remembers amounts.`, 'pos');
    } catch (e) {
      if (active === ctx && explicit) say(ctx, `The saved split could not be read — ${e.message}`, 'neg');
    }
  }

  /* Write the split set, then hand the result back to the page.
   *
   * The two halves report differently ON PURPOSE. If the RPC refuses, nothing
   * was written and the drawer stays open to be corrected. If the RPC accepts
   * and the page's refresh then fails, the split IS saved -- telling someone
   * it was not would send them to re-enter a split that already exists, and
   * the second attempt would be the one that looks like a duplicate. */
  async function write(ctx, splits, learn, match, verb) {
    if (ctx.busy) return;
    ctx.busy = true; renderTotals(ctx);
    say(ctx, verb === 'removed' ? 'Removing the split…' : 'Saving the split…', 'info');
    let data;
    try {
      const result = await ctx.db.rpc('set_card_transaction_splits', {
        p_transaction_id: ctx.txn.id, p_splits: splits, p_learn_rule: learn, p_rule_match: match,
      });
      if (result.error) throw new Error(result.error.message);
      data = result.data;
    } catch (e) {
      ctx.busy = false; renderTotals(ctx);
      say(ctx, `The split was not ${verb} — ${e.message}`, 'neg');
      return;
    }
    try {
      if (ctx.onSaved) await ctx.onSaved(data, ctx.txn);
    } catch (e) {
      ctx.busy = false; renderTotals(ctx);
      say(ctx, `The split was ${verb}, but this page could not reload it — ${e.message}. Reload the page before approving the entry.`, 'neg');
      return;
    }
    if (active === ctx) close(ctx);
  }

  const save = (ctx) => ctx.model.ready()
    ? write(ctx, ctx.model.payload(), !!ctx.el('splitLearn').checked, ctx.el('splitMatch').value || 'merchant', 'saved')
    : undefined;
  const clearSplit = (ctx) => write(ctx, [], false, 'merchant', 'removed');

  /* Wire the drawer's fixed controls once. The page calls this after the
   * markup exists; every handler no-ops while no transaction is open. */
  function mount(config) {
    const el = (config && config.el) || ((id) => document.getElementById(id));
    const on = (id, event, fn) => el(id).addEventListener(event, fn);

    el('splitLines').addEventListener('input', (e) => {
      if (!active) return;
      const row = e.target.closest('[data-line]');
      if (!row || !e.target.dataset.field) return;
      active.model.set(Number(row.dataset.line), e.target.dataset.field, e.target.value);
      renderTotals(active);
    });
    el('splitLines').addEventListener('change', (e) => {
      if (!active) return;
      const row = e.target.closest('[data-line]');
      if (!row || !e.target.dataset.field) return;
      active.model.set(Number(row.dataset.line), e.target.dataset.field, e.target.value);
      renderTotals(active);
    });
    el('splitLines').addEventListener('click', (e) => {
      if (!active || active.busy) return;
      const row = e.target.closest('[data-line]');
      if (!row) return;
      const index = Number(row.dataset.line);
      if (e.target.closest('[data-remainder]')) {
        const result = active.model.useRemainder(index);
        if (!result.ok) return say(active, result.error, 'neg');
        render(active);
        say(active, `Line ${index + 1} set to the remaining ${money(result.cents)}. Check it against the statement.`, 'info');
        return;
      }
      if (e.target.closest('[data-drop]')) {
        if (active.model.count() <= 2) return say(active, 'A split needs at least two lines. Remove the split entirely if this is one account.', 'neg');
        active.model.remove(index);
        render(active);
      }
    });

    on('btnSplitAdd', 'click', () => { if (active && !active.busy) { active.model.add(); render(active); } });
    on('btnSplitSuggest', 'click', () => { if (active && !active.busy) loadSuggestion(active, true); });
    on('btnSplitSave', 'click', () => { if (active) save(active); });
    on('btnSplitClear', 'click', () => { if (active) clearSplit(active); });
    on('btnSplitClose', 'click', () => { if (active && !active.busy) close(active); });
  }

  window.SiloCardSplits = {
    mount, open, close: () => { if (active) close(active); },
    isOpen: () => !!active,
    createSplitModel, parseAmount, toCents, centsToFixed, effectiveLines, describe, needsEntity,
  };
})();
