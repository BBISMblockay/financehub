/* One date-range control for every Marketing surface.

   Marketing used to be read in buckets -- 7d / 14d / 30d / 90d on Overview,
   7d / 28d / 90d on Search performance -- while Explorer alone let you type a
   calendar start and end. Blake asked for the Explorer behaviour everywhere
   (2026-11-20: "we need to ensure that we can slice and dice by day like on
   explorer"), so this is Explorer's own control extracted, unchanged in
   behaviour, for the other pages to mount.

   What it owns: the two <input type="date"> fields, the quick-pick buttons and
   the selection they agree on. What it does NOT own: the address bar, the
   queries, or the reload. Each page keeps its own URL writer and its own
   loader and calls `urlParams()` / `get()`; that is deliberate, because the
   pages carry different keys (Overview and Explorer share days|start+end,
   Search performance anchors on the newest INGESTED day, not today) and a
   shared control that rewrote URLs would have to know all of them.

   The selection is always a real start and end. A rolling quick pick also
   records itself as `preset` ('7', '30', 'ytd', 'all'), which is what keeps a
   "last 30 days" link rolling instead of freezing into two dates when it is
   shared or carried to another tab. Typing either field clears the preset.

   Generic by design: no company, table or metric is named here. A page that
   needs "all time" passes an `earliest()` callback; nothing else is injected.

   Usage:
     const dr = window.SiloDateRange.create({
       mount: '#rangeCtl',
       presets: [{ days: 7 }, { days: 30 }, { days: 90 }, { preset: 'ytd' }],
       onChange: () => { writeUrl(); runLoad(); },
       earliest: async () => '2024-01-01',   // optional, for { preset: 'all' }
     });
     await dr.applyFromUrl(location.search, { fallbackDays: 30 });
*/
(function () {
  'use strict';

  const iso = (d) => d.toISOString().slice(0, 10);
  const today = () => iso(new Date());
  const addDays = (isoStr, n) => {
    const d = new Date(isoStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return iso(d);
  };
  const spanDays = (a, b) =>
    Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
  const isDays = (v) => /^[1-9]\d{0,3}$/.test(String(v || ''));
  // A real calendar day, not just the shape of one (2026-02-31 is refused).
  const isIsoDay = (v) => {
    try {
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
        && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
    } catch { return false; }
  };

  const labelFor = (p) => p.label
    || (p.days ? (p.days === 365 ? '1y' : `${p.days}d`) : String(p.preset || '').toUpperCase());

  function create(opts) {
    const o = opts || {};
    const host = typeof o.mount === 'string' ? document.querySelector(o.mount) : o.mount;
    const presets = (o.presets || [{ days: 7 }, { days: 30 }, { days: 90 }]).slice();
    const state = { start: null, end: null, preset: null };

    // Fail-soft: a page whose mount point is missing still gets a working
    // selection object, it just has nothing to draw into.
    const wrap = host ? document.createElement('div') : null;
    let startEl = null, endEl = null, btns = [];

    if (wrap) {
      wrap.className = 'sdr';
      const range = document.createElement('div');
      range.className = 'sdr-range';
      startEl = document.createElement('input');
      startEl.type = 'date';
      startEl.setAttribute('aria-label', 'Start date');
      const to = document.createElement('span');
      to.textContent = 'to';
      endEl = document.createElement('input');
      endEl.type = 'date';
      endEl.setAttribute('aria-label', 'End date');
      range.append(startEl, to, endEl);

      const group = document.createElement('div');
      group.className = 'sdr-presets';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Quick date ranges');
      for (const p of presets) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bcn-btn bcn-btn--ghost';
        b.textContent = labelFor(p);
        if (p.days) b.dataset.days = String(p.days);
        else b.dataset.preset = String(p.preset);
        if (p.title) b.title = p.title;
        group.append(b);
        btns.push(b);
      }
      wrap.append(range, group);
      host.append(wrap);
    }

    function paint() {
      if (startEl) startEl.value = state.start || '';
      if (endEl) endEl.value = state.end || '';
      for (const b of btns) {
        const key = b.dataset.days || b.dataset.preset;
        b.classList.toggle('is-active', !!state.preset && key === state.preset);
      }
    }

    function get() {
      return {
        start: state.start,
        end: state.end,
        preset: state.preset,
        days: state.start && state.end ? spanDays(state.start, state.end) : null,
        rolling: isDays(state.preset),
      };
    }

    // What the page should put in the address bar: a day count while a rolling
    // quick pick is active (so the link keeps rolling), the dates themselves
    // otherwise. YTD and All resolve to dates on purpose -- "year to date"
    // means a different range tomorrow, and a shared link should not move.
    function urlParams() {
      return isDays(state.preset)
        ? { days: state.preset, start: null, end: null }
        : { days: null, start: state.start, end: state.end };
    }

    // Resolve a selection into a real start/end. Returns null when it cannot
    // (an unknown preset, a backwards range), and the caller keeps what it had.
    async function resolve(sel) {
      const s = sel || {};
      const now = today();
      if (isDays(s.days)) {
        return { start: addDays(now, -(Number(s.days) - 1)), end: now, preset: String(s.days) };
      }
      if (s.preset === 'ytd') {
        return { start: `${now.slice(0, 4)}-01-01`, end: now, preset: 'ytd' };
      }
      if (s.preset === 'all') {
        let first = null;
        try { first = await o.earliest?.(); } catch { first = null; }
        return { start: isIsoDay(first) ? first : addDays(now, -365), end: now, preset: 'all' };
      }
      if (isIsoDay(s.start) && isIsoDay(s.end) && s.start <= s.end) {
        // `preset` with explicit dates is for a page whose rolling window is
        // anchored on something other than today -- Search performance ends on
        // the newest day Google has FINALISED, two or three days back. It
        // shows the days it really loaded while the quick pick stays lit, so
        // the link keeps rolling and the fields are not telling a small lie.
        return { start: s.start, end: s.end, preset: isDays(s.preset) || s.preset === 'ytd' || s.preset === 'all' ? String(s.preset) : null };
      }
      return null;
    }

    // Set the selection without telling the page (it is already acting).
    async function apply(sel) {
      const next = await resolve(sel);
      if (!next) return get();
      state.start = next.start; state.end = next.end; state.preset = next.preset;
      paint();
      return get();
    }

    // Set the selection the way a click would: apply, then hand the page the
    // change so it can write the URL and reload.
    async function pick(sel) {
      const before = `${state.start}|${state.end}|${state.preset}`;
      const out = await apply(sel);
      if (`${state.start}|${state.end}|${state.preset}` !== before) o.onChange?.(out);
      return out;
    }

    // The address bar is the selection: days=N, or start+end, else the page's
    // own default. Silent -- boot reloads once on its own.
    async function applyFromUrl(search, { fallbackDays } = {}) {
      const q = new URLSearchParams(search || '');
      const days = q.get('days'), s = q.get('start'), e = q.get('end');
      const fallback = { days: String(fallbackDays || o.defaultDays || 30) };
      if (isDays(days)) return apply({ days });
      if (isIsoDay(s) && isIsoDay(e) && s <= e) return apply({ start: s, end: e });
      return apply(fallback);
    }

    if (startEl && endEl) {
      const onTyped = () => {
        const s = startEl.value, e = endEl.value;
        // An incomplete or backwards pair is not a range: put back what was
        // showing rather than loading something nobody asked for.
        if (!s || !e || s > e) { paint(); return; }
        if (s === state.start && e === state.end && state.preset == null) return;
        pick({ start: s, end: e });
      };
      startEl.addEventListener('change', onTyped);
      endEl.addEventListener('change', onTyped);
      for (const b of btns) {
        b.addEventListener('click', () => pick(b.dataset.days ? { days: b.dataset.days } : { preset: b.dataset.preset }));
      }
    }

    return { get, urlParams, apply, pick, applyFromUrl, paint, el: wrap };
  }

  window.SiloDateRange = { create, iso, today, addDays, spanDays, isDays, isIsoDay };
})();
