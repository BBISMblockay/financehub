import { runArSync } from "./ar-sync.mjs";

async function main() {
  try {
    const result = await runArSync();
    console.log("AR sync complete:");
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error("AR sync failed:");
    console.error(err);
    process.exit(1);
  }
}

main();
