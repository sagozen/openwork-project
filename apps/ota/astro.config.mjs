import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import appShell from "@templatedesign/app-shell/integration";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  site: "https://ota-multiplatform.zhst.app",
  server: { host: "127.0.0.1", port: 4330 },
  adapter: cloudflare({
    imageService: "passthrough",
    remoteBindings: false,
    persistState: true,
  }),
  integrations: [react(), appShell()],
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
