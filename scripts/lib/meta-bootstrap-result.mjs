// Bootstrap success means paid ad rows landed, not merely campaign totals.
// Zero rows is valid provider evidence; a missing result is not.
export function assertMetaBootstrapComplete(result, { skipOrganic = false } = {}) {
  if (!result?.ad_level || result.ad_level.error
    || !Number.isFinite(result.ad_level.ad_rows_upserted)) {
    throw new Error(`Meta initial import incomplete: ad-level data did not finish${result?.ad_level?.error ? ': ' + result.ad_level.error : ''}`);
  }
  if (!skipOrganic && (!result.organic || result.organic.skipped
    || result.organic.error || result.organic.page_error)) {
    throw new Error(`Meta initial import incomplete: organic history did not finish${result?.organic?.error || result?.organic?.page_error ? ': ' + (result.organic.error || result.organic.page_error) : ''}`);
  }
}
