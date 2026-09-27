/* The decisions behind /v2/seo-keywords.html, kept out of the page so a test
 * can reach them.
 *
 * Three of them are the same rule that runs through the whole SEO module:
 * an ABSENT value is not a zero. A keyword no run has looked at is "never
 * observed", not "unranked"; our storefront missing from an observed page is
 * "not in the top N observed", not position 0; a movement with no previous
 * run is "no prior run", not flat. The page renders words for each, and the
 * test pins that the three absences never collapse into one string.
 *
 * The fourth is money: what switching tracking on will cost, computed from
 * the same bounds the sync enforces (seo_serp_schedules), so the number a
 * person reads before pressing the switch is the number the run will spend.
 */
(function () {
  'use strict';

  // Measured 2026-09-26 on the live account: $0.0012 per standard-queue task
  // at depth 20. A per-task price, never a per-keyword one: a keyword on two
  // devices is two tasks.
  var MEASURED_TASK_COST_USD = 0.0012;
  var DEVICES = ['desktop', 'mobile'];

  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }

  /** What one weekly run will ask for and cost under the schedule's bounds. */
  function estimateRun(opts) {
    opts = opts || {};
    var active = Math.max(0, Math.floor(num(opts.activeKeywords) || 0));
    var devices = Array.isArray(opts.devices) ? opts.devices.filter(function (d) { return DEVICES.indexOf(d) >= 0; }) : [];
    var cap = Math.max(0, Math.floor(num(opts.maxKeywords) || 0));
    var asked = cap ? Math.min(active, cap) : 0;
    var tasks = asked * devices.length;
    var perTask = num(opts.costPerTask);
    if (perTask == null) perTask = MEASURED_TASK_COST_USD;
    var usd = Math.round(tasks * perTask * 10000) / 10000;
    var maxCost = num(opts.maxCostUsd);
    return {
      keywordsActive: active,
      keywordsAsked: asked,
      keywordsBeyondCap: Math.max(0, active - asked),
      devices: devices.length,
      tasks: tasks,
      usdPerRun: usd,
      usdPerYear: Math.round(usd * 52 * 100) / 100,
      // The cost cap stops posting mid-run; the person should see it coming.
      costCapBinds: maxCost != null && usd > maxCost,
    };
  }

  /** Validate a schedule form the way the database will, in words. */
  function validateSchedule(f) {
    f = f || {};
    var errors = [];
    var devices = Array.isArray(f.devices) ? f.devices.slice() : [];
    var seen = {};
    devices.forEach(function (d) {
      if (DEVICES.indexOf(d) < 0) errors.push('Device "' + d + '" is not desktop or mobile.');
      if (seen[d]) errors.push('Device "' + d + '" is listed twice.');
      seen[d] = true;
    });
    if (!devices.length) errors.push('Pick at least one device.');
    var depth = num(f.depth);
    if (depth == null || depth < 10 || depth > 100 || depth !== Math.floor(depth)) errors.push('Depth must be a whole number from 10 to 100 (20 recommended: 10 leaves only 7-8 organic results once Google\'s own panels take slots).');
    var maxK = num(f.maxKeywords);
    if (maxK == null || maxK < 1 || maxK > 1000 || maxK !== Math.floor(maxK)) errors.push('Max keywords per run must be a whole number from 1 to 1000.');
    var maxC = num(f.maxCostUsd);
    if (maxC == null || maxC <= 0) errors.push('Max cost per run must be more than $0.');
    var pr = num(f.priority);
    if (pr !== 1 && pr !== 2) errors.push('Priority must be normal (1) or high (2).');
    return { ok: errors.length === 0, errors: errors };
  }

  /**
   * The words for one landscape row. Three absences, three different
   * strings, never a number that was not measured.
   */
  function rankingLabels(row) {
    row = row || {};
    var runs = num(row.observation_runs) || 0;
    var results = row.results_in_latest_run == null ? null : num(row.results_in_latest_run);
    var ours = row.our_serp_position == null ? null : num(row.our_serp_position);
    var prev = row.our_previous_serp_position == null ? null : num(row.our_previous_serp_position);
    var out = {};
    if (!runs || row.latest_observed_on == null) {
      out.state = 'never_observed';
      out.ours = 'never observed';
      out.movement = 'no run yet';
      return out;
    }
    if (results === 0) {
      out.state = 'asked_nothing';
      out.ours = 'nothing returned';
      out.movement = row.previous_observed_on ? 'nothing to compare' : 'no prior run';
      return out;
    }
    out.state = ours == null ? 'observed_absent' : 'observed';
    out.ours = ours == null ? 'not in top ' + (results != null ? results : 'N') + ' observed' : '#' + ours;
    if (!row.previous_observed_on) out.movement = 'no prior run';
    else if (ours == null && prev == null) out.movement = 'absent both runs';
    else if (ours == null) out.movement = 'dropped out (was #' + prev + ')';
    else if (prev == null) out.movement = 'entered (was absent)';
    else {
      var mv = prev - ours; // positive = moved UP the page
      out.movement = mv === 0 ? 'unchanged' : (mv > 0 ? 'up ' + mv : 'down ' + (-mv));
      out.movementSign = mv;
    }
    return out;
  }

  /** The first N domains of a landscape row's latest results, in order. */
  function topDomains(results, n) {
    if (!Array.isArray(results)) return [];
    return results
      .filter(function (r) { return r && (r.result_type == null || r.result_type === 'organic'); })
      .sort(function (a, b) { return (num(a.position) || 0) - (num(b.position) || 0); })
      .slice(0, n || 3)
      .map(function (r) { return { position: r.position, domain: String(r.domain || ''), own: !!r.is_own_domain, relationship: r.relationship || null }; });
  }

  /** Candidates not yet in the set, in the function's own order. */
  function newCandidates(candidates) {
    return (Array.isArray(candidates) ? candidates : []).filter(function (c) { return c && !c.already_in_set; });
  }

  function domainNorm(d) {
    return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  }

  /** One sentence for the tracking card, from the stored record alone. */
  function trackingSummary(s) {
    s = s || {};
    var sched = s.schedule;
    if (!sched) return { state: 'off', text: 'Tracking is off. No schedule has been created for this company.' };
    if (!sched.is_active) return { state: 'off', text: 'Tracking is off. The schedule exists but is switched off.' };
    var pend = num(s.pendingTasks) || 0;
    var fail = num(s.failedTasks) || 0;
    if (!sched.last_run_on) return { state: 'on_waiting', text: 'Tracking is on. No run has started yet; the first one runs on Monday.' };
    if (pend) return { state: 'on_pending', text: 'Tracking is on. The ' + sched.last_run_on + ' run is still collecting ' + pend + ' result' + (pend === 1 ? '' : 's') + ' from the provider.' };
    return { state: 'on', text: 'Tracking is on. Last run ' + sched.last_run_on + (fail ? ' (' + fail + ' keyword' + (fail === 1 ? '' : 's') + ' the provider could not answer)' : '') + '.' };
  }

  /** Path-and-query of a URL with the host and click/tracking params removed
   * (a JS mirror of seo_serp_page_path(), for display only). */
  function pagePath(url) {
    var p = String(url || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').replace(/#.*$/, '');
    p = p.replace(/[?&](srsltid|gclid|fbclid|msclkid|utm_[a-z]+|ref|ref_)=[^&#]*/g, '');
    p = p.replace(/^([^?]*)\?&/, '$1?').replace(/\?$/, '');
    return p === '' ? '/' : p;
  }

  var FEATURE_LABELS = {
    people_also_ask: 'People also ask',
    ai_overview: 'AI overview',
    popular_products: 'Product pack',
    shopping: 'Shopping',
    refine_products: 'Product filters',
    explore_brands: 'Brands',
    images: 'Images',
    video: 'Videos',
    short_videos: 'Short videos',
    featured_snippet: 'Featured snippet',
    answer_box: 'Answer box',
    knowledge_graph: 'Knowledge panel',
    local_pack: 'Local pack',
    map: 'Map',
    top_stories: 'Top stories',
    related_searches: 'Related searches',
    people_also_search: 'People also search',
    discussions_and_forums: 'Forums',
    google_reviews: 'Reviews',
  };
  function featureLabel(type) {
    var t = String(type || '');
    return FEATURE_LABELS[t] || t.replace(/_/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); });
  }

  /** The chips for one keyword's latest run: one per feature type, in page
   * order, with how many items the block held. Related-searches style blocks
   * are kept but sort last -- they are not real estate above the results. */
  var TRAILING_FEATURES = { related_searches: 1, people_also_search: 1 };
  function featureChips(rows) {
    var byType = {};
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r || !r.feature_type) return;
      var t = String(r.feature_type);
      var pos = r.position == null ? null : num(r.position);
      var cnt = r.item_count == null ? null : num(r.item_count);
      if (!byType[t]) byType[t] = { type: t, label: featureLabel(t), position: pos, count: cnt == null ? null : cnt, entries: [] };
      else {
        if (pos != null && (byType[t].position == null || pos < byType[t].position)) byType[t].position = pos;
        if (cnt != null) byType[t].count = (byType[t].count || 0) + cnt;
      }
      var entries = r.details && Array.isArray(r.details.entries) ? r.details.entries : [];
      byType[t].entries = byType[t].entries.concat(entries);
    });
    return Object.keys(byType).map(function (k) { return byType[k]; }).sort(function (a, b) {
      var ta = TRAILING_FEATURES[a.type] ? 1 : 0, tb = TRAILING_FEATURES[b.type] ? 1 : 0;
      if (ta !== tb) return ta - tb;
      return (a.position == null ? 999 : a.position) - (b.position == null ? 999 : b.position);
    });
  }

  /** The page types one domain ranks with, most keywords first. */
  var PAGE_TYPE_ORDER = ['collection', 'product', 'article', 'home', 'page', 'video', 'other'];
  function pageTypeSummary(rows) {
    return (Array.isArray(rows) ? rows : []).filter(function (r) { return r && r.page_type; }).map(function (r) {
      return { page_type: String(r.page_type), keywords: num(r.keywords_in_top_10) || 0, pages: num(r.distinct_pages) || 0, best: num(r.best_position), example_path: r.example_path || null, example_keyword: r.example_keyword || null };
    }).sort(function (a, b) {
      return (b.keywords - a.keywords) || (PAGE_TYPE_ORDER.indexOf(a.page_type) - PAGE_TYPE_ORDER.indexOf(b.page_type));
    });
  }

  /** Does the text name every word of the keyword? Case-insensitive, word
   * order free, punctuation ignored. "Baseball Backpacks & Bags" names
   * "baseball backpack" only if every word is present as a whole word or
   * its plural. */
  function namesTerm(keyword, text) {
    var words = String(keyword || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length || !text) return false;
    var hay = ' ' + String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
    return words.every(function (w) {
      var base = w.replace(/s$/, '');
      return hay.indexOf(' ' + base + ' ') >= 0 || hay.indexOf(' ' + base + 's ') >= 0 || hay.indexOf(' ' + base + 'es ') >= 0;
    });
  }

  /** Side-by-side rows for the compare panel. A side with no capture reads
   * "not captured" on every row rather than blank, and never as zero. */
  function compareFacts(keyword, ours, theirs) {
    var NOT = 'not captured';
    function val(side, fn) {
      if (!side) return NOT;
      if (side.fetch_error) return 'fetch failed: ' + side.fetch_error;
      var v = fn(side);
      return v == null || v === '' ? '—' : v;
    }
    function count(v) { var n = num(v); return n == null ? null : String(n); }
    var rows = [
      { key: 'title', label: 'Title', ours: val(ours, function (s) { return s.title; }), theirs: val(theirs, function (s) { return s.title; }) },
      { key: 'title_names_term', label: 'Title names the term', ours: val(ours, function (s) { return namesTerm(keyword, s.title) ? 'yes' : 'no'; }), theirs: val(theirs, function (s) { return namesTerm(keyword, s.title) ? 'yes' : 'no'; }) },
      { key: 'title_length', label: 'Title length', ours: val(ours, function (s) { return count(s.title_length); }), theirs: val(theirs, function (s) { return count(s.title_length); }) },
      { key: 'meta_description', label: 'Meta description', ours: val(ours, function (s) { return s.meta_description; }), theirs: val(theirs, function (s) { return s.meta_description; }) },
      { key: 'h1', label: 'H1', ours: val(ours, function (s) { return (s.h1 || []).join(' | '); }), theirs: val(theirs, function (s) { return (s.h1 || []).join(' | '); }) },
      { key: 'h1_names_term', label: 'H1 names the term', ours: val(ours, function (s) { return namesTerm(keyword, (s.h1 || []).join(' ')) ? 'yes' : 'no'; }), theirs: val(theirs, function (s) { return namesTerm(keyword, (s.h1 || []).join(' ')) ? 'yes' : 'no'; }) },
      { key: 'h2_count', label: 'H2 headings', ours: val(ours, function (s) { return count(s.h2_count); }), theirs: val(theirs, function (s) { return count(s.h2_count); }) },
      { key: 'word_count', label: 'Words on page', ours: val(ours, function (s) { return count(s.word_count); }), theirs: val(theirs, function (s) { return count(s.word_count); }) },
      { key: 'images', label: 'Images (missing alt)', ours: val(ours, function (s) { return count(s.image_count) == null ? null : count(s.image_count) + ' (' + (count(s.images_missing_alt) || '0') + ')'; }), theirs: val(theirs, function (s) { return count(s.image_count) == null ? null : count(s.image_count) + ' (' + (count(s.images_missing_alt) || '0') + ')'; }) },
      { key: 'jsonld', label: 'Structured data', ours: val(ours, function (s) { return (s.jsonld_types || []).join(', '); }), theirs: val(theirs, function (s) { return (s.jsonld_types || []).join(', '); }) },
      { key: 'canonical', label: 'Canonical', ours: val(ours, function (s) { return s.canonical_url; }), theirs: val(theirs, function (s) { return s.canonical_url; }) },
      { key: 'fetched_at', label: 'Captured', ours: ours ? String(ours.fetched_at || '').slice(0, 16).replace('T', ' ') : NOT, theirs: theirs ? String(theirs.fetched_at || '').slice(0, 16).replace('T', ' ') : NOT },
    ];
    return rows;
  }

  // ── Recommendations tab: seo_recommendations_v is the single definition of
  // an opportunity (score, class, evidence_strength). Everything below is
  // display grouping and the "Create SEO task" pre-fill -- it never computes
  // a score or an evidence label of its own; that would be a second
  // definition of the same number, which this codebase's own convention
  // (search_console_query_rollup_v, silo_business_today(), etc.) argues
  // against. evidence_strength is read from the row and validated, never
  // invented client-side.

  var RECOMMENDATION_CLASS_LABELS = {
    page_one_not_top3: 'Page one, not top 3',
    absent_with_demand: 'Absent with demand',
    page_two: 'Page two, one push from page one',
    missing_category: 'Missing category',
    content_brief: 'Content brief',
    defend: 'Defend',
  };
  // Roughly urgency-first: what is slipping, what is close, what is missing.
  var RECOMMENDATION_CLASS_ORDER = ['defend', 'page_one_not_top3', 'content_brief', 'page_two', 'absent_with_demand', 'missing_category'];
  var EVIDENCE_STRENGTH_VALUES = ['strong', 'moderate', 'early'];

  /** Never trust a value the view didn't return as one of the three words --
   * fail toward the WEAKER claim, never a stronger one, if something upstream
   * ever sends something else. */
  function evidenceStrengthLabel(s) {
    return EVIDENCE_STRENGTH_VALUES.indexOf(s) >= 0 ? s : 'early';
  }

  /** Group recommendation rows by class, in a fixed display order, each
   * group's rows kept in the score order the view already returned (falls
   * back to a defensive re-sort if rows arrive unsorted). A class absent from
   * the data is simply absent from the result -- never rendered as an empty
   * section. */
  function groupRecommendations(rows) {
    var byClass = {};
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      var c = r && r.opportunity_class;
      if (!c) return;
      if (!byClass[c]) byClass[c] = [];
      byClass[c].push(r);
    });
    var order = RECOMMENDATION_CLASS_ORDER.concat(Object.keys(byClass).filter(function (c) { return RECOMMENDATION_CLASS_ORDER.indexOf(c) < 0; }));
    return order.filter(function (c) { return byClass[c] && byClass[c].length; }).map(function (c) {
      var group = byClass[c].slice().sort(function (a, b) { return (num(b.score) || 0) - (num(a.score) || 0); });
      return { opportunity_class: c, label: RECOMMENDATION_CLASS_LABELS[c] || c, rows: group };
    });
  }

  // seo_serp_page_type() vocabulary -> seo_tasks.target_type's CHECK
  // (product/collection/page/blog/site/other). A page type is a
  // classification of the URL, never of the content -- this mapping inherits
  // that limit and is only ever a STARTING GUESS the person reviews.
  var PAGE_TYPE_TO_TARGET_TYPE = { home: 'site', collection: 'collection', product: 'product', article: 'blog', video: 'other', page: 'page', other: 'other' };
  function mapPageTypeToTargetType(pageType) {
    if (!pageType) return null;
    return PAGE_TYPE_TO_TARGET_TYPE[pageType] || 'other';
  }

  /** The last non-empty path segment of a URL, for a starting target_handle
   * guess. Null for anything with no path (including no URL at all) -- never
   * an empty string standing in for "unknown". */
  function urlHandle(url) {
    if (!url) return null;
    var path = pagePath(url).replace(/\?.*$/, '');
    var segments = path.split('/').filter(Boolean);
    return segments.length ? segments[segments.length - 1] : null;
  }

  var RECOMMENDATION_TITLE_TEMPLATES = {
    defend: 'Protect ranking for "%s"',
    page_one_not_top3: 'Improve ranking for "%s"',
    page_two: 'Push "%s" onto page one',
    absent_with_demand: 'Get a page ranking for "%s"',
    content_brief: 'Write a page targeting "%s"',
    missing_category: 'Cover the "%s" category',
  };

  /**
   * What the "Create SEO task" button pre-fills, from the row's evidence
   * alone -- never inserted until a person reviews and confirms. rationale
   * starts from the view's own suggested_action sentence (the one place that
   * sentence is written) and, only when both sides were actually captured,
   * appends the title/H1 hypothesis using the same namesTerm() word-match the
   * Rankings tab's compare panel uses -- worded as a hypothesis, never a
   * cause, per this module's own rule about page types and content.
   */
  function taskPrefill(rec) {
    rec = rec || {};
    var targetType = mapPageTypeToTargetType(rec.our_page_type) || mapPageTypeToTargetType(rec.competitor_page_type) || 'other';
    var rationale = String(rec.suggested_action || '').trim();
    if (rec.competitor_captured_title && rec.our_captured_title) {
      var theirsNames = namesTerm(rec.keyword, rec.competitor_captured_title);
      var oursNames = namesTerm(rec.keyword, rec.our_captured_title);
      if (theirsNames && !oursNames) {
        rationale += ' Hypothesis, not a cause: their title names the term ("' + rec.competitor_captured_title + '") and ours does not ("' + rec.our_captured_title + '").';
      }
    }
    var titleTemplate = RECOMMENDATION_TITLE_TEMPLATES[rec.opportunity_class] || 'SEO: %s';
    var titleSubject = (Array.isArray(rec.keyword_cluster) && rec.keyword_cluster.length) ? rec.keyword_cluster.join(', ') : (rec.keyword || '');
    return {
      target_type: targetType,
      target_url: rec.our_url || null,
      target_handle: urlHandle(rec.our_url),
      rationale: rationale,
      proposed_title: titleTemplate.replace('%s', titleSubject),
    };
  }

  var API = {
    MEASURED_TASK_COST_USD: MEASURED_TASK_COST_USD,
    pagePath: pagePath,
    featureLabel: featureLabel,
    featureChips: featureChips,
    pageTypeSummary: pageTypeSummary,
    namesTerm: namesTerm,
    compareFacts: compareFacts,
    DEVICES: DEVICES,
    estimateRun: estimateRun,
    validateSchedule: validateSchedule,
    rankingLabels: rankingLabels,
    topDomains: topDomains,
    newCandidates: newCandidates,
    domainNorm: domainNorm,
    trackingSummary: trackingSummary,
    RECOMMENDATION_CLASS_LABELS: RECOMMENDATION_CLASS_LABELS,
    RECOMMENDATION_CLASS_ORDER: RECOMMENDATION_CLASS_ORDER,
    EVIDENCE_STRENGTH_VALUES: EVIDENCE_STRENGTH_VALUES,
    evidenceStrengthLabel: evidenceStrengthLabel,
    groupRecommendations: groupRecommendations,
    mapPageTypeToTargetType: mapPageTypeToTargetType,
    urlHandle: urlHandle,
    taskPrefill: taskPrefill,
  };
  if (typeof window !== 'undefined') window.SiloSeoKeywords = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
