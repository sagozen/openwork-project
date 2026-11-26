import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  site: "https://transcriptanything.zhst.app",
  server: { host: "127.0.0.1", port: 4323 },
  adapter: cloudflare({
    imageService: "passthrough",
    remoteBindings: false,
    persistState: true,
  }),
  integrations: [react()],
  vite: {
    resolve: {
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      exclude: ["better-auth", "@better-auth/kysely-adapter"],
    },
    ssr: {
      noExternal: ["better-auth"],
    },
  },
});
