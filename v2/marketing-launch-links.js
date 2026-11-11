/* Linking a marketing item -- a Meta ad, a campaign, a Redo or Klaviyo
   message -- to a launch, and showing which launches it is already linked to.

   This lived inside /v2/marketing-overview.html. It moved here unchanged in
   behaviour so /v2/marketing-explorer.html can offer the same thing on the
   same rows: two pages that list the same ads must not disagree about whether
   an ad belongs to a launch, or about where you go to say so.

   The module owns the link state (launches, links, initiatives), the two
   dialogs (same element ids as before, created on first use) and the writes
   to launch_system_links. A page supplies its Supabase client, how it scopes
   and pages a query, how to name an item, and what to redraw after a change.
   RLS on launch_system_links is the boundary; nothing here is a permission. */
(function () {
  'use strict';

  const REFS = {
    CREATIVE: 'meta_ad_creatives',
    CAMPAIGN: 'marketing_kpis_daily',
    REDO: 'redo_marketing_messages',
    // Klaviyo's own identity table: one row per campaign or flow message,
    // unique on (company, kind, klaviyo_id), so a link points at the message
    // rather than at one measurement window or one conversion metric.
    KLAVIYO: 'klaviyo_messages',
  };

  const DIALOG_STYLE = 'border:1px solid var(--bcn-border);border-radius:12px;padding:20px;max-width:min(440px,calc(100vw - 32px));width:100%;background:var(--bcn-surface);color:var(--bcn-ink);box-shadow:0 16px 48px #0004';
  const FIELD_STYLE = 'width:100%;padding:10px;border:1px solid var(--bcn-border);border-radius:7px;background:var(--bcn-surface);color:var(--bcn-ink)';
  const DIALOGS = `
      <dialog id="creativeLaunchDialog" style="${DIALOG_STYLE}">
        <form id="creativeLaunchForm">
          <h2 id="creativeLaunchTitle" style="margin:0 0 6px;font-size:17px">Link to launch</h2>
          <p id="creativeLaunchName" style="margin:0 0 16px;color:var(--bcn-ink-3);font-size:12px"></p>
          <label for="creativeLaunchSelect" style="display:block;font-size:11px;margin-bottom:6px">Launch</label>
          <select id="creativeLaunchSelect" required style="${FIELD_STYLE}"></select>
          <label for="creativeInitiativeSelect" id="creativeInitiativeLabel" style="display:block;font-size:11px;margin:12px 0 6px">Initiative (optional)</label>
          <select id="creativeInitiativeSelect" style="${FIELD_STYLE}"></select>
          <p id="creativeLaunchError" role="alert" style="min-height:18px;color:var(--bcn-neg);font-size:12px"></p>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="bcn-btn" id="creativeLaunchCancel">Cancel</button>
            <button type="submit" class="bcn-btn bcn-btn--primary" id="creativeLaunchSave">Link</button>
          </div>
        </form>
      </dialog>
      <dialog id="unlinkDialog" style="${DIALOG_STYLE}">
        <h2 style="margin:0 0 6px;font-size:17px">Remove this launch link?</h2>
        <p id="unlinkName" style="margin:0 0 6px;color:var(--bcn-ink);font-size:12px;font-weight:600"></p>
        <p id="unlinkDetail" style="margin:0 0 16px;color:var(--bcn-ink-3);font-size:12px"></p>
        <p id="unlinkError" role="alert" style="min-height:18px;color:var(--bcn-neg);font-size:12px"></p>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button type="button" class="bcn-btn" id="unlinkCancel">Cancel</button>
          <button type="button" class="bcn-btn bcn-btn--danger" id="unlinkConfirm">Unlink</button>
        </div>
      </dialog>`;

  /**
   * @param {object} o
   * @param {object} o.sb                 Supabase client
   * @param {(q:any)=>any} o.scope        adds the active-company filter to a query
   * @param {(build:()=>any)=>Promise<any[]>} o.loadPaged  the page's paged reader
   * @param {()=>({id:string}|null)} o.company             the active company
   * @param {(s:any)=>string} o.esc       HTML escape
   * @param {(source:string,id:string)=>string|undefined} o.nameOf   the item's display name
   * @param {(source:string,id:string)=>string|undefined} [o.channelOf]  channel used to sort initiatives ('meta' by default)
   * @param {()=>void} o.onChange         redraw after a link is added or removed
   * @param {(msg:string)=>void} [o.setStatus]
   */
  function create(o) {
    const el = (id) => document.getElementById(id);
    const companyId = () => o.company()?.id;
    let launches = [], initiatives = [], links = [], linkable = true, initiativeReady = false;
    let selected = null, pendingUnlink = null, wired = false;

    async function load() {
      try {
        const [l, linkResult, i] = await Promise.all([
          o.loadPaged(() => o.scope(o.sb.from('launch_calendar').select('id,title,launch_date')
            .order('launch_date', { ascending: false }).order('id', { ascending: true }))),
          (async () => {
            const query = (cols) => o.loadPaged(() => o.scope(o.sb.from('launch_system_links')
              .select(cols).eq('link_type', 'campaign').order('id', { ascending: true })));
            try { return { links: await query('id,launch_id,ref_table,ref_id,ref_label,channel_item_id'), ready: true }; }
            catch (e) { if (e.code !== '42703') throw e; return { links: await query('id,launch_id,ref_table,ref_id,ref_label'), ready: false }; }
          })(),
          o.loadPaged(() => o.scope(o.sb.from('launch_channel_items')
            .select('id,launch_id,company_entity_id,channel,item_title,scheduled_date')
            .order('scheduled_date', { ascending: true }).order('id', { ascending: true }))),
        ]);
        launches = l; links = linkResult.links; initiatives = i;
        initiativeReady = linkResult.ready;
        linkable = true;
      } catch (e) {
        console.warn('Launch links unavailable', e);
        launches = []; initiatives = []; links = []; linkable = false; initiativeReady = false;
      }
    }

    /** The chips for an item's launches plus the "+ Link" control.
     *  `bare`: draw nothing at all (not a dash) when links are unavailable.
     *  `linkLabel`: the control's text where no column heading says "Launch". */
    function cell(source, id, type, { bare = false, linkLabel = '+ Link' } = {}) {
      const esc = o.esc;
      const linked = links.filter((l) => l.ref_table === source && String(l.ref_id) === String(id))
        .map((l) => ({ link: l, launch: launches.find((x) => String(x.id) === String(l.launch_id)), channel_item_id: l.channel_item_id }))
        .filter((x) => x.launch);
      return linked.map(({ link, launch, channel_item_id }) => {
        const initiative = initiatives.find((c) => String(c.id) === String(channel_item_id));
        const label = `${launch.title || 'Launch'}${initiative ? ` · ${initiative.item_title}` : ''}`;
        // No link id (a pre-migration row, or an insert whose returning read was
        // refused) means no unlink control: a delete needs the exact row.
        const unlink = linkable && link.id
          ? `<button type="button" class="mo-unlink" data-unlink-id="${esc(link.id)}" title="Unlink from ${esc(label)}" aria-label="Unlink from ${esc(label)}">×</button>` : '';
        return `<span class="mo-link-chip"><a href="/v2/launch-calendar.html?launch=${encodeURIComponent(launch.id)}" class="bcn-pill mo-platform-pill" style="color:var(--bcn-accent)" title="${esc(initiative ? `Initiative: ${initiative.item_title}` : 'Open launch')}">${esc(label)}</a>${unlink}</span>`;
      }).join('')
        + (linkable ? `<button type="button" class="bcn-btn bcn-btn--ghost" data-link-source="${esc(source)}" data-link-id="${esc(id)}" data-link-type="${esc(type)}" style="padding:3px 6px;font-size:10px">${esc(linkLabel)}</button>` : (bare ? '' : '—'));
    }

    function wire() {
      if (wired) return;
      wired = true;
      if (!el('creativeLaunchDialog')) document.body.insertAdjacentHTML('beforeend', DIALOGS);
      el('creativeLaunchCancel').onclick = () => el('creativeLaunchDialog').close();
      el('creativeLaunchSelect').addEventListener('change', renderInitiativeChoices);
      el('creativeLaunchForm').addEventListener('submit', save);
      el('unlinkCancel').onclick = () => { el('unlinkDialog').close(); pendingUnlink = null; };
      el('unlinkConfirm').onclick = confirmUnlink;
    }

    function renderInitiativeChoices() {
      const select = el('creativeInitiativeSelect');
      select.replaceChildren();
      const launchId = el('creativeLaunchSelect').value;
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Launch only'; select.append(empty);
      const channel = selected ? String((o.channelOf && o.channelOf(selected.source, selected.id)) || 'meta').toLowerCase() : 'meta';
      const mine = initiatives.filter((c) => String(c.launch_id) === launchId && String(c.company_entity_id) === String(companyId()));
      const matches = mine.filter((c) => channel && String(c.channel).toLowerCase() === channel);
      for (const group of [matches, mine.filter((c) => !matches.includes(c))]) {
        for (const c of group) {
          const option = document.createElement('option'); option.value = c.id;
          option.textContent = `${c.item_title || 'Untitled'} · ${c.channel || 'other'}${c.scheduled_date ? ` · ${c.scheduled_date}` : ''}`;
          select.append(option);
        }
      }
      const enabled = initiativeReady && mine.length > 0;
      el('creativeInitiativeLabel').hidden = !enabled; select.hidden = !enabled; select.disabled = !enabled;
    }

    function open(source, id, type) {
      if (!linkable) return;
      if (!Object.values(REFS).includes(source)) return;
      const name = o.nameOf(source, id);
      if (!name) return;
      wire();
      selected = { source, id, name, type };
      el('creativeLaunchTitle').textContent = `Link ${type} to launch`;
      el('creativeLaunchSave').textContent = `Link ${type}`;
      el('creativeLaunchName').textContent = name;
      el('creativeLaunchError').textContent = '';
      const linked = new Set(links.filter((l) => l.ref_table === source && String(l.ref_id) === id).map((l) => String(l.launch_id)));
      const choices = launches.filter((l) => !linked.has(String(l.id)));
      const select = el('creativeLaunchSelect');
      select.replaceChildren();
      for (const launch of choices) {
        const option = document.createElement('option');
        option.value = launch.id;
        option.textContent = `${launch.title || 'Untitled launch'} · ${launch.launch_date || 'no date'}`;
        select.append(option);
      }
      renderInitiativeChoices();
      el('creativeLaunchSave').disabled = !choices.length;
      if (!launches.length) {
        // No launches at all is not "already linked": say so, and where to make one.
        const cal = document.createElement('a');
        cal.href = '/v2/launch-calendar.html';
        cal.textContent = 'Launch calendar';
        el('creativeLaunchError').append('There are no launches yet. Create one in the ', cal, `, then link this ${type} to it.`);
      } else if (!choices.length) el('creativeLaunchError').textContent = `This ${type} is already linked to every available launch.`;
      el('creativeLaunchDialog').showModal();
    }

    async function save(e) {
      e.preventDefault();
      if (!selected || !companyId()) return;
      const launchId = el('creativeLaunchSelect').value;
      if (!launches.some((l) => String(l.id) === launchId)) return;
      const initiativeId = initiativeReady ? el('creativeInitiativeSelect').value : '';
      if (initiativeId && !initiatives.some((c) => String(c.id) === initiativeId && String(c.launch_id) === launchId && String(c.company_entity_id) === String(companyId()))) return;
      const btn = el('creativeLaunchSave');
      btn.disabled = true;
      el('creativeLaunchError').textContent = '';
      const payload = {
        company_entity_id: companyId(), launch_id: launchId, link_type: 'campaign',
        ref_table: selected.source, ref_id: selected.id, ref_label: selected.name,
      };
      if (initiativeId) payload.channel_item_id = initiativeId;
      const { data: created, error } = await o.sb.from('launch_system_links').insert(payload).select('id').single();
      if (error) { el('creativeLaunchError').textContent = error.message; btn.disabled = false; return; }
      links.push({ id: created?.id, launch_id: launchId, ref_table: selected.source, ref_id: selected.id, ref_label: selected.name, channel_item_id: initiativeId || null });
      el('creativeLaunchDialog').close();
      o.onChange();
    }

    // Deleting a launch link removes only the association row; the Meta, Redo
    // and Shopify numbers behind it are untouched, and the same item can be
    // linked again. Confirmed first because the row carries which launch a
    // result was credited to, and nothing else records that.
    function openUnlink(linkId) {
      const link = links.find((l) => String(l.id) === String(linkId));
      if (!link) return;
      wire();
      pendingUnlink = link;
      const launch = launches.find((x) => String(x.id) === String(link.launch_id));
      el('unlinkName').textContent = link.ref_label || 'This item';
      el('unlinkDetail').textContent = `It stops counting toward “${launch?.title || 'this launch'}” on the Launch Workbench. No performance data changes, and you can link it again from this page.`;
      el('unlinkError').textContent = '';
      el('unlinkConfirm').disabled = false;
      el('unlinkDialog').showModal();
    }
    async function confirmUnlink() {
      if (!pendingUnlink?.id) return;
      const linkId = pendingUnlink.id;
      const btn = el('unlinkConfirm');
      btn.disabled = true;
      el('unlinkError').textContent = '';
      // .select() so a refusal (RLS, or the row already gone) comes back as zero
      // rows rather than a silent success that would blank the chip anyway.
      const { data, error } = await o.sb.from('launch_system_links').delete().eq('id', linkId).select();
      if (error) { el('unlinkError').textContent = error.message; btn.disabled = false; return; }
      if (!data || !data.length) { el('unlinkError').textContent = 'Nothing was removed. The link may already be gone, or you may not have permission to change it.'; btn.disabled = false; return; }
      links = links.filter((l) => String(l.id) !== String(linkId));
      pendingUnlink = null;
      el('unlinkDialog').close();
      o.onChange();
      if (o.setStatus) o.setStatus('Launch link removed.');
    }

    /** Delegated click handler for any container that draws cell(). Returns
     *  true when the click was a link or unlink control, so a page whose rows
     *  are themselves clickable can stop there. */
    function onClick(e) {
      const u = e.target.closest('[data-unlink-id]');
      if (u) { openUnlink(u.dataset.unlinkId); return true; }
      const b = e.target.closest('[data-link-source]');
      if (b) { open(b.dataset.linkSource, b.dataset.linkId, b.dataset.linkType); return true; }
      return false;
    }

    return { load, cell, onClick, get linkable() { return linkable; } };
  }

  window.SiloLaunchLinks = { create, REFS };
})();
