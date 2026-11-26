import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  site: "https://imagefactory.zhst.app",
  server: { host: "127.0.0.1", port: 4334 },
  // OAuth clients post form-encoded token requests from their own servers; Astro's same-origin form
  // check would reject them. The middleware and the agent API enforce CSRF on the routes that need it.
  security: { checkOrigin: false },
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
