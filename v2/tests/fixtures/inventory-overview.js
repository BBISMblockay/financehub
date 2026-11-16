/* Entirely synthetic: never production names, identifiers, or balances.
 *
 * The Overview reads five aggregates through chat_run_readonly_query, so the
 * stub below dispatches on WHICH aggregate the SQL is, and records every query
 * text on window.__SQL__ so a suite can assert that a filter reached the SQL.
 *
 * RPC fixtures are stringified and rebuilt inside the page (see the harness),
 * so this function closes over nothing and declares its own rows. */
'use strict';
const companyId = 'test-company';

const fixtures = () => ({
  company_settings: [{ company_entity_id: companyId, default_currency: 'USD' }],
});

const rpc = {
  silo_business_today: () => '2026-11-16',
  chat_run_readonly_query: (args) => {
    const sql = (args && args.query) || '';
    window.__SQL__ = (window.__SQL__ || []).concat([sql]);
    const at = '2026-11-15T15:10:00Z';
    const byLocation = [
      { loc: 'Web store', loc_key: 'web_store', bucket: 'deep', as_of: at, row_count: 4, units: 900, value: 90000, stale_value: 4000 },
      { loc: 'Web store', loc_key: 'web_store', bucket: 'ok', as_of: at, row_count: 6, units: 300, value: 30000, stale_value: 0 },
      { loc: 'Web store', loc_key: 'web_store', bucket: 'low', as_of: at, row_count: 9, units: 45, value: 4500, stale_value: 500 },
      { loc: 'Web store', loc_key: 'web_store', bucket: 'out', as_of: at, row_count: 30, units: 0, value: 0, stale_value: 0 },
      { loc: 'Web store', loc_key: 'web_store', bucket: 'neg', as_of: at, row_count: 2, units: -20, value: -2000, stale_value: 0 },
      { loc: 'North shop', loc_key: 'north_shop', bucket: 'ok', as_of: at, row_count: 3, units: 120, value: 12000, stale_value: 0 },
      { loc: 'North shop', loc_key: 'north_shop', bucket: 'out', as_of: at, row_count: 11, units: 0, value: 0, stale_value: 0 },
    ];
    const byType = [
      { ptype: 'Tees', bucket: 'deep', row_count: 4, units: 900, value: 90000, stale_value: 4000 },
      { ptype: 'Tees', bucket: 'low', row_count: 4, units: 20, value: 2000, stale_value: 500 },
      { ptype: 'Caps', bucket: 'ok', row_count: 9, units: 420, value: 42000, stale_value: 0 },
      { ptype: 'Socks', bucket: 'low', row_count: 5, units: 25, value: 2500, stale_value: 0 },
    ];
    const bySku = [
      { bucket: 'deep', skus: 4, multi_location: 2 },
      { bucket: 'ok', skus: 9, multi_location: 3 },
      { bucket: 'low', skus: 12, multi_location: 1 },
      { bucket: 'out', skus: 41, multi_location: 0 },
      { bucket: 'neg', skus: 2, multi_location: 0 },
    ];
    const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
    const holdings = [
      { product_title: 'Sample Tee', img: pixel, units: 600, value: 60000 },
      { product_title: 'Sample Cap', img: pixel, units: 300, value: 30000 },
    ];
    // One overdue month, this month, one ahead, and a line with no date.
    const inbound = [
      { month: '2026-09', pos: 1, units: 1000, est_cost: 5000 },
      { month: '2026-11', pos: 2, units: 2000, est_cost: 9000 },
      { month: '2026-12', pos: 1, units: 500, est_cost: 2500 },
      { month: null, pos: 1, units: 40, est_cost: 100 },
    ];
    const typeFiltered = /= 'Caps'/.test(sql);
    const locFiltered = /location_tag = 'north_shop'/.test(sql);
    if (/as loc_key/.test(sql)) {
      if (locFiltered) return byLocation.filter((r) => r.loc_key === 'north_shop');
      if (typeFiltered) return byLocation.filter((r) => r.bucket === 'ok');
      return byLocation;
    }
    if (/as ptype/.test(sql)) return typeFiltered ? byType.filter((r) => r.ptype === 'Caps') : byType;
    if (/as skus/.test(sql)) return bySku;
    if (/product_image_url/.test(sql)) return holdings;
    if (/v_po_incoming_lines/.test(sql)) return inbound;
    return [];
  },
};

module.exports = { fixtures, rpc, companyId };
