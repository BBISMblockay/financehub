/* When SILO starts posting a bank or card account.
 *
 * Accounts come under SILO at different times. A provider backload can bring in
 * months that were already categorized inside QuickBooks by hand; those months
 * are not work waiting to be done, and SILO must neither post them nor count
 * them in its own ledger. card_sources.posting_start_on is the first day SILO
 * may post an account. NULL -- the state every account starts in -- means every
 * period is SILO's, which is what SILO did before this control existed.
 *
 * Saving a date does two things, and the dialog says both: it stops the account
 * being approved or posted for earlier periods (a database trigger refuses it),
 * and it reverses whatever SILO's ledger already recorded for them. The
 * reversal runs in pages through silo_ledger_resync_posting_start, because one
 * account can carry thousands of transactions and a browser statement has 8s.
 * Nothing is deleted: ledger_entries is append-only.
 */
(function () {
  'use strict';
  /* silo_ledger_resync_posting_start reads at most this many; a count at the cap is a lower bound. */
  const RESYNC_CAP = 5000;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY = /^\d{4}-\d{2}-\d{2}$/;

  // 'September 1, 2026'. A bare ISO date in a sentence reads as a key, not a day.
  function longDate(value) {
    if (!DAY.test(String(value || ''))) return String(value ?? '');
    return new Date(value + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  }

  /* One status per account, in the reader's words. No cut-over is not a warning:
     it is the normal state, and most accounts stay in it. */
  function stateLabel(source) {
    if (!source?.posting_start_on) return 'Every period is SILO’s to post';
    return `SILO posts from ${longDate(source.posting_start_on)} · earlier periods were handled outside SILO`;
  }

  /* Refused before anything is written, because each of these would be a
     silent no-op or a surprise rather than an error the database reports. */
  function validate(value, source, businessToday, booksStart) {
    const next = String(value || '').trim();
    if (!next) return '';
    if (!DAY.test(next)) return 'Enter the first day SILO may post this account, as YYYY-MM-DD.';
    if (DAY.test(String(businessToday || '')) && next > businessToday) {
      return `${longDate(next)} is in the future. A cut-over ahead of today would stop SILO posting the months you are working on now.`;
    }
    if (DAY.test(String(booksStart || '')) && next <= booksStart) {
      return `Your books start ${longDate(booksStart)}, so SILO already posts nothing before then. A cut-over on or before that date would change nothing — clear the field instead.`;
    }
    return '';
  }

  // What the save has to say for itself, both halves of it.
  function confirmText(source, next, current) {
    const name = source?.display_name || source?.source_key || 'this account';
    if (!next) {
      return `Clear the cut-over on ${name}. Every period becomes SILO’s again: earlier periods can be approved and posted, and their coded transactions re-enter SILO’s ledger.`
        + (current ? ` It is currently ${longDate(current)}.` : '');
    }
    return `SILO will post ${name} from ${longDate(next)} onward.\n\n`
      + 'Periods ending before that date can no longer be approved or posted, and they leave On Deck. '
      + 'Whatever SILO’s ledger already recorded for them is reversed, so the roll-forward stops counting it as SILO’s. '
      + 'Nothing is sent to or changed in QuickBooks, and nothing is deleted — each ledger entry is reversed, not removed.';
  }

  async function mount({ db, companyId, el, businessToday, booksStart }) {
    const host = el('postingStart');
    if (!host) return;
    const status = (message, bad = false) => {
      host.querySelector('[data-posting-status]').innerHTML = message ? `<span class="${bad ? 'books-flag' : ''}">${esc(message)}</span>` : '';
    };
    let sources = [];

    async function read() {
      const { data, error } = await db.from('card_sources')
        .select('id,source_key,display_name,source_type,ingest_mode,is_active,posting_enabled,authoritative_from,posting_start_on')
        .eq('company_entity_id', companyId).order('display_name');
      if (error) throw new Error(error.message);
      sources = data || [];
      render();
    }

    function render() {
      const active = sources.filter((s) => s.is_active !== false);
      host.querySelector('[data-posting-table]').innerHTML = active.length
        ? '<div class="books-table-scroll"><table><thead><tr><th>Account</th><th>Imports from</th><th>QuickBooks posting</th><th>SILO posts from</th><th></th></tr></thead><tbody>'
          + active.map((s) => `<tr><td>${esc(s.display_name || s.source_key)}</td>`
            + `<td>${esc(s.authoritative_from || '—')}</td>`
            + `<td>${s.posting_enabled ? 'On' : 'Off'}</td>`
            + `<td><input class="bcn-field" type="date" data-start="${esc(s.id)}" value="${esc(s.posting_start_on || '')}" max="${esc(businessToday || '')}" aria-label="First day SILO may post ${esc(s.display_name || s.source_key)}" /></td>`
            + `<td><button type="button" class="bcn-btn" data-save-start="${esc(s.id)}">Save</button></td></tr>`
            + `<tr><td colspan="5" class="books-caption">${esc(stateLabel(s))}</td></tr>`).join('')
          + '</tbody></table></div>'
        : 'No bank or card accounts yet.';
    }

    async function save(id) {
      const source = sources.find((s) => s.id === id);
      const input = host.querySelector(`[data-start="${CSS.escape(id)}"]`);
      const next = String(input?.value || '').trim();
      const problem = validate(next, source, businessToday, booksStart);
      if (problem) { status(problem, true); return; }
      /* Saving the SAME date again is the retry the messages below prescribe.
         The date is written before the reconciliation runs, so a run that
         stopped partway leaves the date already correct -- and the first
         version of this control answered "that is already the cut-over" and
         did nothing, which made the advertised recovery impossible and left
         those entries affecting the balances. An unchanged date therefore skips
         the write and the confirmation (nothing is being decided) and resumes
         the reconciliation, which is idempotent. */
      const previous = source.posting_start_on || '';
      const unchanged = previous === next;
      /* Only rows dated before the later of the old and new date can change state. */
      const before = [previous, next].filter(Boolean).sort().pop() || null;
      if (!unchanged) {
        const ok = await window.SiloFinanceDialog.ask({
          title: next ? 'Set when SILO starts posting' : 'Clear the cut-over',
          message: confirmText(source, next, source.posting_start_on),
          label: next ? 'Set cut-over' : 'Clear cut-over',
          confirmation: next
            ? 'Those earlier periods are already recorded in QuickBooks, or are not to be sent from SILO.'
            : 'SILO may post every period of this account.',
        });
        if (!ok) return;

        status('Saving…');
        const { data, error } = await db.from('card_sources').update({ posting_start_on: next || null })
          .eq('id', id).eq('company_entity_id', companyId).select('id,posting_start_on');
        // An RLS-refused UPDATE succeeds with zero rows rather than erroring.
        if (error) { status(`The cut-over was not saved: ${error.message}.`, true); return; }
        if (!data?.length) { status('The cut-over was not saved: your account cannot change this one. Ask your company owner.', true); return; }
        source.posting_start_on = data[0].posting_start_on;
        render();
      } else {
        status('Checking SILO’s ledger against this date…');
      }

      /* The date is written and already governs approval and every new ledger
         record, so a run that stops partway leaves the account correct going
         forward and says what is left rather than rolling the date back.
         Setting a date reverses earlier entries; clearing one records them
         again, so the wording follows the direction rather than claiming a
         reversal either way. */
      const posts = source.posting_start_on ? `${longDate(source.posting_start_on)} onward` : 'every period';
      const work = source.posting_start_on ? 'Reversing earlier ledger entries' : 'Restoring earlier ledger entries';
      /* The window is only a speed-up: it can miss a row stranded by an earlier,
         interrupted run under a different date. So a windowed pass that reaches 0
         is followed by one unbounded pass, and "Saved" is only said once that
         also reads 0. */
      let bound = before;
      let remaining = null;
      for (let page = 0; page < 200; page += 1) {
        const r = await db.rpc('silo_ledger_resync_posting_start', { p_source_id: id, p_limit: 100, p_before: bound });
        if (r.error) {
          status(`Saved. SILO posts ${posts}, but SILO’s ledger is not yet in line with that: ${r.error.message}. Press Save again on this account to pick up where it stopped.`, true);
          return;
        }
        const left = Number(r.data) || 0;
        /* The server reads at most 5000, so a capped value cannot show progress. */
        const stalled = remaining !== null && left < RESYNC_CAP && left >= remaining;
        remaining = left;
        status(remaining ? `${work} — ${remaining} transactions left…` : 'Saved.');
        if (!remaining && bound !== null) { bound = null; remaining = null; continue; }
        if (!remaining) break;
        /* Each page settles up to 100 rows, so a remainder that did not shrink
           means the rest are held (an open feed exception, an inactive account)
           and pressing on cannot change them. Stop and say so. */
        if (stalled) {
          status(`Saved, and SILO posts ${posts}. ${remaining} transactions did not move on the last pass. Press Save again on this account; if the number stays the same, something else is changing this account’s transactions.`, true);
          return;
        }
      }
      status(remaining
        ? `Saved, and SILO posts ${posts}. ${remaining} transactions are still out of line in SILO’s ledger; press Save again on this account to pick up where it stopped.`
        : `Saved. ${stateLabel(source)}. Nothing was sent to QuickBooks.`, !!remaining);
    }

    host.addEventListener('click', (event) => {
      const button = event.target.closest('[data-save-start]');
      if (!button) return;
      button.disabled = true;
      save(button.dataset.saveStart)
        .catch((e) => status(`The cut-over was not saved: ${e.message}.`, true))
        .finally(() => { button.disabled = false; });
    });
    await read();
  }

  window.SiloPostingStart = { mount, stateLabel, validate, confirmText, longDate };
})();
