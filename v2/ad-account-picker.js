/* Which account / property / site an ad-platform connection should sync.
 *
 * test-ad-platform-connection lists what an authorization can reach, in a
 * different shape per platform. These rules turn that into one list of
 * choices for Integrations' picker, and say the value to store -- the same
 * value the nightly sync reads, so a click can never store something a
 * person would have had to reformat by hand:
 *   google_ads      customers/1234567890  -> 1234567890 (sync strips dashes anyway)
 *   ga4             properties/123456789  -> 123456789  (sync strips the prefix anyway)
 *   search_console  the site URL VERBATIM (a URL-prefix property and a domain
 *                   property cover different traffic; never normalised)
 *   meta_ads        act_123               -> act_123
 *   tiktok_ads      advertiser id as-is
 * A Search Console property the account has not verified is listed but not
 * selectable: Google refuses its performance data.
 *
 * Browser: window.SiloAdPicker. Node: module.exports (scripts/tests). */
(function (root) {
  const FIELD = {
    google_ads: 'google_customer_id', ga4: 'ga4_property_id', search_console: 'search_console_site_url',
    meta_ads: 'meta_ad_account_id', tiktok_ads: 'tiktok_advertiser_id',
  };
  const NOUN = {
    google_ads: 'Google Ads account', ga4: 'GA4 property', search_console: 'Search Console property',
    meta_ads: 'Meta ad account', tiktok_ads: 'TikTok advertiser',
  };
  const str = (v) => (v == null ? '' : String(v));
  const fmtCustomer = (d) => (/^\d{10}$/.test(d) ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d);

  function options(platform, data) {
    const d = data || {};
    if (platform === 'google_ads') {
      return (d.accessible_customers || []).map((r) => {
        const id = str(r).replace(/^customers\//, '');
        return { value: id, label: fmtCustomer(id), sub: 'Google Ads customer', disabled: false };
      }).filter((o) => o.value);
    }
    if (platform === 'ga4') {
      return (d.properties || []).map((p) => {
        const id = str(p.property).replace(/^properties\//, '');
        return { value: id, label: str(p.display_name) || id, sub: [str(p.account), id].filter(Boolean).join(' · '), disabled: false };
      }).filter((o) => o.value);
    }
    if (platform === 'search_console') {
      return (d.sites || []).map((s) => ({
        value: str(s.site_url),
        label: str(s.site_url),
        sub: s.readable === false ? 'not verified for this Google account — Google will not share its data'
          : str(s.permission_level).replace(/^site/, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
        disabled: s.readable === false,
      })).filter((o) => o.value);
    }
    if (platform === 'meta_ads') {
      return (d.ad_accounts || []).map((a) => ({
        value: str(a.id), label: str(a.name) || str(a.id), sub: [str(a.id), str(a.currency)].filter(Boolean).join(' · '), disabled: false,
      })).filter((o) => o.value);
    }
    if (platform === 'tiktok_ads') {
      return (d.advertiser_ids || []).map((id) => ({ value: str(id), label: str(id), sub: 'TikTok advertiser', disabled: false }))
        .filter((o) => o.value);
    }
    return [];
  }

  /** The one choice to make without asking: exactly one selectable option.
   *  Two or more always ask -- guessing which property is the business is the
   *  mistake the picker exists to prevent. */
  function autoPick(opts) {
    const live = (opts || []).filter((o) => !o.disabled);
    return live.length === 1 ? live[0] : null;
  }

  /** The row update a choice makes: the account field, and sync switched on,
   *  because choosing what to sync is the decision to sync it. */
  function patchFor(platform, option) {
    const field = FIELD[platform];
    if (!field || !option || option.disabled || !option.value) return null;
    return { [field]: option.value, sync_enabled: true };
  }

  const api = { FIELD, NOUN, options, autoPick, patchFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SiloAdPicker = api;
})(typeof window !== 'undefined' ? window : globalThis);
