import { testDatabaseUrl } from "./helpers/test-db-url";

const url = testDatabaseUrl();
process.env.TEST_DATABASE_URL = url;
process.env.DATABASE_URL = url;
