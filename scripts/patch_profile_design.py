#!/usr/bin/env python3
"""Polish profile page visual design — hero + attention feed cards."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / "v2" / "profile.html"

t = PROFILE.read_text(encoding="utf-8")

t = t.replace(
    "Account settings plus a live attention feed from AP, POs, launches, and planning data.",
    "Your account, preferences, and a live work queue pulled from SILO.",
)

t = t.replace(
    """        <section class="bcn-card" id="summaryCard" hidden>
          <header class="bcn-card-header bcn-card-header--dark">
            <span class="bcn-pill bcn-pill--dark">ACCOUNT</span>
            <h2>Signed in as</h2>
          </header>
          <div class="bcn-card-body">
            <dl class="profile-summary-grid" id="summaryDl"></dl>
          </div>
        </section>""",
    """        <section class="bcn-card profile-hero-card" id="summaryCard" hidden>
          <div class="profile-hero" id="profileHero"></div>
          <details class="profile-hero-details">
            <summary>Account details</summary>
            <dl class="profile-summary-grid" id="summaryDl"></dl>
          </details>
        </section>""",
)

t = t.replace(
    """        <aside class="profile-layout__aside" id="attentionAside" aria-label="Needs attention">
          <section class="bcn-card profile-attention-card" id="attentionCard">
            <header class="bcn-card-header bcn-card-header--dark">
              <span class="bcn-pill bcn-pill--dark">ATTENTION</span>
              <h2>Needs attention</h2>
            </header>
            <div class="bcn-card-body">
              <p class="hint" style="margin:0 0 8px;">Live signals from SILO — payment requests, POs, launches, and admin queues.</p>
              <p id="feedStatus" class="profile-feed-status">Loading…</p>
              <ul id="feedList" class="profile-feed-list" role="list"></ul>
              <p id="feedEmpty" class="profile-feed-empty" hidden>Nothing flagged right now.</p>
              <button type="button" class="bcn-btn bcn-btn--ghost bcn-btn--mono" id="btnFeedRefresh" style="margin-top:10px;width:100%;">REFRESH FEED</button>
            </div>
          </section>
        </aside>""",
    """        <aside class="profile-layout__aside" id="attentionAside" aria-label="Work queue">
          <section class="profile-queue-card" id="attentionCard">
            <header class="profile-queue-header">
              <div class="profile-queue-header__mark" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
              </div>
              <div class="profile-queue-header__text">
                <h2>Work queue</h2>
                <p>What needs your eyes right now</p>
              </div>
              <span class="profile-queue-header__badge" id="feedCountBadge" hidden>0</span>
            </header>
            <div class="profile-queue-body">
              <p id="feedStatus" class="profile-feed-status">Checking SILO…</p>
              <div id="feedList" class="profile-feed-groups" role="list"></div>
              <div id="feedEmpty" class="profile-feed-empty" hidden>
                <div class="profile-feed-empty__icon" aria-hidden="true">✓</div>
                <p class="profile-feed-empty__title">All clear</p>
                <p class="profile-feed-empty__sub">No open flags from AP, POs, launches, or admin.</p>
              </div>
              <button type="button" class="profile-feed-refresh" id="btnFeedRefresh">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
                Refresh queue
              </button>
            </div>
          </section>
        </aside>""",
)

# Add feedCountBadge to els
if "feedCountBadge" not in t:
    t = t.replace(
        "feedEmpty: document.getElementById('feedEmpty'),\n      btnFeedRefresh:",
        "feedEmpty: document.getElementById('feedEmpty'),\n      feedCountBadge: document.getElementById('feedCountBadge'),\n      profileHero: document.getElementById('profileHero'),\n      btnFeedRefresh:",
    )

FEED_UI = r'''
    const FEED_KIND_META = {
      ap_new: { domain: 'Payables', workspace: 'Request Manager', icon: 'wallet' },
      ap_needs_info: { domain: 'Payables', workspace: 'Request Manager', icon: 'wallet' },
      ap_overdue: { domain: 'Payables', workspace: 'Request Manager', icon: 'wallet' },
      ap_open: { domain: 'Payables', workspace: 'Request Manager', icon: 'wallet' },
      ap_paid_today: { domain: 'Payables', workspace: 'Request Manager', icon: 'wallet' },
      po_open: { domain: 'Purchasing', workspace: 'PO Report', icon: 'package' },
      po_arriving: { domain: 'Purchasing', workspace: 'PO Report', icon: 'package' },
      launch_today: { domain: 'Launches', workspace: 'Launch calendar', icon: 'rocket' },
      launch_readiness: { domain: 'Launches', workspace: 'Launch calendar', icon: 'rocket' },
      launch_tasks: { domain: 'Launches', workspace: 'Launch calendar', icon: 'rocket' },
      launch_products: { domain: 'Launches', workspace: 'Launch calendar', icon: 'rocket' },
      proj_empty: { domain: 'Planning', workspace: 'Planning scenarios', icon: 'chart' },
      admin_access: { domain: 'Admin', workspace: 'Backend hub', icon: 'shield' },
    };

    function feedKindMeta(kind) {
      return FEED_KIND_META[kind] || { domain: 'SILO', workspace: 'Open', icon: 'bell' };
    }

    function profileInitials(name, email) {
      const n = String(name || '').trim();
      if (n) {
        return n.split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
      }
      const e = String(email || '').trim();
      return e ? e[0].toUpperCase() : '?';
    }

    function feedIconSvg(icon) {
      const icons = {
        wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><circle cx="16" cy="14" r="1.2" fill="currentColor" stroke="none"/></svg>',
        package: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
        rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.07-2.91a2.18 2.18 0 0 0-2.91-.07z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/></svg>',
        chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v18h18"/><path d="M7 16v-4M12 16V8M17 16v-6"/></svg>',
        shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
        bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
      };
      return icons[icon] || icons.bell;
    }

    function severityLabel(sev) {
      if (sev === 'high') return 'Urgent';
      if (sev === 'warn') return 'Review';
      return 'Info';
    }

    function renderFeedCard(it) {
      const meta = feedKindMeta(it.kind);
      const count = it.count != null ? `<span class="profile-feed-card__count">${esc(it.count)}</span>` : '';
      return `<a class="profile-feed-card profile-feed-card--${esc(it.severity)}" href="${esc(it.href)}" role="listitem">
        <span class="profile-feed-card__icon profile-feed-card__icon--${esc(meta.icon)}" aria-hidden="true">${feedIconSvg(meta.icon)}</span>
        <span class="profile-feed-card__body">
          <span class="profile-feed-card__eyebrow">${esc(meta.workspace)} · <em>${esc(severityLabel(it.severity))}</em></span>
          <span class="profile-feed-card__title">${esc(it.title)}</span>
          <span class="profile-feed-card__detail">${esc(it.detail)}</span>
        </span>
        <span class="profile-feed-card__trail">
          ${count}
          <span class="profile-feed-card__chev" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></span>
        </span>
      </a>`;
    }
'''

if "FEED_KIND_META" not in t:
    t = t.replace("    const SEVERITY_ORDER = { high: 0, warn: 1, info: 2 };", FEED_UI + "\n    const SEVERITY_ORDER = { high: 0, warn: 1, info: 2 };")

OLD_RENDER = """    function renderAttentionFeed() {
      const sorted = attentionItems.slice().sort((a, b) => {
        const sa = SEVERITY_ORDER[a.severity] ?? 9;
        const sb = SEVERITY_ORDER[b.severity] ?? 9;
        if (sa !== sb) return sa - sb;
        return (b.count || 0) - (a.count || 0);
      });
      els.feedList.innerHTML = sorted.map(it => {
        const badge = it.count != null ? `<span class="profile-feed-item__badge">${esc(it.count)}</span>` : '';
        return `<li role="listitem"><a class="profile-feed-item profile-feed-item--${esc(it.severity)}" href="${esc(it.href)}"><div class="profile-feed-item__row"><span class="profile-feed-item__title">${esc(it.title)}</span>${badge}</div><div class="profile-feed-item__detail">${esc(it.detail)}</div></a></li>`;
      }).join('');
      els.feedEmpty.hidden = sorted.length > 0;
      els.feedList.hidden = sorted.length === 0;
    }"""

NEW_RENDER = """    function renderAttentionFeed() {
      const sorted = attentionItems.slice().sort((a, b) => {
        const sa = SEVERITY_ORDER[a.severity] ?? 9;
        const sb = SEVERITY_ORDER[b.severity] ?? 9;
        if (sa !== sb) return sa - sb;
        return (b.count || 0) - (a.count || 0);
      });

      const groups = new Map();
      sorted.forEach(it => {
        const domain = feedKindMeta(it.kind).domain;
        if (!groups.has(domain)) groups.set(domain, []);
        groups.get(domain).push(it);
      });

      const domainOrder = ['Payables', 'Purchasing', 'Launches', 'Planning', 'Admin', 'SILO'];
      const orderedDomains = [...groups.keys()].sort((a, b) => {
        const ia = domainOrder.indexOf(a);
        const ib = domainOrder.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });

      els.feedList.innerHTML = orderedDomains.map(domain => `
        <section class="profile-feed-group" aria-label="${esc(domain)}">
          <h3 class="profile-feed-group__label">${esc(domain)}</h3>
          <div class="profile-feed-group__list" role="list">
            ${groups.get(domain).map(renderFeedCard).join('')}
          </div>
        </section>
      `).join('');

      els.feedEmpty.hidden = sorted.length > 0;
      els.feedList.hidden = sorted.length === 0;
      if (els.feedCountBadge) {
        els.feedCountBadge.hidden = sorted.length === 0;
        els.feedCountBadge.textContent = String(sorted.length);
      }
    }"""

if OLD_RENDER in t:
    t = t.replace(OLD_RENDER, NEW_RENDER)

OLD_SUMMARY = """    function renderSummary() {
      const email = profile?.email || authUser?.email || authUser?.user_metadata?.email || '—';
      const rows = [
        ['Email', email],
        ['User ID', authUser?.id || '—'],
        ['Display name', pickName(profile) || '—'],
        ['Role', pickRole(profile)],
        ['Department', pickDepartment(profile)],
        ['Active', profile?.is_active === false ? 'No' : (profile ? 'Yes' : 'Unknown')],
        ['Default page', profile?.default_page || '(department default)'],
      ];
      if (profile?.updated_at) rows.push(['Profile updated', new Date(profile.updated_at).toLocaleString()]);
      if (profile?.created_at) rows.push(['Profile created', new Date(profile.created_at).toLocaleString()]);

      els.summaryDl.innerHTML = rows.map(([k, v]) =>
        `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`
      ).join('');
    }"""

NEW_SUMMARY = """    function renderSummary() {
      const email = profile?.email || authUser?.email || authUser?.user_metadata?.email || '—';
      const displayName = pickName(profile) || email.split('@')[0] || 'User';
      const role = pickRole(profile);
      const dept = pickDepartment(profile);
      const active = profile ? profile.is_active !== false : true;
      const rows = [
        ['Email', email],
        ['User ID', authUser?.id || '—'],
        ['Display name', pickName(profile) || '—'],
        ['Role', role],
        ['Department', dept],
        ['Active', active ? 'Yes' : 'No'],
        ['Default page', profile?.default_page || '(department default)'],
      ];
      if (profile?.updated_at) rows.push(['Profile updated', new Date(profile.updated_at).toLocaleString()]);
      if (profile?.created_at) rows.push(['Profile created', new Date(profile.created_at).toLocaleString()]);

      els.summaryDl.innerHTML = rows.map(([k, v]) =>
        `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`
      ).join('');

      if (els.profileHero) {
        els.profileHero.innerHTML = `
          <div class="profile-hero__avatar" aria-hidden="true">${esc(profileInitials(pickName(profile), email))}</div>
          <div class="profile-hero__body">
            <p class="profile-hero__eyebrow">Signed in</p>
            <h2 class="profile-hero__name">${esc(displayName)}</h2>
            <p class="profile-hero__email">${esc(email)}</p>
            <div class="profile-hero__chips">
              <span class="profile-chip profile-chip--role">${esc(role)}</span>
              <span class="profile-chip profile-chip--dept">${esc(dept)}</span>
              <span class="profile-chip profile-chip--${active ? 'active' : 'inactive'}">${active ? 'Active' : 'Inactive'}</span>
            </div>
          </div>`;
      }
    }"""

if OLD_SUMMARY in t:
    t = t.replace(OLD_SUMMARY, NEW_SUMMARY)

# Softer loadAttentionFeed status text
t = t.replace(
    "els.feedStatus.textContent = n\n        ? `${n} item${n === 1 ? '' : 's'} · ${new Date().toLocaleTimeString()}`\n        : `No flags · ${new Date().toLocaleTimeString()}`;",
    "els.feedStatus.textContent = n\n        ? `Updated ${new Date().toLocaleTimeString()} · ${n} open item${n === 1 ? '' : 's'}`\n        : `Updated ${new Date().toLocaleTimeString()} · queue clear`;",
)

PROFILE.write_text(t, encoding="utf-8")
print("profile.html patched", len(t.splitlines()), "lines")
