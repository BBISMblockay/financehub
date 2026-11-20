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
 *   amazon_ads      profile id AND its region, which travel together
 * A Search Console property the account has not verified is listed but not
 * selectable: Google refuses its performance data.
 *
 * Browser: window.SiloAdPicker. Node: module.exports (scripts/tests). */
(function (root) {
  const FIELD = {
    google_ads: 'google_customer_id', ga4: 'ga4_property_id', search_console: 'search_console_site_url',
    meta_ads: 'meta_ad_account_id', tiktok_ads: 'tiktok_advertiser_id',
    amazon_ads: 'amazon_profile_id',
  };
  const NOUN = {
    google_ads: 'Google Ads account', ga4: 'GA4 property', search_console: 'Search Console property',
    meta_ads: 'Meta ad account', tiktok_ads: 'TikTok advertiser',
    amazon_ads: 'Amazon advertising account',
    meta_pages: 'Facebook Page',
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
    // Not a platform: the Facebook Page (and the Instagram business account
    // linked to it) that the SAME meta_ads connection reads for organic. The
    // two ids always travel together -- Meta hands the Instagram account out
    // only through its Page -- so they are one choice, not two fields. A Page
    // with no linked Instagram account is still selectable: its Page insights
    // are worth syncing on their own.
    if (platform === 'meta_pages') {
      return (d.pages || []).map((p) => ({
        value: str(p.page_id),
        igValue: str(p.instagram_business_account_id) || null,
        label: str(p.page_name) || str(p.page_id),
        sub: [
          str(p.page_id),
          p.instagram_business_account_id
            ? 'Instagram ' + (p.instagram_username ? '@' + str(p.instagram_username) : str(p.instagram_business_account_id))
            : 'no linked Instagram account',
        ].filter(Boolean).join(' · '),
        disabled: false,
      })).filter((o) => o.value);
    }
    // Amazon profiles carry their REGION, and the two are stored together:
    // Amazon has three independent API hosts and a profile exists behind
    // exactly one of them, so a profile id without its region is not enough
    // to make a single request. The label leads with the account name where
    // Amazon gives one -- its own spec says the name is "not currently
    // populated for sellers", so the country and marketplace carry the row
    // when it is blank, rather than leaving a bare profile number.
    if (platform === 'amazon_ads') {
      return (d.amazon_profiles || []).map((p) => {
        const id = str(p && p.profile_id);
        const region = str(p && p.region).toUpperCase();
        const country = str(p && p.country_code);
        const type = str(p && p.account_type);
        return {
          value: id,
          region,
          label: str(p && p.account_name) || [country, type].filter(Boolean).join(' ') || id,
          sub: [country, region, type, id].filter(Boolean).join(' · '),
          // A profile with no region cannot be synced, so it is shown and
          // refused rather than offered as a choice that silently never runs.
          disabled: !region,
        };
      }).filter((o) => o.value);
    }
    if (platform === 'tiktok_ads') {
      // `advertisers` carries names (/oauth2/advertiser/get/); advertiser_ids
      // is the nameless fallback from the grant itself. Nineteen digits tell
      // nobody which account is theirs, so the name leads when there is one.
      if (Array.isArray(d.advertisers) && d.advertisers.length) {
        return d.advertisers.map((a) => ({
          value: str(a && a.advertiser_id),
          label: str(a && a.advertiser_name) || str(a && a.advertiser_id),
          sub: str(a && a.advertiser_name) ? str(a && a.advertiser_id) : 'TikTok advertiser',
          disabled: false,
        })).filter((o) => o.value);
      }
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
    if (!option || option.disabled || !option.value) return null;
    // A Page choice writes BOTH organic ids, blanking Instagram when the
    // chosen Page has none: leaving the previous Page's Instagram id behind
    // would have the nightly sync pull one business's Instagram against
    // another's Page. It does NOT touch sync_enabled -- organic rides the ad
    // connection's own setting, and a Page choice is not a decision to start
    // syncing ads.
    if (platform === 'meta_pages') {
      return { facebook_page_id: option.value, instagram_business_account_id: option.igValue || null };
    }
    // Amazon writes the region with the profile, for the reason given in
    // options(): either both or neither is usable, so they are one choice.
    if (platform === 'amazon_ads') {
      if (!option.region) return null;
      return { amazon_profile_id: option.value, amazon_region: option.region, sync_enabled: true };
    }
    const field = FIELD[platform];
    if (!field) return null;
    return { [field]: option.value, sync_enabled: true };
  }

  const api = { FIELD, NOUN, options, autoPick, patchFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SiloAdPicker = api;
})(typeof window !== 'undefined' ? window : globalThis);
