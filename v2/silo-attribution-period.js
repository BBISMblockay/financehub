/* Date presets for the Attribution filter bar.

   Pure string arithmetic on YYYY-MM-DD, deliberately: the page already slices
   ISO dates, and going through a local Date would shift a boundary by a day for
   anyone west of UTC. Date.parse of a bare date is UTC midnight, so adding
   whole days to it is exact.

   Every preset is anchored on the newest day the sync has actually COLLECTED,
   not on today. Anchoring on today would open the report on a day that has no
   data yet and read as a crash in sales. */
export const shiftDay = (day, n) => new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10);
const firstOfMonth = (day) => day.slice(0, 8) + '01';

export const PERIODS = ['7', '30', '90', 'mtd', 'lastmonth', 'custom'];

/* Returns {start, end} for a preset, or null for 'custom' and anything
   unrecognised -- a null means "leave the dates alone", which is what keeps a
   URL carrying explicit dates from being overwritten by a preset. */
export function periodRange(preset, anchorDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(anchorDay || ''))) return null;
  const days = { 7: 7, 30: 30, 90: 90 }[preset];
  if (days) return { start: shiftDay(anchorDay, -(days - 1)), end: anchorDay };
  if (preset === 'mtd') return { start: firstOfMonth(anchorDay), end: anchorDay };
  if (preset === 'lastmonth') {
    const end = shiftDay(firstOfMonth(anchorDay), -1);
    return { start: firstOfMonth(end), end };
  }
  return null;
}

/* Which preset a given range IS, so the control reflects dates that arrived
   from a URL or from typing instead of silently claiming the default. */
export function matchPeriod(start, end, anchorDay) {
  for (const preset of PERIODS) {
    const range = periodRange(preset, anchorDay);
    if (range && range.start === start && range.end === end) return preset;
  }
  return 'custom';
}
