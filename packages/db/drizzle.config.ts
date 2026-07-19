import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://empire:empire@localhost:5432/empire",
  },
  // Prod migrations are forward-only (tech spec CI/CD); rollback = pg_dump restore.
  strict: true,
});
