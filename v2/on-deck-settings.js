/* On Deck controls belong to Workspace Settings. Existing RPCs enforce access. */
window.SiloOnDeckSettings = {
  async mount({ db, companyId, canEdit }) {
    const $ = id => document.getElementById(id), form = $('od-settings-form');
    const controls = () => [...form.querySelectorAll('input,button')];
    const check = r => { if (r.error) throw new Error(r.error.message); return r.data; };
    const money = v => '$' + Number(v || 0).toFixed(2);
    let available = false;
    const active = async () => { if ((await window.__SILO_CONFIG__.ensureActiveCompany(db))?.id !== companyId) throw new Error('Company changed. Reload Workspace Settings before saving.'); };
    const status = text => { $('od-settings-status').textContent = text; };
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
      status(canEdit ? (s.last_status || '') : 'Only a workspace owner can change these settings.');
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
