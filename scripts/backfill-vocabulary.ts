import "dotenv/config";
import { createDb } from "@/db/client";
import { backfillVocabularies } from "@/server/services/intent/store";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const handle = createDb(url);
try {
  const built = await backfillVocabularies(handle.db);
  console.log(`Vocabulary built for ${built} store(s)`);
} finally {
  await handle.close();
}
