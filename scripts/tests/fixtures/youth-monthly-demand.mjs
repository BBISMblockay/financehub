// Baseballism's REAL Youth monthly unit demand, read from production on
// 2026-09-17 with:
//
//   select month_start, sum(units)
//   from sales_monthly_product_type_rollup_mv
//   where company_entity_id = '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
//     and product_type = 'Youth'
//   group by 1 order by 1;
//
// It is real rather than synthetic because the thing it is used to prove is a
// REPRODUCTION: the 20.2% WAPE / -13.9% bias the specification quotes, arrived
// at from source data and through the shipped SQL, not asserted from a
// hand-built series chosen to produce it.
//
// Three properties of this series matter and are all deliberate:
//   * MONTHS ARE MISSING before 2023 (2018-02, 2018-05, 2018-07..09, ...).
//     The rollup emits a row only where the sync recorded something, so an
//     absent month is "no data", never "no sales" -- which is what makes
//     early cutoffs INELIGIBLE rather than quietly forecast from a short sum.
//   * 2021-01 is a recorded ZERO. It is data and is kept as zero.
//   * Twelve months are NEGATIVE (returns exceeding sales). A negative window
//     cannot be a ratio denominator and a negative month cannot be a forecast
//     base; both are refused rather than clamped or floored.
//
// 2026-09 is a PARTIAL month (production was synced through 2026-09-16) and is
// present so the maturity clock has something to refuse.
export const YOUTH_MONTHLY_DEMAND = [
  ['2017-11-01', 103], ['2017-12-01', -1], ['2018-01-01', 13], ['2018-03-01', 12],
  ['2018-04-01', 87], ['2018-06-01', 51], ['2018-10-01', 2], ['2019-01-01', 16],
  ['2019-03-01', 10], ['2019-04-01', 7], ['2019-05-01', -1], ['2019-06-01', 12],
  ['2019-07-01', -1], ['2019-10-01', 2], ['2019-11-01', 782], ['2019-12-01', -19],
  ['2020-01-01', -8], ['2020-02-01', -1], ['2020-03-01', -1], ['2020-04-01', 184],
  ['2020-05-01', 15], ['2020-06-01', 36], ['2020-08-01', -1], ['2020-11-01', 348],
  ['2020-12-01', 8], ['2021-01-01', 0], ['2021-02-01', 31], ['2021-03-01', -1],
  ['2021-04-01', -1], ['2021-10-01', 13], ['2021-11-01', 376], ['2021-12-01', 29],
  ['2022-01-01', 17], ['2022-02-01', 8], ['2022-03-01', -1], ['2022-04-01', 39],
  ['2022-05-01', 8], ['2022-06-01', 39], ['2022-07-01', -1], ['2022-11-01', 1415],
  ['2022-12-01', 136], ['2023-01-01', 117], ['2023-02-01', 192], ['2023-03-01', 839],
  ['2023-04-01', 537], ['2023-05-01', 816], ['2023-06-01', 2032], ['2023-07-01', 1287],
  ['2023-08-01', 1136], ['2023-09-01', 1068], ['2023-10-01', 583], ['2023-11-01', 1821],
  ['2023-12-01', 263], ['2024-01-01', 88], ['2024-02-01', 610], ['2024-03-01', 947],
  ['2024-04-01', 967], ['2024-05-01', 761], ['2024-06-01', 1207], ['2024-07-01', 1233],
  ['2024-08-01', 5231], ['2024-09-01', 1688], ['2024-10-01', 2325], ['2024-11-01', 10575],
  ['2024-12-01', 2250], ['2025-01-01', 3002], ['2025-02-01', 6449], ['2025-03-01', 6421],
  ['2025-04-01', 10525], ['2025-05-01', 9559], ['2025-06-01', 13219], ['2025-07-01', 38324],
  ['2025-08-01', 7581], ['2025-09-01', 4297], ['2025-10-01', 9097], ['2025-11-01', 53807],
  ['2025-12-01', 16886], ['2026-01-01', 11100], ['2026-02-01', 28139], ['2026-03-01', 25650],
  ['2026-04-01', 17579], ['2026-05-01', 13104], ['2026-06-01', 24049], ['2026-07-01', 74190],
  ['2026-08-01', 17460], ['2026-09-01', 8625],
];

// Production's sync coverage on the day the series above was read. The last
// day of August is covered, September is not -- which is exactly why the
// 2026-09-01 cutoff is forecastable and not yet scorable.
export const SYNCED_THROUGH = '2026-09-16';

// The first frozen run recorded in the source report, reproduced from the
// series above: Jun-Aug 2026 = 115,699; Jun-Aug 2025 = 59,124; Sep 2025 = 4,297;
// raw ratio 1.9569 exceeds the 1.80 cap; 4,297 * 1.80 = 7,734.6 -> 7,735.
export const FROZEN_FIRST_RUN = Object.freeze({
  cutoff: '2026-09-01',
  recentDemand: 115699,
  priorDemand: 59124,
  priorYearTargetDemand: 4297,
  clampedRatio: 1.80,
  forecastQty: 7735,
});

// Measured against production on 2026-09-17 by applying the candidate
// retrospectively. The first is the figure the specification quotes; the other
// two are the same rule over longer windows, and the spread between them is
// the reason the candidate is being evaluated prospectively rather than
// adopted on the strength of a backtest.
export const RETROSPECTIVE_SCORES = Object.freeze({
  '2026-03-01..2026-08-01': { cutoffs: 6, wapePct: 20.2, biasPct: -13.9 },
  '2025-09-01..2026-08-01': { cutoffs: 12, wapePct: 37.5, biasPct: -33.8 },
  // 31, not 32: the 2024-01-01 cutoff is INELIGIBLE because its prior-year
  // window (2022-10..2022-12) is missing 2022-10 entirely, and an absent month
  // is not a zero. A first pass at this figure summed the two months that were
  // there and reported 32 cutoffs at 49.7% -- which is the exact mistake the
  // eligibility rule exists to prevent, made while measuring the rule.
  '2024-01-01..2026-08-01': { cutoffs: 31, wapePct: 49.6, biasPct: -44.9 },
});
