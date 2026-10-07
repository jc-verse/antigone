import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./app/services/db/schema.ts",
  dbCredentials: { url: "file:/data/antigone.sqlite3" },
});
