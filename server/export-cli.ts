import { databasePath, loadConfig } from "./config.ts";
import { RatingStore } from "./db.ts";
import { buildRatingsCsv, buildRatingsJsonl } from "./export.ts";

const format = process.argv[2] ?? "csv";
if (format !== "csv" && format !== "jsonl") {
  console.error("使い方: npm run export -- [csv|jsonl] > ratings.csv");
  process.exit(2);
}

const store = RatingStore.open(databasePath(loadConfig()));
try {
  const rows = store.exportRows();
  process.stdout.write(format === "csv" ? buildRatingsCsv(rows) : buildRatingsJsonl(rows));
} finally {
  store.close();
}
