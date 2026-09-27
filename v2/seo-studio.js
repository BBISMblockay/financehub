/* /v2/seo-studio.html's decisions, kept out of the page so node can run them.
 *
 * SEO Studio is a PAGE-FIRST reading of seo_recommendations_v: the view ranks
 * keyword opportunities, the studio groups them by the page of ours that would
 * have to change, and says what it can see about that page. It computes no
 * score of its own -- a page's score is the sum of its rows' view scores, and
 * its evidence is the best of their evidence -- so the studio and the SEO
 * Keywords Recommendations tab can never disagree about what matters.
 *
 * The module's rules, each of which a test pins:
 *   - An absent value is not a zero. A page not inspected is "not checked",
 *     a description Shopify does not send is "Google writes its own", a rank
 *     not observed is not #0.
 *   - A rank check (one dated snapshot) and Google's 28-day average are two
 *     different measures and are never merged into one number.
 *   - Findings are observations of the page, worded as such. The headline is a
 *     starting point a person reviews, never a claim about cause.
 *
 * Depends on seo-keywords.js (window.SiloSeoKeywords) for pagePath() and
 * namesTerm(), so "the same page" and "names the term" mean one thing in the
 * whole SEO module.
 */
(function () {
  'use strict';

  var K = (typeof window !== 'undefined' && window.SiloSeoKeywords)
    || (typeof require === 'function' ? require('./seo-keywords.js') : null);

  function num(v) { var n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }

  var EVIDENCE_RANK = { strong: 3, moderate: 2, early: 1 };
  // Google shows roughly this much of a meta description before cutting it.
  // Stated as "about", everywhere it is shown -- it varies with pixel width.
  var DESCRIPTION_SHOWN_CHARS = 155;
  var DESCRIPTION_TOO_LONG_AT = 160;

  /** The page-grouping key: path without host or tracking noise, so a
   * homepage observed with a srsltid and without one is one page. */
  function pageKey(url) {
    if (!url) return null;
    return K.pagePath(url).replace(/\?.*$/, '') || '/';
  }

  /** What kind of page a path is, from its shape -- a classification of the
   * URL, never of the content. The view's our_page_type wins when present. */
  function pathKind(path) {
    var p = str(path);
    if (p === '/' || p === '') return 'home';
    if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?collections\/[^/]+\/products\//i.test(p)) return 'product';
    if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?collections\//i.test(p)) return 'collection';
    if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?products\//i.test(p)) return 'product';
    if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?blogs\//i.test(p)) return 'article';
    if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?pages\//i.test(p)) return 'page';
    return 'other';
  }

  /** The Shopify handle a path names, or null. */
  function collectionHandle(path) {
    var m = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?collections\/([^/?#]+)\/?$/i.exec(str(path));
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }
  function productHandle(path) {
    var m = /\/products\/([^/?#]+)\/?$/i.exec(str(path));
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }

  function bestEvidence(list) {
    var best = null;
    (list || []).forEach(function (e) { if (EVIDENCE_RANK[e] && (!best || EVIDENCE_RANK[e] > EVIDENCE_RANK[best])) best = e; });
    return best;
  }

  /** Human title for a page from its path: "/collections/baseball-backpacks"
   * -> "Baseball Backpacks". The page's real title replaces it once known. */
  function titleFromPath(path) {
    var p = str(path);
    if (p === '/' || !p) return 'Home page';
    var seg = p.replace(/\/$/, '').split('/').filter(Boolean).pop() || p;
    return decodeURIComponent(seg).replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  /**
   * The Up next queue. One entry per page of ours that has at least one
   * recommendation, plus one entry per opportunity that has NO page yet
   * (absent_with_demand, missing_category): those are "needs a page", never
   * attributed to whichever page happens to be nearest.
   */
  function groupByPage(recs) {
    var byKey = {};
    var order = [];
    (Array.isArray(recs) ? recs : []).forEach(function (r) {
      if (!r) return;
      var key, kind;
      var path = pageKey(r.our_url);
      if (path) { key = 'page:' + path; kind = 'page'; }
      else {
        var subject = (Array.isArray(r.keyword_cluster) && r.keyword_cluster.length) ? r.keyword_cluster.join(', ') : str(r.keyword);
        key = 'needs:' + r.opportunity_class + ':' + subject.toLowerCase();
        kind = 'needs_page';
      }
      var g = byKey[key];
      if (!g) {
        g = byKey[key] = {
          key: key, kind: kind, path: path, url: r.our_url || null,
          pageType: r.our_page_type || (path ? pathKind(path) : null),
          title: path ? titleFromPath(path) : ((Array.isArray(r.keyword_cluster) && r.keyword_cluster.length) ? r.keyword_cluster[0] : str(r.keyword)),
          rows: [], keywords: [], score: 0, evidence: null, classes: [], bestRank: null,
        };
        order.push(key);
      }
      g.rows.push(r);
      var kws = (Array.isArray(r.keyword_cluster) && r.keyword_cluster.length) ? r.keyword_cluster : [r.keyword];
      kws.forEach(function (k) { if (k && g.keywords.indexOf(k) < 0) g.keywords.push(k); });
      if (g.classes.indexOf(r.opportunity_class) < 0) g.classes.push(r.opportunity_class);
      g.score += num(r.score) || 0;
      g.evidence = bestEvidence([g.evidence, r.evidence_strength]);
      var pos = num(r.our_position);
      if (pos != null && (g.bestRank == null || pos < g.bestRank.position)) {
        g.bestRank = { position: pos, keyword: r.keyword, device: r.device || null };
      }
    });
    return order.map(function (k) { return byKey[k]; }).sort(function (a, b) {
      return (b.score - a.score) || (EVIDENCE_RANK[b.evidence] || 0) - (EVIDENCE_RANK[a.evidence] || 0) || a.key.localeCompare(b.key);
    });
  }

  /** The keyword a page is judged against: its best-ranked keyword, else its
   * highest-scoring row's keyword. */
  function leadKeyword(group) {
    if (!group) return null;
    if (group.bestRank && group.bestRank.keyword) return group.bestRank.keyword;
    var top = (group.rows || []).slice().sort(function (a, b) { return (num(b.score) || 0) - (num(a.score) || 0); })[0];
    return top ? (top.keyword || (top.keyword_cluster || [])[0] || null) : null;
  }

  /** Rank-check range across a page's rows, as text: "#3", "#2–4". */
  function rankRange(group) {
    var ps = (group && group.rows || []).map(function (r) { return num(r.our_position); }).filter(function (p) { return p != null; });
    if (!ps.length) return null;
    var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
    return lo === hi ? '#' + lo : '#' + lo + '–' + hi;
  }

  /**
   * Search Console page rows for ONE path summed over the window the caller
   * passes: clicks, impressions, click rate, and the impression-weighted
   * average position. NULL (never 0) when there are no rows at all -- a page
   * absent from the returned data is "not returned", not "no traffic".
   */
  function pageStats(rows) {
    var list = Array.isArray(rows) ? rows : [];
    if (!list.length) return null;
    var clicks = 0, impr = 0, weighted = 0;
    list.forEach(function (r) {
      var i = num(r.impressions) || 0;
      clicks += num(r.clicks) || 0;
      impr += i;
      if (num(r.position) != null) weighted += num(r.position) * i;
    });
    return {
      clicks: clicks,
      impressions: impr,
      ctr: impr > 0 ? clicks / impr : null,
      avgPosition: impr > 0 ? Math.round((weighted / impr) * 10) / 10 : null,
      days: list.length,
    };
  }

  /** Organic results above our best position in one observed result list,
   * excluding our own storefront. Empty when we are #1; when we are absent,
   * the top of the page. */
  function aboveUs(results, ourPosition, limit) {
    var n = limit || 3;
    var ours = num(ourPosition);
    return (Array.isArray(results) ? results : [])
      .filter(function (x) { return x && (x.result_type == null || x.result_type === 'organic') && !x.is_own_domain; })
      .filter(function (x) { return ours == null || num(x.position) < ours; })
      .sort(function (a, b) { return num(a.position) - num(b.position); })
      .slice(0, n)
      .map(function (x) {
        return { position: num(x.position), domain: str(x.domain).replace(/^www\./, ''), url: x.url || null, title: x.title || null, relationship: x.relationship || null };
      });
  }

  /** Our own title as Google showed it in an observed result list. */
  function ourObservedTitle(results) {
    var own = (Array.isArray(results) ? results : []).filter(function (x) { return x && x.is_own_domain && x.title; })
      .sort(function (a, b) { return num(a.position) - num(b.position); })[0];
    return own ? own.title : null;
  }

  /** What Shopify sends as the meta description: the SEO override when set,
   * else nothing -- Google then writes its own snippet from the page. */
  function descriptionFacts(collection) {
    if (!collection) return { state: 'unknown', text: null, length: null };
    var override = str(collection.seo_description_override).trim();
    if (!override) return { state: 'none', text: null, length: null };
    var flat = override.replace(/\s+/g, ' ');
    return {
      state: flat.length >= DESCRIPTION_TOO_LONG_AT ? 'too_long' : 'ok',
      text: flat,
      shown: flat.length > DESCRIPTION_SHOWN_CHARS ? flat.slice(0, DESCRIPTION_SHOWN_CHARS).replace(/\s+\S*$/, '') + '…' : flat,
      length: flat.length,
    };
  }

  /** The head term a title should carry: the lead keyword minus a brand word
   * the title already carries anyway. */
  function headTerm(keyword, brandWords) {
    var brand = (brandWords || []).map(function (b) { return str(b).toLowerCase(); });
    var words = str(keyword).toLowerCase().split(/\s+/).filter(function (w) { return w && brand.indexOf(w) < 0; });
    return words.join(' ');
  }
  function titleCase(s) { return str(s).replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  /**
   * What SILO can see about the page, as findings. tone: 'neg' (worth
   * changing), 'pos' (fine), 'info' (not checked / unknown). Every finding
   * carries its source, so nothing reads as more certain than its data.
   *
   * facts: { keyword, serpTitle, competitorTitle, competitorPosition,
   *          collection (shopify_collections row or null), isCollection,
   *          inspection (latest page_inspections row or null) }
   */
  function findings(facts) {
    var f = facts || {};
    var out = [];
    var term = f.keyword ? headTerm(f.keyword, f.brandWords) : '';
    if (f.serpTitle && term) {
      if (!K.namesTerm(term, f.serpTitle)) {
        out.push({
          key: 'title_missing_term', tone: 'neg', source: 'rank check',
          title: 'Title doesn’t say “' + titleCase(term) + '”.',
          detail: f.competitorTitle && K.namesTerm(term, f.competitorTitle)
            ? 'The #' + f.competitorPosition + ' result is titled “' + f.competitorTitle + '”.'
            : 'Google shows it as “' + f.serpTitle + '”.',
        });
      } else {
        out.push({ key: 'title_names_term', tone: 'pos', source: 'rank check', title: 'Title names “' + titleCase(term) + '”.', detail: '' });
      }
    }
    if (f.isCollection) {
      var d = descriptionFacts(f.collection);
      if (d.state === 'too_long') {
        out.push({ key: 'description_too_long', tone: 'neg', source: 'Shopify settings',
          title: 'Search description is ' + d.length.toLocaleString('en-US') + ' characters.',
          detail: 'Google shows about ' + DESCRIPTION_SHOWN_CHARS + ', so it cuts off mid-sentence.' });
      } else if (d.state === 'none') {
        out.push({ key: 'description_missing', tone: 'neg', source: 'Shopify settings',
          title: 'No search description set.', detail: 'Google writes its own snippet from the page.' });
      } else if (d.state === 'ok') {
        out.push({ key: 'description_ok', tone: 'pos', source: 'Shopify settings',
          title: 'Search description fits (' + d.length + ' characters).', detail: '' });
      }
      if (f.collection) {
        var introLen = str(f.collection.description).replace(/<[^>]+>/g, '').trim().length;
        out.push(introLen > 0
          ? { key: 'intro_present', tone: 'pos', source: 'Shopify settings', title: 'Has an introduction', detail: introLen.toLocaleString('en-US') + ' characters.' }
          : { key: 'intro_missing', tone: 'neg', source: 'Shopify settings', title: 'No introduction on the page.', detail: 'Shoppers and Google see only the product grid.' });
      }
    }
    var ins = f.inspection;
    if (!ins) {
      out.push({ key: 'not_inspected', tone: 'info', source: 'page inspection', title: 'Headings and image alt text not checked yet.', detail: '', action: 'inspect' });
    } else if (ins.fetch_error || (num(ins.http_status) != null && num(ins.http_status) >= 400)) {
      out.push({ key: 'inspection_failed', tone: 'info', source: 'page inspection', title: 'The last inspection could not read the page.', detail: str(ins.fetch_error || ('HTTP ' + ins.http_status)), action: 'inspect' });
    } else {
      var h1s = Array.isArray(ins.h1) ? ins.h1 : (ins.h1 ? [ins.h1] : []);
      if (!h1s.length) out.push({ key: 'h1_missing', tone: 'neg', source: 'page inspection', title: 'No main heading (H1).', detail: '' });
      else if (term && !K.namesTerm(term, h1s.join(' '))) out.push({ key: 'h1_missing_term', tone: 'neg', source: 'page inspection', title: 'Main heading doesn’t say “' + titleCase(term) + '”.', detail: 'It reads “' + h1s[0] + '”.' });
      else out.push({ key: 'h1_ok', tone: 'pos', source: 'page inspection', title: 'Main heading names the term.', detail: '' });
      var missingAlt = num(ins.images_missing_alt);
      if (missingAlt != null && missingAlt > 0) out.push({ key: 'alt_missing', tone: 'neg', source: 'page inspection', title: missingAlt + ' image' + (missingAlt === 1 ? '' : 's') + ' without alt text.', detail: '' });
    }
    return out;
  }

  /** The recommendation line, built from the negative findings in a fixed
   * order. Null when nothing specific was found -- the caller then shows the
   * view's own suggested_action instead, never an invented one. */
  function headline(found, keyword, brandWords) {
    var neg = {};
    (found || []).forEach(function (x) { if (x.tone === 'neg') neg[x.key] = true; });
    var term = titleCase(headTerm(keyword, brandWords));
    var parts = [];
    if (neg.title_missing_term && term) parts.push('Say “' + term + '” in the title');
    if (neg.description_too_long) parts.push('cut the search description to one sentence');
    else if (neg.description_missing) parts.push('write a one-sentence search description');
    if (neg.intro_missing) parts.push('add a short introduction');
    if (neg.h1_missing_term && term) parts.push('put “' + term + '” in the main heading');
    if (!parts.length) return null;
    var s = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1];
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** The question pre-filled into Ask SILO. It carries the evidence the page
   * showed, so the answer starts from the same facts; it is never sent
   * automatically. */
  function askSiloPrompt(group, facts) {
    var g = group || {}, f = facts || {};
    var lines = [];
    lines.push('Draft SEO improvements for our page ' + (g.path || g.title) + (g.kind === 'needs_page' ? ' (no page ranks yet)' : '') + '.');
    if (g.keywords && g.keywords.length) lines.push('Tracked keywords: ' + g.keywords.slice(0, 8).join(', ') + '.');
    if (g.bestRank) lines.push('Latest rank check: #' + g.bestRank.position + ' for "' + g.bestRank.keyword + '"' + (g.bestRank.device ? ' (' + g.bestRank.device + ')' : '') + '.');
    if (f.serpTitle) lines.push('Google shows our title as "' + f.serpTitle + '".');
    (f.found || []).filter(function (x) { return x.tone === 'neg'; }).forEach(function (x) { lines.push('- ' + x.title + (x.detail ? ' ' + x.detail : '')); });
    lines.push('Propose a new page title, a one-sentence search description, and (for a collection) a short introduction. Show the evidence for each, and do not publish anything.');
    return lines.join('\n');
  }

  /**
   * Where a page is in Review -> Draft -> Approve -> Measure, from the tasks
   * that target it and their publications. A rejected task does not advance
   * the page; the newest live task decides. Returns { step, task, label }.
   */
  var STEPS = ['review', 'draft', 'approve', 'measure'];
  function stepFor(tasks, publications) {
    var live = (Array.isArray(tasks) ? tasks : []).filter(function (t) { return t && t.approval_status !== 'rejected'; })
      .sort(function (a, b) { return str(b.created_at).localeCompare(str(a.created_at)); });
    var pubs = Array.isArray(publications) ? publications : [];
    var published = live.filter(function (t) { return pubs.some(function (p) { return p && p.task_id === t.id; }); })[0];
    if (published) return { step: 'measure', task: published, label: 'Published — measuring' };
    var approved = live.filter(function (t) { return t.approval_status === 'approved'; })[0];
    if (approved) return { step: 'approve', task: approved, label: 'Approved — not published yet' };
    var draft = live[0];
    if (draft) return { step: 'draft', task: draft, label: draft.approval_status === 'proposed' ? 'Proposed — waiting for approval' : 'Draft task open' };
    var rejected = (Array.isArray(tasks) ? tasks : []).some(function (t) { return t && t.approval_status === 'rejected'; });
    return { step: 'review', task: null, label: rejected ? 'A previous task was rejected' : 'Not started' };
  }

  /** Which product photos stand for a collection: the NEWEST LIVE products
   * first. Live on the website is shopify_status 'active' AND a non-null
   * online_published_at (products_master's is_active says nothing), and the
   * newest publication is the most recent release -- what the collection
   * looks like now. `productIds` is the collection's own membership in
   * position order; rows are products_master rows (one or more per product,
   * one per SKU). When nothing in the collection is live, position order
   * stands in rather than a blank tile. https images only; one photo per
   * product. */
  function pickCollectionPhotos(productIds, rows, n) {
    var limit = n == null ? 3 : n;
    var order = {};
    (Array.isArray(productIds) ? productIds : []).forEach(function (id, i) {
      var k = String(id); if (!(k in order)) order[k] = i;
    });
    var best = {};
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r || !/^https:\/\//.test(r.image_url || '')) return;
      var id = String(r.shopify_product_id);
      if (!(id in order)) return;
      var live = r.shopify_status === 'active' && !!r.online_published_at;
      var t = live ? Date.parse(r.online_published_at) : NaN;
      var cand = { id: id, product_title: r.product_title || null, image_url: r.image_url, live: live && isFinite(t), published_at: live && isFinite(t) ? r.online_published_at : null, t: isFinite(t) ? t : null };
      var cur = best[id];
      if (!cur || (cand.live && (!cur.live || cand.t > cur.t))) best[id] = cand;
    });
    var all = Object.keys(best).map(function (k) { return best[k]; });
    var live = all.filter(function (x) { return x.live; })
      .sort(function (a, b) { return b.t - a.t || order[a.id] - order[b.id]; });
    var pool = live.length ? live : all.sort(function (a, b) { return order[a.id] - order[b.id]; });
    return pool.slice(0, limit).map(function (x) {
      return { shopify_product_id: x.id, product_title: x.product_title, image_url: x.image_url, published_at: x.published_at };
    });
  }

  var API = {
    STEPS: STEPS,
    stepFor: stepFor,
    DESCRIPTION_SHOWN_CHARS: DESCRIPTION_SHOWN_CHARS,
    pageKey: pageKey,
    pathKind: pathKind,
    collectionHandle: collectionHandle,
    productHandle: productHandle,
    titleFromPath: titleFromPath,
    bestEvidence: bestEvidence,
    groupByPage: groupByPage,
    leadKeyword: leadKeyword,
    rankRange: rankRange,
    pageStats: pageStats,
    aboveUs: aboveUs,
    ourObservedTitle: ourObservedTitle,
    descriptionFacts: descriptionFacts,
    headTerm: headTerm,
    findings: findings,
    headline: headline,
    askSiloPrompt: askSiloPrompt,
    pickCollectionPhotos: pickCollectionPhotos,
  };
  if (typeof window !== 'undefined') window.SiloSeoStudio = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
