// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "@core/schema/index.js";

await migrate(db, { migrationsFolder: "./drizzle" });
console.log("migrations applied");
await sql.end();
