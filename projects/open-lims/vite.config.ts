// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const isBuild = process.argv.includes("build");

export default defineConfig({
  vite: {
    // Lovable deployments may carry Clerk's Next.js-style public key name. Vite only exposes
    // VITE_* variables by default, so explicitly allow this one compatibility prefix.
    envPrefix: ["VITE_", "NEXT_PUBLIC_"],
    // Vite's SSR runner cannot evaluate Fluent's CommonJS entry directly (it throws
    // "exports is not defined"), so the dep optimizer must prebundle it first;
    // top-level optimizeDeps applies to the client only.
    ssr: {
      // Production builds must inline every dependency. Fluent's CommonJS packages keep
      // runtime require() calls for anything left external (react, @griffel/react, ...),
      // which then resolve to node_modules' React while nitro inlines its own copy into
      // the server output; FluentProvider's useContext reads a null dispatcher and every
      // SSR page 500s. Dev keeps the default because Vite's dev SSR runner cannot
      // evaluate raw CommonJS ("module is not defined").
      noExternal: isBuild ? true : ["@fluentui/react-components"],
      optimizeDeps: {
        include: ["@fluentui/react-components"],
        // esbuild would otherwise inline a second copy of React into the prebundled
        // Fluent chunk. That copy never receives the hook dispatcher react-dom sets
        // during SSR, so FluentProvider's useContext reads null and the render dies
        // with "Invalid hook call". Keeping these external makes Fluent share the
        // app's React instance.
        exclude: ["react", "react-dom"],
      },
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
