import { mkdirSync } from "node:fs";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import { mytutorLmsPlugin } from "@mytutor/plugin-mytutor-lms";

// One data directory per site (deploy/sites/<site>/site.json); defaults to .data.
const dataDir = process.env.MYTUTOR_DATA_DIR || ".data";
mkdirSync(`${dataDir}/media`, { recursive: true, mode: 0o700 });
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [
    react(),
    emdash({
      database: sqlite({ url: `file:${dataDir}/emdash.db` }),
      storage: local({
        directory: `${dataDir}/media`,
        baseUrl: "/_emdash/api/media/file",
      }),
      plugins: [mytutorLmsPlugin()],
    }),
  ],
  vite: { resolve: { dedupe: ["react", "react-dom", "emdash", "kysely"] } },
  devToolbar: { enabled: false },
});
