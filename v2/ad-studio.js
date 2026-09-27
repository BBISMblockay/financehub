/* /v2/ad-studio.html's decisions, kept out of the page so node can run them.
 *
 * Ad Studio reads ad_studio_ads() -- per-ad SUMS, never a ratio -- and turns
 * them into baselines: each objective judged on the metric it was bought on,
 * every rate POOLED from its parts (sum of value / sum of spend), never an
 * average of per-ad rates. v3/js/metrics.js is the precedent: 2% over 100
 * sessions and 10% over 10,000 is 9.9%, not 6%.
 *
 * The rules a test pins:
 *   - An absent measure is not a zero. An ad with no thruplays reported was
 *     not measured on thruplays; a metric whose denominator is zero is null.
 *   - Every number is labelled with its evidence (strong / moderate / early),
 *     from the VOLUME behind it -- never a percentage confidence.
 *   - conversion_value is META-REPORTED revenue; ROAS says so wherever shown.
 *   - The bar an idea must beat is frozen when the idea is made (snapshot),
 *     and a launched idea is measured against that bar only once its own
 *     volume reaches the same evidence floor.
 *   - Findings are observations from the numbers, worded as such, never a
 *     claim about why an ad worked.
 *   - A cost is compared as a cost: "Higher cost · +$0.14", never "21% below
 *     baseline" beside a bigger number.
 *   - Catalog placeholders ({{product.brand}}) are Meta's per-product fields,
 *     not copy: they never reach a hook or an Ask SILO prompt.
 */
(function () {
  'use strict';

  function num(v) { var n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function div(a, b) { a = num(a); b = num(b); return a == null || b == null || b === 0 ? null : a / b; }

  /* ── Metrics ───────────────────────────────────────────────────────────── */
  // part: which sum is the denominator, and how much of it makes evidence.
  var METRICS = {
    roas: { label: 'ROAS (Meta-reported)', short: 'ROAS', better: 'higher', fmt: 'x',
      of: function (s) { return div(s.conversion_value, s.spend); }, vol: 'conversions', floors: [15, 50] },
    cpa: { label: 'Cost per purchase', short: 'CPA', better: 'lower', fmt: '$',
      of: function (s) { return div(s.spend, s.conversions); }, vol: 'conversions', floors: [15, 50] },
    ctr: { label: 'Click-through rate', short: 'CTR', better: 'higher', fmt: '%',
      of: function (s) { return div(s.clicks, s.impressions); }, vol: 'clicks', floors: [100, 500] },
    cpc: { label: 'Cost per click', short: 'CPC', better: 'lower', fmt: '$',
      of: function (s) { return div(s.spend, s.clicks); }, vol: 'clicks', floors: [100, 500] },
    cpm: { label: 'Cost per 1,000 impressions', short: 'CPM', better: 'lower', fmt: '$',
      of: function (s) { var r = div(s.spend, s.impressions); return r == null ? null : r * 1000; }, vol: 'impressions', floors: [10000, 100000] },
    cost_per_thruplay: { label: 'Cost per ThruPlay', short: 'Cost/ThruPlay', better: 'lower', fmt: '$4',
      of: function (s) { return div(s.spend, s.thruplays); }, vol: 'thruplays', floors: [2000, 10000] },
    cost_per_lead: { label: 'Cost per lead', short: 'Cost/lead', better: 'lower', fmt: '$',
      of: function (s) { return div(s.spend, s.leads); }, vol: 'leads', floors: [25, 100] },
  };

  // What each objective is judged on. Followers: Meta reports no follow count
  // in this data, so the page says it judges them on CTR rather than
  // pretending to a cost-per-follow.
  var OBJECTIVES = [
    { key: 'purchase', label: 'Purchase', primary: 'roas', secondary: ['cpa', 'ctr'] },
    { key: 'thruplay', label: 'ThruPlay / video', primary: 'cost_per_thruplay', secondary: ['ctr', 'cpm'] },
    { key: 'subscribers', label: 'Subscribers', primary: 'cost_per_lead', secondary: ['ctr', 'cpc'] },
    { key: 'traffic', label: 'Traffic', primary: 'cpc', secondary: ['ctr', 'cpm'] },
    { key: 'followers', label: 'Followers', primary: 'ctr', secondary: ['cpc', 'cpm'],
      note: 'Meta does not report follows in SILO’s data, so followers ads are compared on click-through rate.' },
    { key: 'other', label: 'Other / unclassified', primary: 'ctr', secondary: ['cpc', 'cpm'],
      note: 'Campaign names that do not say what they were bought on. Compared on click-through rate.' },
  ];
  var OBJ = {};
  OBJECTIVES.forEach(function (o) { OBJ[o.key] = o; });
  function objective(key) { return OBJ[key] || OBJ.other; }

  var SUM_KEYS = ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value', 'thruplays', 'leads'];
  /** Pool rows into sums. A measure no row reported stays null. */
  function pool(rows) {
    var s = { ads: 0 };
    SUM_KEYS.forEach(function (k) { s[k] = null; });
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r) return;
      s.ads += 1;
      SUM_KEYS.forEach(function (k) {
        var v = num(r[k]);
        if (v != null) s[k] = (s[k] || 0) + v;
      });
    });
    return s;
  }
  function metric(sums, key) { var m = METRICS[key]; return m && sums ? m.of(sums) : null; }
  /** strong / moderate / early from the volume behind a metric, or null. */
  function evidence(sums, key) {
    var m = METRICS[key];
    if (!m || !sums) return null;
    var v = num(sums[m.vol]);
    if (v == null) return null;
    return v >= m.floors[1] ? 'strong' : v >= m.floors[0] ? 'moderate' : 'early';
  }
  /** How many of the metric's volume unit it takes to be at least moderate. */
  function evidenceNeed(sums, key) {
    var m = METRICS[key];
    var v = num(sums && sums[m.vol]) || 0;
    return { have: v, need: m.floors[0], unit: m.vol };
  }
  /** Performance relative to a baseline, direction-adjusted: 1.5 = 50% better. */
  function indexVs(value, base, key) {
    var m = METRICS[key];
    if (!m || value == null || base == null || value <= 0 || base <= 0) return null;
    return m.better === 'higher' ? value / base : base / value;
  }

  /** The objective's baseline: pooled over its ads with at least minSpend. */
  function baseline(ads, objKey, opts) {
    var o = objective(objKey);
    var minSpend = (opts && opts.minSpend != null) ? opts.minSpend : 100;
    var rows = (ads || []).filter(function (a) { return a && (a.objective || 'other') === o.key && (num(a.spend) || 0) >= minSpend; });
    var sums = pool(rows);
    return { objective: o.key, metric: o.primary, value: metric(sums, o.primary), evidence: evidence(sums, o.primary), sums: sums, ads: rows.length, minSpend: minSpend };
  }

  /** Score each ad against its objective's baseline. Pure; returns new rows. */
  function score(ads, opts) {
    var bases = {};
    OBJECTIVES.forEach(function (o) { bases[o.key] = baseline(ads, o.key, opts); });
    return (ads || []).map(function (a) {
      var o = objective(a.objective);
      var sums = pool([a]);
      var value = metric(sums, o.primary);
      var ev = evidence(sums, o.primary);
      var base = bases[o.key];
      return Object.assign({}, a, {
        objective: o.key,
        primary: o.primary,
        value: value,
        evidence: ev,
        index: ev === 'early' || ev == null ? null : indexVs(value, base.value, o.primary),
        rawIndex: indexVs(value, base.value, o.primary),
      });
    });
  }

  /** Gallery order: judged ads by index (best first), then the rest by spend. */
  function rank(scored, sortKey) {
    var rows = (scored || []).slice();
    if (sortKey === 'spend') return rows.sort(function (a, b) { return (num(b.spend) || 0) - (num(a.spend) || 0); });
    if (sortKey === 'recent') return rows.sort(function (a, b) { return str(b.last_day).localeCompare(str(a.last_day)) || (num(b.spend) || 0) - (num(a.spend) || 0); });
    return rows.sort(function (a, b) {
      var ai = a.index, bi = b.index;
      if (ai != null && bi != null && ai !== bi) return bi - ai;
      if (ai != null && bi == null) return -1;
      if (ai == null && bi != null) return 1;
      return (num(b.spend) || 0) - (num(a.spend) || 0);
    });
  }

  /* ── Formatting ────────────────────────────────────────────────────────── */
  function fmtMetric(v, key) {
    if (v == null) return '—';
    var f = (METRICS[key] || {}).fmt;
    if (f === 'x') return v.toFixed(2) + '×';
    if (f === '%') return (v * 100).toFixed(2) + '%';
    if (f === '$4') return '$' + (v < 0.1 ? v.toFixed(4) : v.toFixed(2));
    return '$' + (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
  }
  function fmtMoney(v) {
    v = num(v);
    if (v == null) return '—';
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (Math.abs(v) >= 1e4) return '$' + Math.round(v / 1000) + 'K';
    return '$' + Math.round(v).toLocaleString('en-US');
  }
  /** A value against a reference, in words that match the metric's direction.
   *  Rates and ROAS read as multiples / shortfalls; costs read as higher or
   *  lower cost with the actual difference, because "21% below baseline"
   *  beside a larger dollar figure reads backwards. `ref` names the reference
   *  ("baseline", "bar"). tone: pos (better) / neg (worse) / info (about even). */
  function compare(value, base, key, ref) {
    var m = METRICS[key];
    ref = ref || 'baseline';
    if (!m || value == null || base == null || value <= 0 || base <= 0) return null;
    var ix = indexVs(value, base, key);
    if (ix > 0.95 && ix < 1.05) return { tone: 'info', index: ix, short: 'About the ' + ref, long: fmtMetric(value, key) + ', about the same as the ' + fmtMetric(base, key) + ' ' + ref + '.' };
    if (m.better === 'lower') {
      var diff = value - base;
      var pct = Math.round(Math.abs(value / base - 1) * 100);
      var d = fmtMetric(Math.abs(diff), key);
      return diff > 0
        ? { tone: 'neg', index: ix, short: 'Higher cost · +' + d, long: 'Costs ' + pct + '% more than the ' + fmtMetric(base, key) + ' ' + ref + ' (+' + d + ').' }
        : { tone: 'pos', index: ix, short: 'Lower cost · −' + d, long: 'Costs ' + pct + '% less than the ' + fmtMetric(base, key) + ' ' + ref + ' (−' + d + ').' };
    }
    var r = value / base;
    return r > 1
      ? { tone: 'pos', index: ix, short: r.toFixed(1) + '× the ' + ref, long: r.toFixed(1) + '× the ' + ref + ' (' + fmtMetric(base, key) + ').' }
      : { tone: 'neg', index: ix, short: Math.round((1 - r) * 100) + '% under the ' + ref, long: Math.round((1 - r) * 100) + '% under the ' + ref + ' (' + fmtMetric(base, key) + ').' };
  }
  function fmtIndex(ix) {
    if (ix == null) return null;
    if (ix >= 1.05) return ix.toFixed(1) + '× baseline';
    if (ix <= 0.95) return Math.round((1 - ix) * 100) + '% below baseline';
    return 'At baseline';
  }

  /* ── Images ────────────────────────────────────────────────────────────── */
  /** Expiry of a signed fbcdn URL (`oe=` hex seconds), or null. */
  function urlExpiry(u) {
    var m = /[?&]oe=([0-9A-Fa-f]+)/.exec(str(u));
    return m ? parseInt(m[1], 16) * 1000 : null;
  }
  /** What to draw for an ad: the archived image, a still-live Meta thumbnail,
   *  or nothing -- and whether the image is a shared template. */
  function imageFor(ad, signed, now) {
    var t = now == null ? Date.now() : now;
    var shared = num(ad && ad.image_shared_by);
    var template = shared != null && shared >= 2;
    if (ad && ad.image_path && signed && /^https:\/\//.test(signed[ad.image_path] || '')) {
      return { src: signed[ad.image_path], kind: 'archived', template: template, sharedBy: shared };
    }
    var th = ad && ad.thumbnail_url;
    var exp = urlExpiry(th);
    if (/^https:\/\//.test(str(th)) && (exp == null || exp > t)) return { src: th, kind: 'meta_thumbnail', template: false, sharedBy: null };
    return { src: null, kind: 'none', template: false, sharedBy: null };
  }
  function formatOf(ad) {
    var t = str(ad && ad.object_type).toUpperCase();
    if (num(ad && ad.image_shared_by) >= 2) return 'catalog';
    if (t === 'VIDEO') return 'video';
    if (t === 'PHOTO') return 'image';
    return 'other';
  }

  /* ── Findings ──────────────────────────────────────────────────────────── */
  function daysBetween(a, b) {
    if (!a || !b) return null;
    return Math.round((Date.parse(str(b).slice(0, 10) + 'T00:00:00Z') - Date.parse(str(a).slice(0, 10) + 'T00:00:00Z')) / 86400000);
  }
  // Meta dynamic / catalog ads carry per-product fields in their copy.
  var TEMPLATE_TOKEN = /\{\{[^{}]*\}\}/g;
  /** The placeholders a piece of copy carries, e.g. ['{{product.brand}}']. */
  function templateFields(text) {
    var seen = {}, out = [];
    (str(text).match(TEMPLATE_TOKEN) || []).forEach(function (t) { if (!seen[t]) { seen[t] = 1; out.push(t); } });
    return out;
  }
  /** Copy with its placeholders removed and the gaps they leave tidied. */
  function cleanCopy(text) {
    return str(text).replace(TEMPLATE_TOKEN, ' ')
      .replace(/[ \t]+([,.!?;:])/g, '$1')
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/^[ \t]*[-–—|:,.]+[ \t]*/gm, '')
      .replace(/[ \t]*[-–—|:,]+[ \t]*$/gm, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/^[ \t]+|[ \t]+$/gm, '')
      .trim();
  }
  function firstLine(text) {
    var t = cleanCopy(text);
    if (!t) return '';
    var line = t.split(/\n+/)[0].trim();
    var sentence = line.split(/(?<=[.!?])\s/)[0];
    // What is left of a line that was mostly placeholders is not a hook.
    if ((sentence.match(/[A-Za-z]/g) || []).length < 4) return '';
    return (sentence.length <= 140 ? sentence : sentence.slice(0, 137) + '…');
  }
  function isRunning(ad) {
    var gap = daysBetween(ad && ad.last_day, ad && ad.data_through);
    return gap != null && gap <= 2 && num(ad.recent_spend) > 0;
  }
  /** Recent CTR against the ad's own first two weeks, when both have volume. */
  function fatigue(ad) {
    var early = div(ad && ad.early_clicks, ad && ad.early_impressions);
    var recent = div(ad && ad.recent_clicks, ad && ad.recent_impressions);
    if (early == null || recent == null) return null;
    if ((num(ad.early_impressions) || 0) < 5000 || (num(ad.recent_impressions) || 0) < 5000) return null;
    if (!isRunning(ad)) return null;
    return { early: early, recent: recent, change: recent / early - 1 };
  }

  /** Observations from the numbers, each with its source. tone: pos/neg/info. */
  function findings(ad, base, totals) {
    var out = [];
    if (!ad) return out;
    var o = objective(ad.objective);
    var m = METRICS[o.primary];
    var sums = pool([ad]);
    var v = metric(sums, o.primary), ev = evidence(sums, o.primary);
    if (v == null) {
      out.push({ tone: 'info', title: m.short + ' not measured', detail: 'Meta reported no ' + m.vol + ' for this ad, so it cannot be compared on ' + m.label.toLowerCase() + '.' });
    } else if (ev === 'early') {
      var need = evidenceNeed(sums, o.primary);
      out.push({ tone: 'info', title: m.short + ' ' + fmtMetric(v, o.primary) + ' is early', detail: 'Based on ' + Math.round(need.have).toLocaleString('en-US') + ' ' + need.unit + '; ' + need.need + ' are needed before it is compared with the baseline.' });
    } else {
      var c = compare(v, base && base.value, o.primary);
      if (c) {
        out.push({ tone: c.tone,
          title: m.short + ' ' + fmtMetric(v, o.primary) + ' vs ' + fmtMetric(base.value, o.primary) + ' baseline',
          detail: c.long + ' Baseline pooled across ' + base.ads + ' ' + o.label.toLowerCase() + ' ads with at least $' + base.minSpend + ' spend. ' + (ev === 'strong' ? 'Strong' : 'Moderate') + ' evidence.' });
      }
    }
    if (o.primary !== 'ctr') {
      var ctr = metric(sums, 'ctr'), bctr = base ? metric(base.sums, 'ctr') : null;
      var cix = indexVs(ctr, bctr, 'ctr');
      if (cix != null && evidence(sums, 'ctr') !== 'early' && (cix >= 1.2 || cix <= 0.8)) {
        out.push({ tone: cix >= 1.2 ? 'pos' : 'neg', title: 'Click-through ' + fmtMetric(ctr, 'ctr') + ' vs ' + fmtMetric(bctr, 'ctr'),
          detail: cix >= 1.2 ? 'People stop and click on this one more than on the objective’s other ads.' : 'Fewer clicks per impression than the objective’s other ads.' });
      }
    }
    var f = fatigue(ad);
    if (f && f.change <= -0.25) {
      out.push({ tone: 'neg', title: 'Click-through down ' + Math.round(-f.change * 100) + '% from its first two weeks',
        detail: fmtMetric(f.early, 'ctr') + ' then, ' + fmtMetric(f.recent, 'ctr') + ' in the last 14 days. A fresh version may be due.' });
    }
    var days = num(ad.days_with_spend);
    var share = totals && num(totals[o.key]) ? div(ad.spend, totals[o.key]) : null;
    if (num(ad.spend) != null) {
      out.push({ tone: 'info', title: fmtMoney(ad.spend) + ' over ' + (days || 0) + ' day' + (days === 1 ? '' : 's') + ' of spend',
        detail: (share != null ? Math.round(share * 1000) / 10 + '% of ' + o.label.toLowerCase() + ' spend in this window. ' : '')
          + (isRunning(ad) ? 'Still running.' : ad.last_day ? 'Last spent ' + str(ad.last_day).slice(0, 10) + '.' : '') });
    }
    var fields = templateFields(ad.body || ad.title);
    if (fields.length) {
      out.push({ tone: 'info', title: 'Copy uses catalog placeholders',
        detail: fields.join(', ') + ' — Meta fills these per product. They are left out of hooks and Ask SILO drafts.' });
    }
    if (num(ad.image_shared_by) >= 2) {
      out.push({ tone: 'info', title: 'Same image as ' + ad.image_shared_by + ' other ads',
        detail: 'Usually a catalog ad’s template: shoppers saw products from the feed, not this picture.' });
    }
    return out;
  }

  /* ── Ideas ─────────────────────────────────────────────────────────────── */
  var IDEA_STATUSES = [
    { key: 'idea', label: 'Ideas' },
    { key: 'approved', label: 'Approved' },
    { key: 'in_production', label: 'In production' },
    { key: 'live', label: 'Live' },
    { key: 'retired', label: 'Retired' },
  ];
  /** The bar an idea must beat, frozen now: its baselines' pooled metric. */
  // basis 'selected' = the pooled result of the ads the idea was built from
  // (a new take has to match its winners); 'objective' = the objective's
  // baseline over every ad with enough spend (beat the typical ad). Two picked
  // outliers can put the first several times above the second, so the page
  // shows both and the person chooses. The objective's baseline is recorded on
  // the snapshot either way, so a card can say what its bar sits next to.
  function snapshot(baselineAds, window, opts) {
    var ads = (baselineAds || []).filter(Boolean);
    if (!ads.length) return null;
    var objKey = objective(ads[0].objective).key;
    var o = objective(objKey);
    var ob = opts && opts.objectiveBaseline;
    if (ob && ob.objective && ob.objective !== objKey) ob = null;
    var basis = opts && opts.basis === 'objective' && ob && ob.value != null ? 'objective' : 'selected';
    var sums = basis === 'objective' ? ob.sums : pool(ads);
    var value = metric(sums, o.primary);
    var round = function (v) { return v == null ? null : Math.round(v * 10000) / 10000; };
    return {
      objective: objKey, metric: o.primary, metric_label: METRICS[o.primary].label, better: METRICS[o.primary].better,
      basis: basis,
      value: round(value),
      evidence: evidence(sums, o.primary),
      objective_baseline: ob && ob.value != null ? { value: round(ob.value), ads: ob.ads, min_spend: ob.minSpend } : null,
      sums: sums, ad_ids: ads.map(function (a) { return String(a.ad_id); }),
      window_start: window && window.start || null, data_through: window && window.through || null,
      captured_at: new Date().toISOString(),
    };
  }
  /** A launched idea against its frozen bar. */
  function measureIdea(idea, adsById) {
    var snap = idea && idea.baseline_snapshot;
    var live = ((idea && idea.live_ad_ids) || []).map(function (id) { return adsById && adsById[String(id)]; }).filter(Boolean);
    if (!snap || !snap.metric) return { state: 'no_bar', note: 'No bar was set when this idea was made.' };
    if (!(idea.live_ad_ids || []).length) return { state: 'not_live', note: 'No ads linked yet.' };
    if (!live.length) return { state: 'no_data', note: 'The linked ads have no spend in this window.' };
    var sums = pool(live);
    var value = metric(sums, snap.metric);
    var ev = evidence(sums, snap.metric);
    if (value == null) return { state: 'no_data', note: 'The linked ads report no ' + METRICS[snap.metric].vol + '.' };
    if (ev === 'early') {
      var need = evidenceNeed(sums, snap.metric);
      return { state: 'early', value: value, note: Math.round(need.have) + ' of ' + need.need + ' ' + need.unit + ' so far — too early to call.' };
    }
    var ix = indexVs(value, snap.value, snap.metric);
    var c = compare(value, snap.value, snap.metric, 'bar');
    return { state: ix == null ? 'no_data' : ix >= 1 ? 'beating' : 'behind', value: value, index: ix, evidence: ev,
      note: METRICS[snap.metric].short + ' ' + fmtMetric(value, snap.metric) + ' vs ' + fmtMetric(snap.value, snap.metric) + ' bar'
        + (c && c.tone !== 'info' ? ' · ' + c.short : '') };
  }
  /** Client-side mirror of ad_ideas' CHECKs, so the dialog says why first. */
  function validateIdea(f) {
    var errs = [];
    var title = str(f && f.title).trim();
    if (!title) errs.push('Give the idea a title.');
    if (title.length > 200) errs.push('Keep the title under 200 characters.');
    if (f && f.destination_url && !/^https?:\/\/\S+$/i.test(str(f.destination_url).trim())) errs.push('The destination must be a web address starting with https://.');
    if (f && f.status === 'live' && !((f.live_ad_ids || []).length)) errs.push('A live idea needs the ads that carry it.');
    return errs;
  }
  /** The ad's landing page, when it has one: tracking stripped, and never a
   *  Facebook / Instagram address -- on a page-post ad the last-resort link
   *  can be the post itself, which is not where a shopper lands. */
  function destinationOf(ad) {
    var u = str(ad && ad.link_url).trim();
    if (!/^https?:\/\/\S+$/i.test(u)) return null;
    var host;
    try { host = new URL(u).hostname.toLowerCase(); } catch (e) { return null; }
    if (/(^|\.)(facebook\.com|fb\.me|fb\.com|instagram\.com)$/.test(host)) return null;
    return u.replace(/[?#].*$/, '');
  }

  /** The idea a person starts from one or more ads. */
  function ideaFromAds(ads, window, objectiveBaseline) {
    var list = (ads || []).filter(Boolean);
    var lead = list[0] || {};
    var dest = destinationOf(lead) || '';
    return {
      title: list.length === 1 ? 'New take on “' + str(lead.ad_name).slice(0, 80) + '”' : 'New ad from ' + list.length + ' winners',
      hook: firstLine(lead.body || lead.title),
      objective: objective(lead.objective).key,
      format: formatOf(lead),
      destination_url: dest,
      baseline_ad_ids: list.map(function (a) { return String(a.ad_id); }),
      baseline_snapshot: snapshot(list, window, { objectiveBaseline: objectiveBaseline }),
      source: 'from_ad',
      status: 'idea',
    };
  }

  /** Ask SILO: draft new ads from these baselines. Filled in, never sent. */
  function askSiloPrompt(ads, base) {
    var list = (ads || []).filter(Boolean).slice(0, 5);
    if (!list.length) return '';
    var o = objective(list[0].objective);
    var lines = ['Draft 3 new Meta ad concepts for our ' + o.label.toLowerCase() + ' campaigns, built from these baseline ads.'];
    if (base && base.value != null) lines.push('Baseline for the objective: ' + METRICS[o.primary].label + ' ' + fmtMetric(base.value, o.primary) + ' across ' + base.ads + ' ads.');
    list.forEach(function (a, i) {
      var s = pool([a]);
      lines.push((i + 1) + '. "' + str(a.ad_name) + '" (ad ' + a.ad_id + ', ' + formatOf(a) + ', ' + str(a.first_day).slice(0, 10) + ' to ' + str(a.last_day).slice(0, 10)
        + ', ' + fmtMoney(a.spend) + ' spend, ' + METRICS[o.primary].short + ' ' + fmtMetric(metric(s, o.primary), o.primary) + ')'
        + (firstLine(a.body || a.title) ? ' hook: "' + firstLine(a.body || a.title) + '"' : '')
        + (templateFields(a.body || a.title).length ? ' (catalog ad: its copy is filled per product from the feed)' : ''));
    });
    lines.push('For each concept give: the hook (first line), primary text, the visual or video direction, the destination, and which baseline it builds on and what it changes. Check each baseline’s numbers in meta_ad_performance_daily before relying on them. Do not predict results.');
    return lines.join('\n');
  }

  var API = {
    METRICS: METRICS, OBJECTIVES: OBJECTIVES, IDEA_STATUSES: IDEA_STATUSES,
    objective: objective, pool: pool, metric: metric, evidence: evidence, evidenceNeed: evidenceNeed,
    indexVs: indexVs, baseline: baseline, score: score, rank: rank,
    fmtMetric: fmtMetric, fmtMoney: fmtMoney, fmtIndex: fmtIndex, compare: compare,
    templateFields: templateFields, cleanCopy: cleanCopy,
    urlExpiry: urlExpiry, imageFor: imageFor, formatOf: formatOf,
    firstLine: firstLine, isRunning: isRunning, fatigue: fatigue, findings: findings,
    snapshot: snapshot, measureIdea: measureIdea, validateIdea: validateIdea, ideaFromAds: ideaFromAds,
    askSiloPrompt: askSiloPrompt, destinationOf: destinationOf,
  };
  if (typeof window !== 'undefined') window.SiloAdStudio = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
