import * as dotenv from "dotenv";
// Load .env.local first (Vercel-provisioned vars take precedence), then .env
dotenv.config({ path: ".env.local", override: true });
dotenv.config({ path: ".env" });
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL_UNPOOLED"] ?? process.env["DATABASE_URL"],
  },
});
