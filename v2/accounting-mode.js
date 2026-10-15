/* Who keeps this company's books.
 *
 * The per-account controls below this card answer "from when, for this
 * account?". They cannot answer "is SILO doing the bookkeeping at all?", and
 * before this card nothing did: a company that codes and posts inside
 * QuickBooks and uses SILO for reporting had to switch every account off one
 * at a time, and one account left on is a hybrid nobody chose. So the question
 * is asked once, company-wide, in the words the reader would use.
 *
 * Two answers and no third. 'qbo' means SILO sends nothing to QuickBooks from
 * any surface and records nothing in its own ledger; 'silo' means SILO codes
 * and posts from the takeover date, which is a default each account may still
 * override (an account that came onboard later keeps its own later date).
 *
 * Saving writes the two fields, then brings SILO's ledger in line one account
 * at a time through the same paged reconciliation a per-account date uses --
 * the browser has 8s per statement and a company can carry tens of thousands
 * of transactions. Nothing is deleted and nothing is sent to QuickBooks.
 */
(function () {
  'use strict';
  /* silo_ledger_resync_posting_start reads at most this many; a count at the
     cap is a lower bound, so two equal capped counts are not evidence that
     nothing moved. */
  const RESYNC_CAP = 5000;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const longDate = (value) => (window.SiloPostingStart?.longDate
    ? window.SiloPostingStart.longDate(value)
    : String(value ?? ''));

  /* The company's position in one sentence, for the top of the card. A company
     that has never answered reads as 'silo', because that is what SILO did
     before this card existed and the default must not misreport it. */
  function stateLabel(settings) {
    if (settings?.bookkeeping_mode === 'qbo') return 'QuickBooks keeps the books · SILO sends nothing to it';
    if (settings?.silo_takeover_on) return `SILO keeps the books from ${longDate(settings.silo_takeover_on)}`;
    return 'SILO keeps the books';
  }

  /* Refused before anything is written. A takeover date is only meaningful
     between the books start and today: ahead of today it would stop SILO
     posting the months being worked on now, and before the books start it
     changes nothing, which reads as a setting that did not take. */
  function validate(mode, takeover, businessToday, booksStart) {
    if (mode !== 'silo') return '';
    const next = String(takeover || '').trim();
    if (!next) return '';
    if (!DAY.test(next)) return 'Enter the day SILO starts keeping the books, as YYYY-MM-DD.';
    if (DAY.test(String(businessToday || '')) && next > businessToday) {
      return `${longDate(next)} is in the future. SILO would post nothing until then, including the months you are working on now.`;
    }
    if (DAY.test(String(booksStart || '')) && next < booksStart) {
      return `Your books start ${longDate(booksStart)}, so SILO records nothing before then. Clear the date instead of setting an earlier one.`;
    }
    return '';
  }

  /* What the save has to say for itself. Switching to QuickBooks is the
     consequential direction -- it reverses everything SILO's ledger holds --
     so it says so in full rather than in a word. */
  function confirmText(mode, takeover) {
    if (mode === 'qbo') {
      return 'QuickBooks will keep the books for this company.\n\n'
        + 'SILO will not send anything to QuickBooks again — not bank and card coding, not revenue journals, '
        + 'schedules, fixed assets or hand-written adjustments. What SILO recorded but never sent is reversed, '
        + 'so its roll-forward stops counting it; months already posted to QuickBooks stay exactly as they are.\n\n'
        + 'Everything already in QuickBooks stays exactly as it is. Nothing is deleted, and nothing is sent.';
    }
    return (takeover
      ? `SILO will keep the books from ${longDate(takeover)} onward.\n\n`
        + 'Periods ending before that date cannot be approved or posted, and they leave On Deck. '
        + 'Accounts that came onboard later keep their own later date.\n\n'
      : 'SILO will keep the books for every period it has.\n\n')
      + 'SILO codes your bank and card activity and posts it to QuickBooks. Nothing is sent by saving this.';
  }

  async function mount({ db, companyId, el, businessToday, booksStart }) {
    const host = el('booksMode');
    if (!host) return;
    const status = (message, bad = false) => {
      host.querySelector('[data-mode-status]').innerHTML = message ? `<span class="${bad ? 'books-flag' : ''}">${esc(message)}</span>` : '';
    };
    let settings = null;
    let sources = [];

    async function read() {
      const [s, c] = await Promise.all([
        db.from('accounting_settings').select('bookkeeping_mode,silo_takeover_on,accounting_start_date')
          .eq('company_entity_id', companyId).maybeSingle(),
        db.from('card_sources').select('id,display_name,source_key,is_active')
          .eq('company_entity_id', companyId).order('display_name'),
      ]);
      /* The page is static and goes live on merge; the migration that adds
         bookkeeping_mode is applied separately and may come later. PostgREST
         rejects a select naming an unknown column, and ONLY that means "not
         applied yet": the card hides itself and the per-account controls below
         carry on. Any other failure (network, auth) is not evidence about the
         schema, so it is reported rather than quietly removing the control. */
      if (s.error) {
        if (s.error.code === '42703' || /bookkeeping_mode/.test(s.error.message || '')) { host.hidden = true; return; }
        throw new Error(s.error.message);
      }
      /* The account list is not decoration here: the save reconciles SILO's
         ledger one account at a time, so an unread list would skip the ledger
         work entirely and still report a finished save. Fail the read instead,
         and let the next mount (or the next Save, which re-reads) recover. */
      if (c.error) throw new Error(c.error.message);
      settings = s.data;
      /* Inactive accounts are kept: a disabled account can still hold live
         ledger entries from when it was coded, and in reporting-only those are
         exactly what has to be reversed. */
      sources = c.data || [];
      render();
    }

    function render() {
      const mode = settings?.bookkeeping_mode === 'qbo' ? 'qbo' : 'silo';
      host.querySelector('[data-mode-state]').textContent = stateLabel(settings);
      host.querySelector('[data-mode-body]').innerHTML = `
        <p>You’ve connected QuickBooks and SILO has your history. Pick one — running both at once is how the same month ends up recorded twice.</p>
        <label class="books-choice"><input type="radio" name="booksMode" value="qbo"${mode === 'qbo' ? ' checked' : ''} />
          <span><strong>QuickBooks keeps the books.</strong> You categorize and post in QuickBooks, as you do now. SILO reads your activity and gives you reporting, but never sends anything to QuickBooks.</span></label>
        <label class="books-choice"><input type="radio" name="booksMode" value="silo"${mode === 'silo' ? ' checked' : ''} />
          <span><strong>SILO keeps the books.</strong> SILO categorizes your bank and card activity and posts it to QuickBooks for you. Everything before your start date stays as you did it in QuickBooks, untouched.</span></label>
        <div class="books-choice-detail"${mode === 'silo' ? '' : ' hidden'} data-mode-date>
          <label>SILO starts keeping the books on
            <input class="bcn-field" type="date" data-takeover value="${esc(settings?.silo_takeover_on || '')}" max="${esc(businessToday || '')}" />
          </label>
          <p class="books-caption">Leave it empty if SILO should keep every period it has. An account that came onboard later can still be given its own date below.</p>
        </div>
        <button type="button" class="bcn-btn bcn-btn--primary" data-save-mode>Save</button>
        <p class="books-caption">Coming later: SILO as your ledger, with QuickBooks no longer needed.</p>`;
    }

    async function save() {
      const mode = host.querySelector('input[name="booksMode"]:checked')?.value || 'silo';
      const takeover = String(host.querySelector('[data-takeover]')?.value || '').trim();
      const problem = validate(mode, takeover, businessToday, booksStart);
      if (problem) { status(problem, true); return; }

      const was = settings?.bookkeeping_mode === 'qbo' ? 'qbo' : 'silo';
      const wasDate = settings?.silo_takeover_on || '';
      const unchanged = was === mode && (mode !== 'silo' || wasDate === takeover);
      if (!unchanged) {
        const ok = await window.SiloFinanceDialog.ask({
          title: mode === 'qbo' ? 'Hand the books back to QuickBooks' : 'SILO keeps the books',
          message: confirmText(mode, takeover),
          label: mode === 'qbo' ? 'QuickBooks keeps the books' : 'SILO keeps the books',
          confirmation: mode === 'qbo'
            ? 'SILO is not to send anything to QuickBooks.'
            : 'SILO is to code and post this company’s activity.',
        });
        if (!ok) return;
        status('Saving…');
        /* The company the card was mounted for, not whichever one is active by
           the time this returns: the confirmation sits outside the element the
           company-switch shield makes inert, so a switch in another tab can
           land while it is open. The RPC refuses a mismatch. */
        const { data, error } = await db.rpc('set_bookkeeping_mode', {
          p_mode: mode, p_takeover: mode === 'silo' && takeover ? takeover : null, p_company: companyId,
        });
        if (error) { status(`That was not saved: ${error.message}.`, true); return; }
        settings = Array.isArray(data) ? data[0] : data;
        render();
      } else {
        status('Checking SILO’s ledger against this setting…');
      }

      /* Same reconciliation the per-account date runs, once per account. The
         window cannot be narrowed here: a mode change can move any row of any
         date, so every account is judged in full. A run that stops partway
         leaves the setting correct going forward and says what is left. */
      const label = (settings?.bookkeeping_mode === 'qbo') ? 'Reversing SILO’s ledger entries' : 'Bringing SILO’s ledger in line';
      let outstanding = 0;
      for (const source of sources) {
        const name = source.display_name || source.source_key;
        let remaining = null;
        for (let page = 0; page < 200; page += 1) {
          const r = await db.rpc('silo_ledger_resync_posting_start', { p_source_id: source.id, p_limit: 100, p_before: null });
          if (r.error) {
            status(`Saved, but SILO’s ledger is not yet in line on ${name}: ${r.error.message}. Press Save again to pick up where it stopped.`, true);
            return;
          }
          const left = Number(r.data) || 0;
          /* A remainder that did not shrink means the rest are held (an open
             feed exception, an inactive account) and pressing on cannot move
             them. Stop that account rather than spinning through 200 pages. */
          const stalled = remaining !== null && left < RESYNC_CAP && left >= remaining;
          remaining = left;
          status(remaining ? `${label} — ${name}, ${remaining} transactions left…` : `${label} — ${name} done.`);
          if (!remaining || stalled) break;
        }
        outstanding += remaining || 0;
      }
      status(outstanding
        ? `Saved. ${stateLabel(settings)}. ${outstanding} transactions are still out of line in SILO’s ledger; press Save again to pick up where it stopped.`
        : `Saved. ${stateLabel(settings)}. Nothing was sent to QuickBooks.`, !!outstanding);
    }

    host.addEventListener('change', (event) => {
      if (event.target.name !== 'booksMode') return;
      const detail = host.querySelector('[data-mode-date]');
      if (detail) detail.hidden = event.target.value !== 'silo';
    });
    host.addEventListener('click', (event) => {
      const button = event.target.closest('[data-save-mode]');
      if (!button) return;
      button.disabled = true;
      save().catch((e) => status(`That was not saved: ${e.message}.`, true))
        .finally(() => { button.disabled = false; });
    });
    await read();
  }

  window.SiloBooksMode = { mount, stateLabel, validate, confirmText };
})();
