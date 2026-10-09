/* On Deck controls belong to Workspace Settings. Existing RPCs enforce access. */
window.SiloOnDeckSettings = {
  setCurrency(currency) {
    document.getElementById('od-budget-label').textContent = `Per-product restock cost ceiling (${/^[A-Z]{3}$/.test(currency || '') ? currency : 'company currency unavailable'})`;
  },
  async mount({ db, companyId, canEdit, currency }) {
    const $ = id => document.getElementById(id), form = $('od-settings-form');
    const controls = () => [...form.querySelectorAll('input,button')];
    const check = r => { if (r.error) throw new Error(r.error.message); return r.data; };
    const money = v => '$' + Number(v || 0).toFixed(2);
    let available = false;
    const active = async () => { if ((await window.__SILO_CONFIG__.ensureActiveCompany(db))?.id !== companyId) throw new Error('Company changed. Reload Workspace Settings before saving.'); };
    const status = text => { $('od-settings-status').textContent = text; };
    window.SiloOnDeckSettings.setCurrency(currency);
    const warnBudget = () => {
      const missing = $('od-enabled').checked && form.querySelector('[name=od-workflow][value=restock]').checked && !(Number($('od-budget').value) > 0);
      $('od-budget-warning').hidden = !missing;
      $('od-budget-warning').textContent = missing ? 'Restock is enabled without a cost ceiling. No restock suggestions can pass this gate. Identity, product policy, cost, lead time and MSRP are checked first; a ceiling does not make an ineligible product qualify.' : '';
    };
    form.addEventListener('input', warnBudget); form.addEventListener('change', warnBudget);
    async function load() {
      controls().forEach(n => { n.disabled = true; }); available = false;
      await active();
      if (!check(await db.rpc('on_deck_can_review'))) return;
      $('on-deck-settings').hidden = false;
      const [setting, stats] = await Promise.all([
        db.from('on_deck_settings').select('*').eq('company_entity_id', companyId).maybeSingle(),
        db.rpc('on_deck_stats'),
      ]);
      const s = check(setting) || {}, m = check(stats) || {};
      $('od-enabled').checked = !!s.enabled; $('od-cap').value = s.monthly_cap_usd ?? 100; $('od-budget').value = s.buy_budget ?? '';
      form.querySelectorAll('[name=od-workflow]').forEach(n => { n.checked = (s.workflows || ['restock', 'launch', 'seo', 'ads']).includes(n.value); });
      $('od-usage').textContent = `${money(m.spent)} used · ${money(m.unknown_or_reserved)} held / uncertain · ${money(s.monthly_cap_usd ?? 100)} monthly cap`;
      $('od-accounting').textContent = `${m.attempts || 0} attempts, including ${m.failed_attempts || 0} failed or unknown. ${m.actions || 0} draft handoffs. ${m.minutes == null ? 'No observed time saved recorded.' : `${m.minutes} minutes saved, user-reported.`} Usage is recorded for cost review; it is not a customer invoice or a calculated labor saving.`;
      $('od-usage-workflows').textContent = Object.entries(m.workflow_spend || {}).map(([k,v]) => `${k}: ${money(v)}`).join(' · ');
      warnBudget();
      try {
        const [proposals, review] = await Promise.all([
          db.from('on_deck_proposals').select('id,kind,status,valid_until,content').eq('company_entity_id', companyId).in('status', ['ready','needs_info','failed','preparing','revision']),
          db.rpc('on_deck_review_state'),
        ]);
        const rows = check(proposals), freshness = check(review);
        if (!Array.isArray(freshness?.proposals)) throw new Error('Freshness unavailable');
        rows.forEach(p => { p.source_current = freshness.proposals.find(r => r.id === p.id)?.source_current ?? false; });
        $('od-current-status').textContent = window.SiloOnDeckBriefing.currentStatus(rows).text;
      } catch { $('od-current-status').textContent = 'Current draft readiness unavailable. Open On Deck to reload; saved run summaries are not current readiness.'; }
      status(canEdit ? (/^Preparation failed/.test(s.last_status || '') ? s.last_status : '') : 'Only a workspace owner can change these settings.');
      available = true; controls().forEach(n => { n.disabled = !canEdit; });
    }
    form.addEventListener('submit', async e => {
      e.preventDefault(); if (!canEdit || !available) return;
      controls().forEach(n => { n.disabled = true; });
      try {
        await active();
        check(await db.rpc('on_deck_configure', {
          p_enabled: $('od-enabled').checked, p_cap: Number($('od-cap').value),
          p_buy_budget: $('od-budget').value ? Number($('od-budget').value) : null,
          p_workflows: [...form.querySelectorAll('[name=od-workflow]:checked')].map(n => n.value),
        }));
        await load(); status('On Deck settings saved.');
      } catch (e) { status(e.message); controls().forEach(n => { n.disabled = !canEdit || !available; }); }
    });
    try { await load(); }
    catch (e) { $('on-deck-settings').hidden = false; status(/does not exist|schema cache|could not find/i.test(e.message) ? 'On Deck settings will be available after the preview migration is installed.' : e.message); }
    if (location.hash === '#on-deck-settings' && !$('on-deck-settings').hidden) $('on-deck-settings').scrollIntoView();
  },
};
