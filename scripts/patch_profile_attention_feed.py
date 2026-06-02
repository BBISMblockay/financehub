#!/usr/bin/env python3
"""Add data-driven attention feed to v2/profile.html (idempotent)."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "v2" / "profile.html"

FEED_JS = r'''
    function todayIso() {
      return new Date().toISOString().slice(0, 10);
    }

    function currentMonthBounds() {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth();
      const monthStart = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const last = new Date(y, m + 1, 0);
      return { monthStart, monthEnd: last.toISOString().slice(0, 10) };
    }

    function addDaysIso(iso, days) {
      const d = new Date(iso + 'T12:00:00');
      d.setDate(d.getDate() + days);
      return d.toISOString().slice(0, 10);
    }

    function normToken(s) {
      return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }

    function roleTokens(p) {
      const r = normToken(pickRole(p));
      const d = normToken(pickDepartment(p));
      const blob = `${r} ${d}`;
      return {
        isAdmin: /\badmin\b/.test(blob) || /\bowner\b/.test(blob) || r === 'owner',
        finance: /\bfinance\b/.test(blob) || /\baccounting\b/.test(blob) || /\bap\b/.test(blob) || /\bpayable\b/.test(blob),
        purchasing: /\bpurchas\b/.test(blob) || /\bbuyer\b/.test(blob) || /\bops\b/.test(blob) || /\boperations\b/.test(blob),
        marketing: /\bmarket\b/.test(blob) || /\bcreative\b/.test(blob) || /\bbrand\b/.test(blob),
        planning: /\bplanning\b/.test(blob) || /\bmerch\b/.test(blob),
      };
    }

    function feedVisibleFor(p) {
      const t = roleTokens(p);
      return t.isAdmin || t.finance || t.purchasing || t.marketing || t.planning;
    }

    async function countRows(table, applyFilters) {
      let q = db.from(table).select('*', { count: 'exact', head: true });
      if (applyFilters) q = applyFilters(q);
      const { count, error } = await q;
      if (error) return { ok: false, error };
      return { ok: true, count: count || 0 };
    }

    async function safeCount(table, applyFilters) {
      try {
        return await countRows(table, applyFilters);
      } catch (e) {
        return { ok: false, error: e };
      }
    }

    function pushFeedItem(items, item) {
      if (!item || !item.title) return;
      items.push(item);
    }

    async function loadPaymentAttention(items, tokens) {
      if (!tokens.isAdmin && !tokens.finance) return;
      const today = todayIso();
      const [openRes, newRes, needsRes, paidTodayRes, overdueRes] = await Promise.all([
        safeCount('payment_requests_v', q => q.eq('completed', false)),
        safeCount('payment_requests_v', q => q.eq('completed', false).eq('workflow_status', 'new')),
        safeCount('payment_requests_v', q => q.eq('completed', false).eq('workflow_status', 'needs_info')),
        safeCount('payment_requests_v', q => q.eq('date_completed', today)),
        safeCount('payment_requests_v', q => q.eq('completed', false).lt('due_date', today)),
      ]);
      if (!openRes.ok && !newRes.ok) return;
      if (newRes.ok && newRes.count > 0) {
        pushFeedItem(items, { kind: 'ap_new', title: `${newRes.count} new payment request${newRes.count === 1 ? '' : 's'}`, detail: 'Fresh submissions in Request Manager.', href: '/v2/request_manager.html', severity: 'high', count: newRes.count });
      }
      if (needsRes.ok && needsRes.count > 0) {
        pushFeedItem(items, { kind: 'ap_needs_info', title: `${needsRes.count} need more info`, detail: 'Waiting on follow-up before payment.', href: '/v2/request_manager.html', severity: 'warn', count: needsRes.count });
      }
      if (overdueRes.ok && overdueRes.count > 0) {
        pushFeedItem(items, { kind: 'ap_overdue', title: `${overdueRes.count} overdue AP request${overdueRes.count === 1 ? '' : 's'}`, detail: 'Due date is before today.', href: '/v2/request_manager.html', severity: 'high', count: overdueRes.count });
      }
      if (openRes.ok && openRes.count > 0) {
        pushFeedItem(items, { kind: 'ap_open', title: `${openRes.count} open payment request${openRes.count === 1 ? '' : 's'}`, detail: 'Non-completed items in the queue.', href: '/v2/request_manager.html', severity: openRes.count > 5 ? 'warn' : 'info', count: openRes.count });
      }
      if (paidTodayRes.ok && paidTodayRes.count > 0) {
        pushFeedItem(items, { kind: 'ap_paid_today', title: `${paidTodayRes.count} paid today`, detail: `Marked complete on ${today}.`, href: '/v2/request_manager.html', severity: 'info', count: paidTodayRes.count });
      }
    }

    async function loadPoAttention(items, tokens) {
      if (!tokens.isAdmin && !tokens.finance && !tokens.purchasing && !tokens.planning) return;
      const OPEN = ['Approved', 'Sent to Factory', 'Confirmed', 'In Production', 'Shipped', 'In Transit', 'Partially Received'];
      const today = todayIso();
      const weekEnd = addDaysIso(today, 7);
      let poRows = [];
      try {
        const { data, error } = await db.from('v_po_incoming_summary').select('id,status,expected_arrival_date,po_name').limit(2000);
        if (error) throw error;
        poRows = data || [];
      } catch (e) { return; }
      const open = poRows.filter(r => OPEN.includes(r.status));
      const arriving = open.filter(r => { const d = r.expected_arrival_date; return d && d >= today && d <= weekEnd; });
      if (open.length > 0) {
        pushFeedItem(items, { kind: 'po_open', title: `${open.length} open incoming PO${open.length === 1 ? '' : 's'}`, detail: 'Review receiving on PO Report.', href: '/v2/po-report.html', severity: open.length > 8 ? 'warn' : 'info', count: open.length });
      }
      if (arriving.length > 0) {
        pushFeedItem(items, { kind: 'po_arriving', title: `${arriving.length} arriving in 7 days`, detail: 'Expected arrival this week.', href: '/v2/po-report.html', severity: 'warn', count: arriving.length });
      }
    }

    async function loadLaunchAttention(items, tokens) {
      if (!tokens.isAdmin && !tokens.marketing && !tokens.planning) return;
      const today = todayIso();
      const weekEnd = addDaysIso(today, 7);
      let launches = [];
      try {
        const { data, error } = await db.from('launch_calendar').select('id,title,launch_date,launch_readiness').gte('launch_date', today).lte('launch_date', weekEnd).order('launch_date', { ascending: true }).limit(100);
        if (error) throw error;
        launches = data || [];
      } catch (e) { return; }
      const todayLaunches = launches.filter(l => l.launch_date === today);
      if (todayLaunches.length > 0) {
        const names = todayLaunches.slice(0, 3).map(l => l.title || 'Untitled').join(', ');
        pushFeedItem(items, { kind: 'launch_today', title: `${todayLaunches.length} launch${todayLaunches.length === 1 ? '' : 'es'} today`, detail: names + (todayLaunches.length > 3 ? '…' : ''), href: '/v2/launch-calendar.html', severity: 'high', count: todayLaunches.length });
      }
      const notReady = launches.filter(l => { const r = String(l.launch_readiness || '').toLowerCase(); return r && r !== 'ready'; });
      if (notReady.length > 0) {
        pushFeedItem(items, { kind: 'launch_readiness', title: `${notReady.length} launch${notReady.length === 1 ? '' : 'es'} not ready`, detail: 'Readiness needs review in the next 7 days.', href: '/v2/launch-calendar.html', severity: 'warn', count: notReady.length });
      }
      const overdueTasks = await safeCount('launch_tasks', q => q.neq('status', 'done').not('due_date', 'is', null).lt('due_date', today));
      if (overdueTasks.ok && overdueTasks.count > 0) {
        pushFeedItem(items, { kind: 'launch_tasks', title: `${overdueTasks.count} overdue launch task${overdueTasks.count === 1 ? '' : 's'}`, detail: 'Past due and not done.', href: '/v2/launch-calendar.html', severity: 'high', count: overdueTasks.count });
      }
      const atRisk = await safeCount('launch_product_readiness', q => q.eq('readiness_status', 'at_risk'));
      if (atRisk.ok && atRisk.count > 0) {
        pushFeedItem(items, { kind: 'launch_products', title: `${atRisk.count} product${atRisk.count === 1 ? '' : 's'} at risk`, detail: 'Product readiness flagged at_risk.', href: '/v2/launch-calendar.html', severity: 'warn', count: atRisk.count });
      }
    }

    async function loadProjectionAttention(items, tokens) {
      if (!tokens.isAdmin && !tokens.finance && !tokens.planning) return;
      const { monthStart, monthEnd } = currentMonthBounds();
      try {
        const { count, error } = await db.from('revenue_projections').select('*', { count: 'exact', head: true }).gte('projection_date', monthStart).lte('projection_date', monthEnd);
        if (error) throw error;
        if (!count) {
          pushFeedItem(items, { kind: 'proj_empty', title: 'No projections this month', detail: 'Seed revenue plan in Planning scenarios.', href: '/v2/planning-scenarios.html', severity: 'warn' });
        }
      } catch (e) { /* optional */ }
    }

    async function loadAdminAttention(items, tokens) {
      if (!tokens.isAdmin) return;
      try {
        const { data, error } = await db.rpc('admin_list_access_requests', { p_status: 'pending' });
        if (error) return;
        const n = Array.isArray(data) ? data.length : 0;
        if (n > 0) {
          pushFeedItem(items, { kind: 'admin_access', title: `${n} access request${n === 1 ? '' : 's'} pending`, detail: 'Approve in Backend hub.', href: '/v2/backend.html', severity: 'warn', count: n });
        }
      } catch (e) { /* optional */ }
    }

    const SEVERITY_ORDER = { high: 0, warn: 1, info: 2 };

    function renderAttentionFeed() {
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
    }

    async function loadAttentionFeed() {
      if (!db || !profile) return;
      if (!feedVisibleFor(profile)) {
        els.attentionAside.hidden = true;
        return;
      }
      els.attentionAside.hidden = false;
      els.feedStatus.textContent = 'Checking SILO data…';
      els.feedEmpty.hidden = true;
      els.feedList.hidden = false;
      attentionItems = [];
      const tokens = roleTokens(profile);
      await Promise.all([
        loadPaymentAttention(attentionItems, tokens),
        loadPoAttention(attentionItems, tokens),
        loadLaunchAttention(attentionItems, tokens),
        loadProjectionAttention(attentionItems, tokens),
        loadAdminAttention(attentionItems, tokens),
      ]);
      renderAttentionFeed();
      const n = attentionItems.length;
      els.feedStatus.textContent = n
        ? `${n} item${n === 1 ? '' : 's'} · ${new Date().toLocaleTimeString()}`
        : `No flags · ${new Date().toLocaleTimeString()}`;
    }
'''


def main() -> None:
    text = PATH.read_text(encoding="utf-8")

    if ".profile-feed-source" not in text:
        text = text.replace(
            "    #bootStatus { font-size: 12px; color: var(--bcn-ink-3); padding: 8px 0; }\n  </style>",
            "    #bootStatus { font-size: 12px; color: var(--bcn-ink-3); padding: 8px 0; }\n"
            "    .profile-feed-source { margin-top: 10px; font-size: 10px; font-family: var(--bcn-mono); color: var(--bcn-ink-3); }\n  </style>",
        )

    text = text.replace(
        "Your SILO account from Supabase Auth and the <code>profiles</code> table.",
        "Account settings plus a live attention feed from AP, POs, launches, and planning data.",
    )

    if "profile-layout" not in text:
        text = text.replace(
            '<div class="profile-wrap">',
            '<div class="profile-layout">',
        )
        text = text.replace(
            '<p id="bootStatus">Loading profile…</p>',
            '<p id="bootStatus" style="grid-column:1/-1;">Loading profile…</p>',
        )
        text = text.replace(
            '<div id="loadErr" class="bcn-card bcn-card--err" hidden>',
            '<div id="loadErr" class="bcn-card bcn-card--err" style="grid-column:1/-1;" hidden>',
        )
        text = text.replace(
            '<div id="loadWarn" class="bcn-card bcn-card--warn" hidden>',
            '<div id="loadWarn" class="bcn-card bcn-card--warn" style="grid-column:1/-1;" hidden>',
        )
        text = text.replace(
            '\n        <section class="bcn-card" id="summaryCard" hidden>',
            '\n        <div class="profile-layout__main">\n        <section class="bcn-card" id="summaryCard" hidden>',
            1,
        )
        text = text.replace(
            "        </section>\n      </div>\n    </main>",
            """        </section>
        </div>

        <aside class="profile-layout__aside" id="attentionAside" hidden aria-label="Needs attention">
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
        </aside>
      </div>
    </main>""",
            1,
        )

    if "attentionAside" not in text.split("const els")[0]:
        raise SystemExit("HTML aside missing after patch")

    if "feedStatus:" not in text:
        text = text.replace(
            "      saveStatus: document.getElementById('saveStatus'),\n    };",
            """      saveStatus: document.getElementById('saveStatus'),
      attentionAside: document.getElementById('attentionAside'),
      feedStatus: document.getElementById('feedStatus'),
      feedList: document.getElementById('feedList'),
      feedEmpty: document.getElementById('feedEmpty'),
      btnFeedRefresh: document.getElementById('btnFeedRefresh'),
    };

    let attentionItems = [];""",
        )

    if "async function loadAttentionFeed" not in text:
        text = text.replace(
            """    function pickName(p) {
      if (!p) return '';
      return (p.name || p.full_name || '').trim();
    }

    function renderLandingOptions""",
            """    function pickName(p) {
      if (!p) return '';
      return (p.name || p.full_name || '').trim();
    }
"""
            + FEED_JS
            + """
    function renderLandingOptions""",
        )

    def ensure_feed_call(block: str) -> str:
        if "loadAttentionFeed" in block:
            return block
        return block.replace(
            "els.bootStatus.textContent = '';\n        return;",
            "els.bootStatus.textContent = '';\n        loadAttentionFeed().catch(e => console.warn('attention feed', e));\n        return;",
        )

    text = re.sub(
        r"(if \(error\) \{.*?return;\n      \})",
        lambda m: ensure_feed_call(m.group(1)),
        text,
        count=1,
        flags=re.S,
    )
    text = re.sub(
        r"(if \(!data\) \{.*?return;\n      \})",
        lambda m: ensure_feed_call(m.group(1)),
        text,
        count=1,
        flags=re.S,
    )

    if "loadAttentionFeed().catch" not in text.split("profile = data")[1].split("async function saveProfile")[0]:
        text = text.replace(
            "      mountChrome();\n      els.bootStatus.textContent = '';\n    }\n\n    async function saveProfile()",
            "      mountChrome();\n      els.bootStatus.textContent = '';\n      loadAttentionFeed().catch(e => console.warn('attention feed', e));\n    }\n\n    async function saveProfile()",
            1,
        )

    if "btnFeedRefresh.addEventListener" not in text:
        text = text.replace(
            "els.btnReload.addEventListener('click', () => loadProfile().catch(e => alert(e.message || e)));\n\n      try {",
            "els.btnReload.addEventListener('click', () => loadProfile().catch(e => alert(e.message || e)));\n      els.btnFeedRefresh.addEventListener('click', () => loadAttentionFeed().catch(e => alert(e.message || e)));\n\n      try {",
        )

    # fix bad indentation if present
    text = text.replace(
        "        els.bootStatus.textContent = '';\n                loadAttentionFeed()",
        "        els.bootStatus.textContent = '';\n        loadAttentionFeed()",
    )

    PATH.write_text(text, encoding="utf-8")
    assert "async function loadAttentionFeed" in text
    assert "profile-layout" in text
    print(f"OK {PATH} ({len(text.splitlines())} lines)")


if __name__ == "__main__":
    main()
