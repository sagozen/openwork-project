import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { mytutorLmsPlugin } from "@mytutor/plugin-mytutor-lms";

export default defineConfig({
  output: "server",
  outDir: "./dist-cloudflare",
  adapter: cloudflare(),
  integrations: [
    react(),
    emdash({
      database: d1({ binding: "DB" }),
      storage: r2({ binding: "MEDIA" }),
      plugins: [mytutorLmsPlugin()],
    }),
  ],
  vite: {
    resolve: { dedupe: ["react", "react-dom", "emdash", "kysely"] },
    // Preserve Kysely's circular module initialization, as in the community Worker hosts.
    environments: {
      ssr: { build: { rolldownOptions: { output: { strictExecutionOrder: true } } } },
    },
  },
  devToolbar: { enabled: false },
});
