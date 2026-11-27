/* QuickBooks sync.

   One list of everything SILO sends to QuickBooks -- every card and bank month
   and every journal entry -- each in exactly one state a person can act on:
   Synced, Waiting, or Needs a fix. The screen opens on what is left to do;
   a person ticks rows and one button sends the ticked ones. Nothing unticked
   is ever sent or marked.

   This file adds NO accounting logic and NO new write path:
     - a month's entry is built by card_import_batch_preview(), which runs the
       real approval and rolls it back, so a refusal is known BEFORE anything
       is frozen or sent;
     - it is frozen by approve_reviewed_card_import_batch(batch, hash), refused
       if the entry is not the one just previewed;
     - it is sent by quickbooks-post-journal with expected_approval_hash, which
       claims before it calls Intuit and so cannot post twice.
   Those are the calls On Deck and Transactions already make, one entry at a
   time. This runs them in a row and reports each outcome.

   Three rules that are easy to get wrong, each from docs/ops:
     - An unconfirmed send outranks everything. It lives on the claim, never on
       the batch (transactions-quickbooks-state.md).
     - "Not sent" is never "not in QuickBooks": SILO knows only what it sent.
     - A month that has not ended is not sent. Sending freezes its rows, and the
       month is still filling.

   Pure decisions are exported for unit tests; mount() draws them. */
(function () {
  'use strict';

  const ACTIVE_CLAIM = ['submitting', 'unknown'];
  const KIND_LABEL = {
    journal_adjustment: 'Journal entry', manual_adjustment: 'Journal entry',
    prepaid_amortization: 'Prepaid amortization', fixed_asset_depreciation: 'Depreciation',
    shopify_monthly: 'Sales journal', card_transaction_reclass: 'Category change',
  };
  const STATUS_LABEL = { synced: 'Synced', waiting: 'Waiting', fix: 'Needs a fix', open: 'Open month', outside: 'Not sent by SILO' };

  const known = (v) => Array.isArray(v);
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const howMany = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function money(value) {
    const n = num(value);
    return n === null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function monthName(key) {
    if (!/^\d{4}-\d{2}$/.test(key || '')) return 'No date';
    return new Date(`${key}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  /* What a refusal means to the person reading it. QuickBooks' own fault text
     is never shown raw: it names fields, not what to do. */
  function friendly(message) {
    const raw = String(message || '').trim();
    if (!raw) return 'QuickBooks did not accept this entry.';
    if (/Accounts Payable[^.]*vendor/i.test(raw)) return 'A line on Accounts Payable has no vendor. Open the row and pick who was paid.';
    if (/Accounts Receivable[^.]*customer/i.test(raw)) return 'A line on Accounts Receivable has no customer. Open the row and pick who paid.';
    if (/posting is disabled|sending.*off/i.test(raw)) return 'Sending to QuickBooks is switched off for this account.';
    if (/connection (changed|is not active|does not match)|environment_mismatch|not active/i.test(raw)) return 'The QuickBooks connection changed or is not active. Check it in Books & setup.';
    if (/reapproved|changed after (approval|you reviewed)|APPROVAL_CHANGED/i.test(raw)) return 'This entry changed while it was syncing. Sync again.';
    if (/bank change|feed exception|bank_change/i.test(raw)) return 'The bank changed a transaction after this month was approved. Resolve it in Transactions.';
    if (/Finance access/i.test(raw)) return 'Sending to QuickBooks needs finance access.';
    const detail = raw.match(/"Detail"\s*:\s*"([^"]+)"/);
    const text = (detail ? detail[1] : raw).replace(/^Business Validation Error:\s*/i, '').replace(/^post_failed_\d+:\s*/i, '');
    return text.length > 220 ? `${text.slice(0, 217)}…` : text;
  }
  // A refusal QuickBooks will repeat for the same entry: sending it again
  // unchanged cannot work, so it is not offered.
  const isValidationFailure = (message) => /ValidationFault|Business Validation|post_failed_4\d\d/i.test(String(message || ''));

  const MODES = ['silo', 'qbo'];
  const QBO_KEEPS = 'QuickBooks keeps the books for this company, so SILO sends nothing.';
  const MODE_UNREAD = 'Could not read who keeps this company’s books. Refresh before syncing.';

  const BY_HAND = 'Entered in QuickBooks by hand.';
  const BY_HAND_UNREAD = 'Could not read which entries were entered in QuickBooks by hand. Refresh before syncing.';
  const BY_HAND_CHANGED = 'Changed since it was marked as entered by hand. Send it, or mark it again.';
  /* A person's statement that an entry is already in QuickBooks
     (quickbooks_entered_by_hand, 20261125130000). `facts.byHand` is the list,
     null where the database does not have the feature yet, undefined where it
     could not be read -- and then nothing is called sendable.
     A mark speaks for the content it was made on (`snapshot`). `now` is what
     the entry holds today: a month's own fingerprint comes with the mark
     (`current`), a journal entry's is its approval hash. 'current' = still
     speaks for it; 'stale' = the entry changed, so a person decides again. */
  function byHandMark(facts, source, ref, now) {
    if (!known(facts.byHand)) return null;
    const h = facts.byHand.find((m) => m.source === source && String(m.source_ref) === String(ref));
    if (!h) return null;
    const is = now === undefined ? h.current : now;
    return h.snapshot && is && h.snapshot === is ? 'current' : 'stale';
  }

  function claimsFor(claims, source, ref) {
    if (!known(claims) || !source || !ref) return [];
    return claims.filter((c) => c.source === source && String(c.source_ref) === String(ref));
  }

  /* One card or bank month. `facts.claims === undefined` means the claims
     could not be read: nothing may then be called sendable or not sent. */
  function classifyBatch(b, facts) {
    const end = b.period_end || b.entry_date || b.period_start || null;
    const item = {
      key: `batch:${b.id}`, kind: 'batch', id: b.id, month: end ? String(end).slice(0, 7) : null,
      title: b.source_name || 'Account', detail: b.label || '', amount: num(b.coded_amount),
      hash: b.approval_hash || null, sendable: false, defaultSelected: true,
      href: `/v2/transactions.html?batch=${encodeURIComponent(b.id)}&company=${encodeURIComponent(facts.companyId || '')}`,
      hrefLabel: 'Open in Transactions',
    };
    const set = (status, reason, extra) => Object.assign(item, { status, reason: reason || '' }, extra || {});
    const mine = claimsFor(facts.claims, 'card_import', b.id);

    if (!known(facts.claims)) return set('fix', 'Could not read what was already sent. Refresh before syncing.', { unreadable: true });
    if (!MODES.includes(facts.mode)) return set('fix', MODE_UNREAD, { unreadable: true });
    if (mine.some((c) => ACTIVE_CLAIM.includes(c.status))) {
      return set('fix', 'A send went out and QuickBooks never confirmed it. SILO has locked it so it cannot go twice. Check QuickBooks, then resolve it in Transactions.');
    }
    if (b.status === 'posted') {
      return set('synced', b.qbo_doc_number || b.qbo_journal_entry_id ? `QuickBooks entry ${b.qbo_doc_number || b.qbo_journal_entry_id}` : '');
    }
    if (facts.byHand === undefined) return set('fix', BY_HAND_UNREAD, { unreadable: true });
    const marked = byHandMark(facts, 'card_import', b.id);
    if (marked === 'current') return set('synced', BY_HAND, { byHand: true });
    if (marked === 'stale') item.staleMark = true;
    const uncoded = num(b.uncoded_count) || 0;
    const live = (num(b.txn_count) || 0) - (num(b.excluded_count) || 0);
    if (live <= 0) return null;                       // nothing in it to send
    if (!['draft', 'categorized', 'approved'].includes(b.status)) return null;
    // Reporting-only: nothing is SILO's to send. An approved month left over
    // from before the switch is listed, never offered.
    if (facts.mode === 'qbo') return b.status === 'approved' ? set('outside', QBO_KEEPS) : null;
    if (b.source_posting_start_on && end && end < b.source_posting_start_on) {
      return set('outside', 'Handled outside SILO. This month ended before SILO started sending this account.');
    }
    if (b.source_posting_enabled === false) return set('outside', 'In SILO’s books. Sending to QuickBooks is switched off for this account.');
    const ended = Boolean(end && facts.today && end < facts.today);
    if (uncoded > 0) {
      return ended
        ? set('fix', `${plural(uncoded, 'transaction')} still to categorize.`)
        : set('open', `${plural(uncoded, 'transaction')} to categorize. Syncs after the month ends.`);
    }
    const blocked = known(facts.ledger) ? facts.ledger.find((s) => s.batch_id === b.id && s.unrecorded > 0) : null;
    if (blocked) return set('fix', `${plural(blocked.unrecorded, 'categorized transaction')} cannot be recorded: ${blocked.reason || 'check the row'}.`);
    if (!ended) return set('open', 'Every transaction so far is categorized. Syncs after the month ends.');
    if (b.status === 'approved') {
      const failed = mine.filter((c) => c.status === 'failed' && c.payload_hash && c.payload_hash === b.approval_hash)
        .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))[0];
      if (failed && isValidationFailure(failed.error_message)) {
        return set('fix', `${friendly(failed.error_message)} Reopen the month in Transactions to change it.`);
      }
      if (mine.some((c) => c.status === 'voided' && c.payload_hash && c.payload_hash === b.approval_hash)) {
        return set('waiting', 'Sent before, then marked unposted. Send it again only if it is no longer in QuickBooks.', { sendable: true, defaultSelected: false });
      }
      return set('waiting', failed ? `Last try failed: ${friendly(failed.error_message)}` : 'Approved. Goes out on the next sync.', { sendable: true });
    }
    return set('waiting', 'Categorized. Goes out on the next sync.', { sendable: true });
  }

  function classifyAdjustment(a, facts) {
    const source = a.accounting_source || 'journal_adjustment';
    const ref = a.accounting_source_ref || a.id;
    const item = {
      key: `adjustment:${a.id}`, kind: 'adjustment', id: a.id, month: a.entry_date ? String(a.entry_date).slice(0, 7) : null,
      title: KIND_LABEL[source] || 'Journal entry', detail: a.memo || '', amount: num(a.debits),
      hash: a.approval_hash || null, sendable: false, defaultSelected: true,
      href: '/v2/accounting-books.html#register', hrefLabel: 'Open journal register',
    };
    const set = (status, reason, extra) => Object.assign(item, { status, reason: reason || '' }, extra || {});
    const mine = claimsFor(facts.claims, source, ref);

    if (!known(facts.claims)) return set('fix', 'Could not read what was already sent. Refresh before syncing.', { unreadable: true });
    if (!MODES.includes(facts.mode)) return set('fix', MODE_UNREAD, { unreadable: true });
    if (mine.some((c) => ACTIVE_CLAIM.includes(c.status))) {
      return set('fix', 'A send went out and QuickBooks never confirmed it. Check QuickBooks, then resolve it in the journal register.');
    }
    if (a.status === 'posted') return set('synced', a.qbo_doc_number ? `QuickBooks entry ${a.qbo_doc_number}` : '');
    if (facts.byHand === undefined) return set('fix', BY_HAND_UNREAD, { unreadable: true });
    const marked = a.status === 'approved' ? byHandMark(facts, source, ref, a.approval_hash || null) : null;
    if (marked === 'current') return set('synced', BY_HAND, { byHand: true });
    if (marked === 'stale') item.staleMark = true;
    if (a.status === 'draft') return facts.mode === 'qbo' ? null : set('fix', 'Draft. Review and approve it before it can sync.');
    if (a.status !== 'approved') return null;
    if (facts.mode === 'qbo') return set('outside', QBO_KEEPS);
    if (!a.approval_hash) return set('fix', 'This approval is older than the sending controls. Reopen it and approve it again.');
    const failed = mine.filter((c) => c.status === 'failed' && c.payload_hash === a.approval_hash)
      .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))[0];
    if (failed && isValidationFailure(failed.error_message)) return set('fix', `${friendly(failed.error_message)} Reopen the entry to change it.`);
    if (mine.some((c) => c.status === 'voided' && c.payload_hash === a.approval_hash)) {
      return set('waiting', 'Sent before, then marked unposted. Send it again only if it is no longer in QuickBooks.', { sendable: true, defaultSelected: false });
    }
    return set('waiting', failed ? `Last try failed: ${friendly(failed.error_message)}` : 'Approved. Goes out on the next sync.', { sendable: true });
  }

  /* Everything, newest month first. A list that could not be read stays
     unknown (null) rather than becoming an empty, all-green page. */
  function classify(facts) {
    if (!known(facts.batches) || !known(facts.adjustments)) return null;
    const items = [];
    for (const b of facts.batches) { const i = classifyBatch(b, facts); if (i) items.push(i); }
    for (const a of facts.adjustments) { const i = classifyAdjustment(a, facts); if (i) items.push(i); }
    // Anything SILO would send can instead be marked as already there -- only
    // where the database can hold the mark.
    for (const i of items) {
      i.canMark = known(facts.byHand) && i.status === 'waiting' && i.sendable === true;
      // The mark was for different content: offered, never pre-ticked.
      if (i.staleMark && i.canMark) { i.defaultSelected = false; i.reason = BY_HAND_CHANGED; }
    }
    const rank = { fix: 0, waiting: 1, open: 2, synced: 3, outside: 4 };
    return items.sort((x, y) => String(y.month || '').localeCompare(String(x.month || ''))
      || (rank[x.status] - rank[y.status]) || x.title.localeCompare(y.title) || x.key.localeCompare(y.key));
  }

  /* The bar counts only what SILO is responsible for sending and could send:
     an open month and an account SILO does not send are listed, not scored. */
  function summarize(items) {
    const count = (s) => (items || []).filter((i) => i.status === s).length;
    const synced = count('synced'); const waiting = count('waiting'); const fix = count('fix');
    const total = synced + waiting + fix;
    return { synced, waiting, fix, open: count('open'), outside: count('outside'), total,
      sendable: (items || []).filter((i) => i.sendable).length,
      percent: total ? Math.floor((synced / total) * 100) : null, allGreen: total > 0 && synced === total };
  }

  /* What a posting response means. Mirrors SiloOnDeckCoding.postOutcome. */
  function postOutcome(status, body) {
    const b = body || {};
    if (status >= 200 && status < 300 && (b.ok || b.recovered)) return { kind: 'posted' };
    if (b.code === 'APPROVAL_CHANGED') return { kind: 'changed', message: b.error };
    if (status === 409 && /already posted/i.test(b.error || '')) return { kind: 'posted' };
    if (b.code === 'UNKNOWN_OUTCOME' || b.code === 'LOCAL_PERSISTENCE_FAILURE' || status === 0 || status >= 500) return { kind: 'unknown', message: b.error };
    return { kind: 'error', message: b.error || `Sending failed (HTTP ${status}).` };
  }

  /* Send the chosen entries one at a time. api: { preview(id), approve(id,
     hash), post(body) -> {status, body}, stillActive() }. Each entry is
     independent, so a refusal moves on to the next. An UNKNOWN outcome stops
     the run: it usually means the connection is in trouble, and every further
     send would be another entry to untangle by hand. */
  async function run(items, api, onProgress) {
    const outcomes = [];
    let stopped = null;
    const say = (i, item, phase) => { if (onProgress) onProgress({ index: i, total: items.length, item, phase, outcomes }); };
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const done = (status, reason, extra) => { outcomes.push({ key: item.key, status, reason: reason || '', ...(extra || {}) }); say(i + 1, item, 'done'); };
      say(i, item, 'checking');
      try {
        await api.stillActive();
        let hash = item.hash;
        if (item.kind === 'batch') {
          const p = await api.preview(item.id);
          if (!p || p.status === 'posted') { done('synced', 'Already in QuickBooks.'); continue; }
          if (!p.ready || p.blocker || !p.hash) { done('fix', friendly(p.blocker || 'This month’s entry could not be built.')); continue; }
          if (!p.can_post) { done('fix', friendly(p.posting_enabled === false ? 'Posting is disabled' : 'Finance access required')); continue; }
          hash = p.hash;
          if (p.status === 'draft' || p.status === 'categorized') {
            say(i, item, 'approving');
            await api.approve(item.id, hash);
          }
        }
        if (!hash) { done('fix', 'This approval is older than the sending controls. Reopen it and approve it again.'); continue; }
        say(i, item, 'sending');
        const res = await api.post(item.kind === 'batch'
          ? { batch_id: item.id, expected_approval_hash: hash }
          : { adjustment_id: item.id, expected_approval_hash: hash });
        const o = postOutcome(res.status, res.body);
        if (o.kind === 'posted') {
          done('synced', (res.body && (res.body.doc_number || res.body.qbo_journal_entry_id)) ? `QuickBooks entry ${res.body.doc_number || res.body.qbo_journal_entry_id}` : 'In QuickBooks.',
            { warning: res.body && res.body.warning ? res.body.warning : null });
        } else if (o.kind === 'unknown') {
          done('fix', 'QuickBooks did not confirm this send. SILO has locked it so it cannot go twice. Check QuickBooks before syncing again.', { unknown: true });
          stopped = 'unknown'; break;
        } else {
          done('fix', friendly(o.message));
        }
      } catch (e) {
        if (e && e.code === 'COMPANY_CHANGED') { done('waiting', 'Stopped: the active company changed.'); stopped = 'company'; break; }
        done('fix', friendly(e && e.message));
      }
    }
    return { outcomes, stopped, sent: outcomes.filter((o) => o.status === 'synced').length, failed: outcomes.filter((o) => o.status === 'fix').length };
  }

  /* After the page loads: ask the database to build each waiting month's entry
     (and roll it back) so a refusal shows as Needs a fix before anyone presses
     Sync. Bounded, sequential, and never fatal: a failed check leaves the row
     as it was. */
  async function precheck(items, api, onChange, limit = 12) {
    const todo = items.filter((i) => i.kind === 'batch' && i.sendable).slice(0, limit);
    for (const item of todo) {
      try {
        const p = await api.preview(item.id);
        if (p && (p.blocker || p.ready === false) && p.status !== 'posted') {
          Object.assign(item, { status: 'fix', sendable: false, reason: friendly(p.blocker || 'This month’s entry could not be built.') });
          if (onChange) onChange(item);
        }
      } catch (_) { /* the Sync run will report it */ }
    }
  }

  /* The screen's three parts. To do is what a person can act on now. An open
     month or one SILO does not send is not a task, so it leaves the list. What
     is in QuickBooks is one line per month, newest first. */
  function sections(items) {
    const list = items || [];
    const months = [];
    for (const i of list.filter((x) => x.status === 'synced')) {
      let m = months[months.length - 1];
      if (!m || m.month !== i.month) { m = { month: i.month, items: [] }; months.push(m); }
      m.items.push(i);
    }
    return {
      todo: list.filter((i) => i.status === 'fix' || i.status === 'waiting'),
      later: list.filter((i) => i.status === 'open' || i.status === 'outside'),
      months,
    };
  }

  /* The rows an action applies to: ticked by a person AND still allowed. A
     tick outlives a refresh only by its key, so a row that stopped being
     sendable in the meantime drops out here. */
  function chosen(items, ticked, action) {
    const keys = ticked instanceof Set ? ticked : new Set(ticked || []);
    return (items || []).filter((i) => keys.has(i.key) && (action === 'mark' ? i.canMark === true : i.sendable === true));
  }

  /* Does QuickBooks still hold what SILO sent? The database answers per
     entry (quickbooks_sent_entries_check_v, 20261125235000): 'as_sent',
     'changed' (edited, moved or deleted in QuickBooks), 'settled' (changed,
     and a person accepted QuickBooks' version) or 'unread' (no read-back
     reaches it yet). This folds those rows into one verdict a month.

     month -> { state, entries, unread, changed, settled, amount, through,
     open }. A month is judged only where QuickBooks has been read back for it;
     any other month has no entry here and the screen says nothing about it.
     "agree" is said of a whole month, so it needs EVERY entry SILO posted in
     it to have been compared: one that no read reaches yet makes the month
     'partial'. A difference still open always shows. Anything unreadable or
     not understood is no verdict, never "agree". */
  const ENTRY_STATUS = ['as_sent', 'changed', 'settled', 'unread'];
  function agreement(periods, entries) {
    const out = {};
    if (!known(periods) || !known(entries)) return out;
    for (const p of periods) {
      const month = String(p.period_start || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month) || !p.read_through) continue;
      if (!out[month] || String(p.read_through) < out[month].through) {
        out[month] = { state: 'agree', entries: 0, unread: 0, changed: 0, settled: 0, amount: 0, through: String(p.read_through), open: [] };
      }
    }
    const spoiled = new Set();
    for (const e of entries) {
      const month = String(e.entry_date || '').slice(0, 7);
      const m = out[month];
      if (!m) continue;
      const off = e.status === 'changed' ? num(e.differs_by) : 0;
      // A changed entry with no state to name could not be accepted as shown.
      if (!ENTRY_STATUS.includes(e.status) || !e.posting_id || off === null || (e.status === 'changed' && !e.held_state)) { spoiled.add(month); continue; }
      if (e.status === 'unread') { m.unread += 1; continue; }
      m.entries += 1;
      if (e.status === 'settled') m.settled += 1;
      if (e.status === 'changed') { m.changed += 1; m.amount += off; m.open.push(e); }
    }
    for (const month of spoiled) delete out[month];
    for (const m of Object.values(out)) m.state = m.changed > 0 ? 'differs' : m.unread > 0 ? 'partial' : 'agree';
    return out;
  }
  /* The month's verdict is about BALANCES, never about entries (Blake,
     2026-11-27: "not journal driven, coa and balance driven"). For a month
     QuickBooks was read back, SILO's statements are built from QuickBooks' own
     lines, so every account balance matches as of that read. An entry SILO
     sent that was later edited in QuickBooks does not change that: it is a
     note beside the verdict and detail behind it, never a "differs". */
  function agreementLabel(a) {
    if (!a) return null;
    // Anything not compared yet comes first: no green while part of the month is unread.
    if (a.state === 'partial' || a.unread > 0) {
      return { text: `${howMany(a.unread, 'entry', 'entries')} not compared with QuickBooks yet`, tone: null,
        note: a.changed > 0 ? `${howMany(a.changed, 'entry', 'entries')} edited in QuickBooks` : '' };
    }
    const month = String(a.through || '').slice(0, 7);
    const last = /^\d{4}-\d{2}$/.test(month) ? new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) : '';
    const whole = !a.through || a.through >= last;
    const notes = [];
    if (!whole) notes.push(`read through ${a.through}`);
    if (a.state === 'differs') notes.push(`${howMany(a.changed, 'entry', 'entries')} edited in QuickBooks`);
    return { text: 'Balances match QuickBooks', tone: 'pos', note: notes.join(' · ') };
  }
  // What happened to one entry in QuickBooks, in a person's words.
  function changeText(e) {
    if (e.missing) return 'Not in QuickBooks any more (deleted, or moved out of the months read)';
    const off = num(e.differs_by);
    const parts = [];
    if (off) parts.push(`${money(off)} moved between accounts`);
    if (e.moved) {
      const a = e.held_first_day; const b = e.held_last_day;
      parts.push(a && b ? (a === b ? `now dated ${a}` : `now dated ${a} to ${b}`) : 'moved to another day');
    }
    return parts.length ? `Changed in QuickBooks: ${parts.join(', ')}` : 'Changed in QuickBooks';
  }
  // The accounts that differ: what SILO sent against what QuickBooks has now.
  // Amounts are +debit / -credit in the data and said as words here.
  const side = (v) => { const n = num(v); return n === null ? 'unknown' : n === 0 ? 'nothing' : `${money(Math.abs(n))} ${n > 0 ? 'debit' : 'credit'}`; };
  function changeDetail(e) {
    if (!Array.isArray(e.accounts)) return [];
    return e.accounts.filter((a) => a && typeof a === 'object')
      .map((a) => `${a.account || 'Account'}: SILO sent ${side(a.sent)}, QuickBooks has ${side(a.quickbooks)}`);
  }

  /* Accept QuickBooks' version of each open entry AS IT WAS SHOWN: the state
     on the screen goes with the request, and the server refuses an entry
     QuickBooks has changed since ('moved_on'). The company is re-checked
     before each; the first error stops the run. -> { done, again, error } */
  async function settleAll(api, open) {
    const out = { done: 0, again: 0, error: null };
    for (const e of open) {
      try {
        await api.stillActive();
        const r = await api.accept(e.posting_id, e.held_state);
        if (r && r.ok === true) out.done += 1;
        else if (r && r.status === 'moved_on') out.again += 1;
      } catch (err) { out.error = err; break; }
    }
    return out;
  }

  /* Mirror now: ask the server to read QuickBooks one month at a time until
     every month has been tried since the button was pressed. The server picks
     the company and the months; this only counts. api.mirror(since) ->
     { status, body }. Stops on the first answer it does not understand: the
     server may be refusing, and asking again cannot help. */
  const MIRROR_REFUSAL = {
    reconnect_required: 'QuickBooks needs to be connected again in Books & setup.',
    not_allowed: 'Reading QuickBooks needs finance access.',
    ledger_mirror_disabled: 'Reading QuickBooks is switched off.',
    quickbooks_busy: 'QuickBooks is busy. Try again in a few minutes.',
  };
  async function mirror(api, since, onProgress, limit = 20) {
    const out = { read: 0, failed: 0, stopped: null, reason: '' };
    for (let n = 0; ; n += 1) {
      if (n >= limit) { out.stopped = 'limit'; break; }
      let res;
      try { await api.stillActive(); res = await api.mirror(since); }
      catch (e) { out.stopped = e && e.code === 'COMPANY_CHANGED' ? 'company' : 'error'; break; }
      const b = res && res.body;
      if (!res || res.status < 200 || res.status >= 300 || !b || typeof b !== 'object') {
        out.stopped = 'refused'; out.reason = MIRROR_REFUSAL[b && b.error_code] || ''; break;
      }
      if (b.done === true) break;
      if (b.done !== false || typeof b.ok !== 'boolean') { out.stopped = 'refused'; break; }
      if (b.ok) out.read += 1;
      else { out.failed += 1; out.reason = MIRROR_REFUSAL[b.error_code] || out.reason; }
      if (onProgress) onProgress({ ...out, remaining: Number.isInteger(b.remaining) ? b.remaining : null });
      // The same refusal will meet every other month: stop asking.
      if (!b.ok && (b.error_code === 'reconnect_required' || b.error_code === 'quickbooks_busy')) { out.stopped = 'refused'; break; }
    }
    return out;
  }

  const API = { sections, chosen, agreement, agreementLabel, changeText, changeDetail, settleAll, mirror, classify, classifyBatch, classifyAdjustment, summarize, friendly, isValidationFailure, postOutcome, run, precheck, monthName, money, STATUS_LABEL, KIND_LABEL };

  // ─────────────────────────────────────────────────────────── data ──
  async function result(query) {
    const response = await query;
    if (response.error) throw Object.assign(new Error(response.error.message || 'Read failed'), { code: response.error.code });
    return response;
  }
  async function allRows(db, companyId, table, columns, configure) {
    const rows = [];
    for (;;) {
      let q = db.from(table).select(columns).eq('company_entity_id', companyId);
      if (configure) q = configure(q);
      const { data } = await result(q.order('id').range(rows.length, rows.length + 499));
      if (!Array.isArray(data)) throw new Error('Incomplete read. Refresh to retry.');
      rows.push(...data);
      if (data.length < 500) return rows;
    }
  }

  async function load(db, config) {
    const company = await config?.ensureActiveCompany?.(db);
    if (!company?.id) throw new Error('Select a company first');
    const [finance, executive] = await Promise.all([result(db.rpc('can_manage_journal_entries')), result(db.rpc('is_exec_or_owner'))]);
    if (finance.data !== true && executive.data !== true) throw new Error('Finance access is required; ask your company owner for access');
    const today = (await result(db.rpc('silo_business_today'))).data;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '')) throw new Error('Could not read the company’s business date. Refresh to retry.');
    const errors = [];
    const attempt = async (name, read) => { try { return await read(); } catch (e) { errors.push(`${name}: ${e.message}`); return undefined; } };
    // The read-back is extra: a database without it, or a read that fails,
    // leaves the months without a verdict and changes nothing else.
    const optional = async (read) => { try { const r = await read(); if (r.error) return null; return Array.isArray(r.data) ? r.data : null; } catch (_) { return null; } };
    const [settings, batches, base, view, claims, byHand, ledger, periods, sentEntries] = await Promise.all([
      attempt('settings', async () => (await result(db.from('accounting_settings').select('bookkeeping_mode').eq('company_entity_id', company.id).maybeSingle())).data),
      attempt('months', () => allRows(db, company.id, 'card_import_batches_v',
        'id,source_name,label,status,entry_date,period_start,period_end,txn_count,uncoded_count,excluded_count,coded_amount,qbo_doc_number,qbo_journal_entry_id,source_posting_enabled,source_posting_start_on,approval_hash')),
      attempt('entries', () => allRows(db, company.id, 'journal_adjustments', 'id,entry_date,memo,status,accounting_source,accounting_source_ref,approval_hash')),
      attempt('entry totals', () => allRows(db, company.id, 'journal_adjustments_v', 'id,debits,qbo_doc_number')),
      attempt('sends', () => allRows(db, company.id, 'quickbooks_journal_postings', 'id,source,source_ref,status,error_message,payload_hash,created_at',
        (q) => q.in('status', ['submitting', 'unknown', 'failed', 'voided']))),
      // A missing function means the daily ledger is not installed: no holds to report.
      // A missing function means the feature is not installed here: no marks, no button.
      attempt('entered by hand', async () => {
        const r = await db.rpc('quickbooks_entered_by_hand_list');
        if (r.error) { if (r.error.code === 'PGRST202' || r.error.code === '42883') return null; throw new Error(r.error.message); }
        return r.data || [];
      }),
      attempt('ledger', async () => { const r = await db.rpc('silo_ledger_batch_status'); if (r.error) { if (r.error.code === 'PGRST202' || r.error.code === '42883') return []; throw new Error(r.error.message); } return r.data || []; }),
      optional(() => db.from('quickbooks_ledger_mirror_periods').select('period_start,read_through').eq('company_entity_id', company.id).not('read_at', 'is', null).limit(1000)),
      // Fewer rows than the cap, or it is not the whole list and says nothing.
      optional(async () => {
        const r = await db.from('quickbooks_sent_entries_check_v')
          .select('posting_id,qbo_doc_number,memo,entry_date,status,differs_by,missing,moved,held_state,held_first_day,held_last_day,accounts')
          .eq('company_entity_id', company.id).order('posting_id').limit(5000);
        return !r.error && Array.isArray(r.data) && r.data.length >= 5000 ? { error: { message: 'too many' } } : r;
      }),
    ]);
    const after = await config.ensureActiveCompany(db);
    if (after?.id !== company.id) throw new Error('Company changed while loading. Refresh to retry.');
    const totals = new Map((view || []).map((v) => [v.id, v]));
    const adjustments = known(base) && known(view) ? base.map((a) => ({ ...a, ...(totals.get(a.id) || {}) })) : undefined;
    const facts = { companyId: company.id, today, mode: settings === undefined ? undefined : (settings?.bookkeeping_mode || 'silo'), batches, adjustments, claims, byHand, ledger };
    return { company, today, canSend: finance.data === true, mode: facts.mode, errors, facts, items: classify(facts), agreement: agreement(periods, sentEntries) };
  }

  // ───────────────────────────────────────────────────────────── UI ──
  function el(tag, text, className) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (className) n.className = className;
    return n;
  }
  const PILL = { synced: 'bcn-pill bcn-pill--pos', waiting: 'bcn-pill bcn-pill--accent', fix: 'bcn-pill bcn-pill--neg', open: 'bcn-pill', outside: 'bcn-pill' };

  function mount({ db, config = window.__SILO_CONFIG__, root = document } = {}) {
    const $ = (id) => root.getElementById(id);
    const st = { model: null, ticked: new Set(), busy: false, token: 0 };

    function setStatus(msg, type, ms) {
      const s = $('status');
      if (!msg) { s.hidden = true; return; }
      s.hidden = false; s.className = `bcn-status bcn-status--${type || 'info'}`; s.textContent = msg;
      if (ms) setTimeout(() => { if (s.textContent === msg) s.hidden = true; }, ms);
    }

    // Ticks are kept by key and dropped as soon as their row cannot be sent.
    function prune() {
      const ok = new Set((st.model?.items || []).filter((i) => i.sendable).map((i) => i.key));
      for (const k of [...st.ticked]) if (!ok.has(k)) st.ticked.delete(k);
    }
    const acting = () => Boolean(st.model?.canSend && st.model.mode === 'silo' && !st.busy);

    function drawSummary() {
      const items = st.model?.items;
      const band = $('qsSummary'); band.replaceChildren();
      const btn = $('btnSync'); const more = $('btnMarkSelected');
      $('btnMirror').disabled = st.busy || !st.model?.canSend;
      if (!items) { btn.disabled = true; more.disabled = true; $('qsSyncNote').textContent = ''; return; }
      const s = summarize(items);
      const head = el('div', null, 'qs-summary-head');
      head.append(el('strong', s.total === 0 ? 'Nothing to sync yet' : s.allGreen ? 'Everything is in QuickBooks' : `${s.synced} of ${s.total} in QuickBooks`),
        el('span', s.percent === null ? '' : `${s.percent}%`, 'bcn-mono'));
      const bar = el('div', null, 'qs-bar'); bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', `${s.synced} synced, ${s.waiting} waiting, ${s.fix} need a fix`);
      for (const [key, n] of [['synced', s.synced], ['waiting', s.waiting], ['fix', s.fix]]) {
        if (!n || !s.total) continue;
        const seg = el('span', null, `qs-seg qs-seg--${key}`); seg.style.width = `${(n / s.total) * 100}%`; bar.append(seg);
      }
      band.append(head, bar);
      const send = chosen(items, st.ticked, 'send').length;
      const markable = chosen(items, st.ticked, 'mark').length;
      btn.disabled = !acting() || send === 0;
      btn.textContent = send ? `Sync selected · ${send}` : 'Sync selected';
      more.disabled = !acting() || markable === 0;
      $('qsSyncNote').textContent = st.model.mode === 'qbo' ? QBO_KEEPS
        : st.model.mode !== 'silo' ? MODE_UNREAD
        : !st.model.canSend ? 'Sending to QuickBooks needs finance access.'
        : s.sendable === 0 ? (s.fix ? 'Nothing can be sent until the rows marked Needs a fix are fixed.' : 'Nothing is waiting.')
        : send === 0 ? 'Tick what to send.' : '';
    }

    function row(i, withTick) {
      const tr = el('tr'); tr.dataset.key = i.key;
      if (withTick) {
        const td = el('td', null, 'qs-tick');
        if (i.sendable) {
          const box = el('input'); box.type = 'checkbox'; box.checked = st.ticked.has(i.key); box.disabled = !acting();
          box.setAttribute('aria-label', `Select ${i.title}${i.detail ? `, ${i.detail}` : ''}`);
          box.addEventListener('change', () => { if (box.checked) st.ticked.add(i.key); else st.ticked.delete(i.key); drawSummary(); syncAll(); });
          td.append(box);
        }
        tr.append(td);
      }
      const what = el('td', null, 'qs-what'); what.append(el('strong', i.title)); if (i.detail) what.append(el('small', i.detail));
      const amount = el('td', money(i.amount), 'bcn-num');
      const state = el('td', null, 'qs-state'); state.append(el('span', STATUS_LABEL[i.status] || i.status, PILL[i.status] || 'bcn-pill'));
      if (i.reason) state.append(el('small', i.reason));
      const go = el('td', null, 'qs-go');
      if (i.status !== 'synced' || i.kind === 'batch') { const a = el('a', i.status === 'fix' ? 'Fix' : 'Open'); a.href = i.href; a.setAttribute('aria-label', `${i.hrefLabel}: ${i.title}`); go.append(a); }
      if (acting() && i.byHand) {
        const b = el('button', 'Undo', 'qs-mark'); b.type = 'button';
        b.setAttribute('aria-label', `Undo entered by hand: ${i.title}${i.detail ? `, ${i.detail}` : ''}`);
        b.addEventListener('click', () => unmark(i, b));
        go.append(b);
      }
      tr.append(what, amount, state, go);
      return tr;
    }
    function monthRow(month, span) {
      const hr = el('tr', null, 'qs-month'); const th = el('th', monthName(month)); th.colSpan = span; th.scope = 'colgroup'; hr.append(th); return hr;
    }
    function syncAll() {
      const all = $('qsAll');
      const can = (st.model?.items || []).filter((i) => i.sendable);
      const on = can.filter((i) => st.ticked.has(i.key)).length;
      all.disabled = !acting() || can.length === 0;
      all.checked = can.length > 0 && on === can.length;
      all.indeterminate = on > 0 && on < can.length;
    }

    function drawList() {
      const body = $('qsRows'); body.replaceChildren();
      const laterBody = $('qsLaterRows'); laterBody.replaceChildren();
      const months = $('qsMonths'); const wasOpen = new Set([...months.querySelectorAll('details[open]')].map((d) => d.dataset.month));
      months.replaceChildren();
      const items = st.model?.items;
      $('qsLater').hidden = true; $('qsDone').hidden = true;
      if (!items) { $('qsTodoTable').hidden = true; $('qsEmpty').hidden = false; $('qsEmpty').textContent = 'The list could not be read. Refresh to try again.'; syncAll(); return; }
      const parts = sections(items);

      $('qsEmpty').hidden = parts.todo.length > 0;
      $('qsEmpty').textContent = items.length ? 'Nothing to do. Everything SILO sends is in QuickBooks.' : 'Nothing has been categorized yet, so there is nothing to sync.';
      $('qsTodoTable').hidden = parts.todo.length === 0;
      let month = null;
      for (const i of parts.todo) {
        if (i.month !== month) { month = i.month; body.append(monthRow(month, 5)); }
        body.append(row(i, true));
      }
      syncAll();

      // Not a task: one quiet line, the rows behind it.
      if (parts.later.length) {
        const open = parts.later.filter((i) => i.status === 'open').length; const outside = parts.later.length - open;
        const bits = [];
        if (open) bits.push(`${plural(open, 'open month')} will be ready after ${open === 1 ? 'it ends' : 'they end'}`);
        if (outside) bits.push(`${outside} not sent by SILO`);
        $('qsLaterSum').textContent = bits.join(' · ');
        for (const i of parts.later) laterBody.append(row(i, false));
        $('qsLater').hidden = false;
      }

      // In QuickBooks: one line a month. The entries, and their QuickBooks
      // numbers, are behind it.
      $('qsDone').hidden = parts.months.length === 0;
      for (const m of parts.months) {
        const d = el('details', null, 'qs-done-month'); d.dataset.month = m.month || ''; d.open = wasOpen.has(d.dataset.month);
        const sum = el('summary');
        sum.append(el('strong', monthName(m.month)), el('span', howMany(m.items.length, 'entry', 'entries'), 'qs-muted'));
        const verdict = agreementLabel(st.model.agreement?.[m.month]);
        if (verdict) {
          sum.append(el('span', verdict.text, verdict.tone ? `bcn-pill bcn-pill--${verdict.tone}` : 'qs-muted'));
          if (verdict.note) sum.append(el('span', verdict.note, 'qs-muted'));
        } else sum.append(el('span', 'Not compared with QuickBooks yet', 'qs-muted'));
        const table = el('table', null, 'bcn-table qs-table'); const tb = el('tbody');
        for (const i of m.items) tb.append(row(i, false));
        table.append(tb); d.append(sum);
        // What QuickBooks changed, and the one way to settle it: QuickBooks is
        // the master copy, so its version is the one to accept.
        const a = st.model.agreement?.[m.month];
        if (a && a.open.length) {
          const box = el('div', null, 'qs-settle');
          const list = el('ul');
          for (const e of a.open) {
            const li = el('li', `${e.qbo_doc_number || 'Entry'}${e.memo ? ` · ${e.memo}` : ''} · ${e.entry_date}: ${changeText(e)}`);
            const detail = changeDetail(e);
            if (detail.length) { const sub = el('ul'); for (const line of detail) sub.append(el('li', line)); li.append(sub); }
            list.append(li);
          }
          box.append(list);
          if (st.model.canSend) {
            const b = el('button', `Use QuickBooks’ version · ${a.open.length}`, 'bcn-btn'); b.type = 'button'; b.disabled = st.busy;
            b.addEventListener('click', () => settle(m.month, b));
            box.append(b, el('small', 'Edited in QuickBooks after SILO sent them. SILO’s books already use QuickBooks’ version, so the balances match. Accepting clears them from this list.'));
          }
          d.append(box);
        }
        d.append(table); months.append(d);
      }
    }
    const draw = () => { prune(); drawSummary(); drawList(); };

    async function refresh(quiet) {
      const token = ++st.token;
      if (!quiet) setStatus('Reading what is in QuickBooks and what is waiting…', 'info');
      try {
        const model = await load(db, config);
        if (token !== st.token) return;
        st.model = model; draw();
        if (model.errors.length) setStatus(`Some of this could not be read (${model.errors.join('; ')}). Nothing unread is shown as synced.`, 'neg');
        else if (!quiet) setStatus('', 'info');
        $('qsToday').textContent = `As of ${model.today}${model.company.name ? ` · ${model.company.name}` : ''}`;
        if (model.items && model.canSend && model.mode === 'silo') {
          precheck(model.items, api(), () => { if (token === st.token && !st.busy) draw(); });
        }
      } catch (e) {
        if (token !== st.token) return;
        st.model = null; draw(); setStatus(e.message, 'neg');
      }
    }

    // Take back one "already in QuickBooks" mark. Nothing is sent, and it is
    // redone with one tick, so it asks nothing.
    async function unmark(item, button) {
      if (st.busy || !st.model) return;
      button.disabled = true;
      try {
        const a = api();
        await a.stillActive();
        await a.mark(item.kind, item.id, false);
        await refresh(true);
        setStatus(`${item.title} is back in the list to send.`, 'pos', 6000);
      } catch (e) {
        button.disabled = false;
        setStatus(e.code === 'COMPANY_CHANGED' ? 'The active company changed. Refresh before changing anything.' : friendly(e.message), 'neg');
      }
    }

    // The ticked rows, marked as already in QuickBooks: SILO will not send
    // them. One at a time, the company checked before each, stopping at the
    // first refusal so the rest stay exactly as they were.
    async function markSelected() {
      if (!acting() || !st.model?.items) return;
      const rows = chosen(st.model.items, st.ticked, 'mark');
      if (!rows.length) return;
      $('qsMore').open = false;
      st.busy = true; st.token += 1; draw();
      let done = 0; let problem = null;
      const a = api();
      for (const item of rows) {
        try { await a.stillActive(); await a.mark(item.kind, item.id, true); st.ticked.delete(item.key); done += 1; }
        catch (e) { problem = e.code === 'COMPANY_CHANGED' ? 'The active company changed. Refresh before changing anything.' : friendly(e.message); break; }
      }
      st.busy = false;
      await refresh(true);
      const said = `${howMany(done, 'entry', 'entries')} marked as already in QuickBooks. SILO will not send ${done === 1 ? 'it' : 'them'}.`;
      setStatus(problem ? `${said} Stopped: ${problem}` : said, problem ? 'neg' : 'pos', problem ? 0 : 6000);
    }

    // Accept QuickBooks' version of every changed entry in one month.
    async function settle(month, button) {
      const open = st.model?.agreement?.[month]?.open || [];
      if (st.busy || !st.model?.canSend || !open.length) return;
      st.busy = true; st.token += 1; button.disabled = true;
      // Each entry is accepted AS SHOWN: the server refuses one QuickBooks has
      // changed since this page read it, and it is listed again after the refresh.
      const out = await settleAll(api(), open);
      let problem = null;
      if (out.error) problem = `Stopped: ${out.error.code === 'COMPANY_CHANGED' ? 'The active company changed. Refresh before changing anything.' : friendly(out.error.message)}`;
      else if (out.again) problem = `${howMany(out.again, 'entry', 'entries')} changed again in QuickBooks since this page loaded. Look again before accepting.`;
      st.busy = false;
      await refresh(true);
      const said = `${howMany(out.done, 'entry', 'entries')} settled to QuickBooks’ version.`;
      setStatus(problem ? `${said} ${problem}` : said, problem ? 'neg' : 'pos', problem ? 0 : 6000);
    }

    async function mirrorNow() {
      if (st.busy || !st.model?.canSend) return;
      st.busy = true; st.token += 1; draw();
      const prog = $('qsProgress'); prog.hidden = false;
      const meter = $('qsProgressBar'); const text = $('qsProgressText');
      meter.removeAttribute('value'); text.textContent = 'Reading QuickBooks…';
      const out = await mirror(api(), new Date().toISOString(), (p) => {
        const tried = p.read + p.failed;
        if (p.remaining !== null) { meter.max = tried + p.remaining; meter.value = tried; }
        text.textContent = `Reading QuickBooks… ${howMany(tried, 'month', 'months')} done${p.remaining ? `, ${p.remaining} to go` : ''}`;
      });
      st.busy = false; prog.hidden = true; meter.value = 0;
      const parts = [`${howMany(out.read, 'month', 'months')} read from QuickBooks`];
      if (out.failed) parts.push(`${out.failed} could not be read`);
      const why = out.reason || (out.stopped === 'company' ? 'The active company changed.' : out.stopped === 'limit' ? 'Press Mirror now again to read the rest.'
        : out.stopped ? 'QuickBooks could not be read right now.' : '');
      setStatus(`${parts.join(' · ')}.${why ? ` ${why}` : ''}`, out.failed || (out.stopped && out.stopped !== 'limit') ? 'neg' : 'pos');
      await refresh(true);
    }

    function api() {
      const rpc = async (name, args) => (await result(db.rpc(name, args))).data;
      return {
        async stillActive() {
          const now = await config.ensureActiveCompany(db);
          if (!st.model || now?.id !== st.model.company.id) throw Object.assign(new Error('The active company changed.'), { code: 'COMPANY_CHANGED' });
        },
        preview: (id) => rpc('card_import_batch_preview', { p_batch_id: id }),
        approve: (id, hash) => rpc('approve_reviewed_card_import_batch', { p_batch_id: id, p_expected_hash: hash }),
        mark: (kind, id, on) => rpc('set_entry_entered_in_quickbooks', { p_kind: kind, p_id: id, p_marked: on }),
        accept: (id, state) => rpc('quickbooks_accept_quickbooks_version', { p_posting_id: id, p_expected_state: state }),
        async mirror(since) {
          const { data: { session } } = await db.auth.getSession();
          const res = await fetch(`${config.SUPABASE_URL}/functions/v1/quickbooks-ledger-mirror-scheduled`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}`, apikey: config.SUPABASE_ANON_KEY },
            body: JSON.stringify({ since }),
          });
          return { status: res.status, body: await res.json().catch(() => null) };
        },
        async post(body) {
          try {
            const { data: { session } } = await db.auth.getSession();
            const res = await fetch(`${config.SUPABASE_URL}/functions/v1/quickbooks-post-journal`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}`, apikey: config.SUPABASE_ANON_KEY },
              body: JSON.stringify(body),
            });
            return { status: res.status, body: await res.json().catch(() => ({})) };
          } catch (e) { return { status: 0, body: { error: e.message } }; }
        },
      };
    }

    function openConfirm() {
      if (!acting() || !st.model?.items) return;
      const rows = chosen(st.model.items, st.ticked, 'send');
      if (!rows.length) return;
      const list = $('qsConfirmList'); list.replaceChildren();
      for (const i of rows) {
        const line = el('div', null, 'qs-choice');
        const text = el('span'); text.append(el('strong', `${i.title} · ${monthName(i.month)}`), el('small', `${money(i.amount)}${i.defaultSelected === false ? ` · ${i.reason}` : ''}`));
        line.append(text); list.append(line);
      }
      const ack = $('qsAck'); ack.checked = false;
      const go = $('qsConfirmGo');
      go.textContent = `Send to QuickBooks · ${rows.length}`;
      const sync = () => { go.disabled = !ack.checked; };
      ack.onchange = sync; sync();
      go.onclick = () => { $('qsConfirm').close(); start(rows); };
      $('qsConfirm').showModal();
    }

    async function start(picked) {
      if (st.busy || !picked.length) return;
      st.busy = true; st.token += 1; draw();
      const prog = $('qsProgress'); prog.hidden = false;
      const meter = $('qsProgressBar'); const text = $('qsProgressText');
      const phases = { checking: 'Checking', approving: 'Building the entry for', sending: 'Sending', done: 'Finished' };
      const out = await run(picked, api(), ({ index, total, item, phase, outcomes }) => {
        meter.max = total; meter.value = index;
        text.textContent = `${phases[phase] || phase} ${item.title} · ${monthName(item.month)} (${Math.min(index + (phase === 'done' ? 0 : 1), total)} of ${total})`;
        const last = outcomes[outcomes.length - 1];
        if (phase === 'done' && last) {
          const live = st.model.items.find((x) => x.key === last.key);
          if (live) Object.assign(live, { status: last.status, reason: last.warning ? `${last.reason} ${last.warning}` : last.reason, sendable: false });
          st.ticked.delete(last.key);
          draw();
        }
      });
      st.busy = false; prog.hidden = true;
      const left = picked.length - out.outcomes.length;
      const parts = [`${out.sent} sent to QuickBooks`];
      if (out.failed) parts.push(`${out.failed} need a fix`);
      if (left) parts.push(`${left} not attempted`);
      setStatus(`${parts.join(' · ')}.${out.stopped === 'unknown' ? ' Stopped because QuickBooks did not confirm a send.' : out.stopped === 'company' ? ' Stopped because the active company changed.' : ''}`,
        out.failed || out.stopped ? 'neg' : 'pos');
      await refresh(true);
    }

    $('btnSync').addEventListener('click', openConfirm);
    $('btnRefresh').addEventListener('click', () => { if (!st.busy) refresh(); });
    $('qsConfirmCancel').addEventListener('click', () => $('qsConfirm').close());
    $('btnMarkSelected').addEventListener('click', markSelected);
    $('btnMirror').addEventListener('click', mirrorNow);
    $('qsAll').addEventListener('change', () => {
      if (!st.model?.items) return;
      for (const i of st.model.items) { if (!i.sendable) continue; if ($('qsAll').checked) st.ticked.add(i.key); else st.ticked.delete(i.key); }
      draw();
    });
    return { refresh, state: st };
  }

  API.load = load; API.mount = mount;
  if (typeof window !== 'undefined') window.SiloQuickBooksSync = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
