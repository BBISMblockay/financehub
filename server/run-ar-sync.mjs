import { runArSync } from "./ar-sync.mjs";

async function main() {
  let result;

  try {
    result = await runArSync();
    console.log("AR sync complete:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("AR sync failed:");
    console.error(err);
    process.exit(1);
  }

  // The rows synced fine, but the source sheet has stopped receiving new
  // orders — fail the workflow so someone notices, instead of a green run
  // over weeks-stale data.
  if (result.stale) {
    const newest = result.newest_order_date || "unknown";
    const age = result.staleness_days == null ? "?" : result.staleness_days;
    console.error(
      `::error::AR source sheet is STALE: newest order is ${newest} (${age} days old, threshold ${result.stale_threshold_days}). ` +
        `The sync itself succeeded — the scheduled report feeding the AR Google Sheet has stopped adding new orders. ` +
        `Check its filters/date range in Shopify (see docs/ops/when-something-breaks.md).`
    );
    process.exit(1);
  }

  process.exit(0);
}

main();
