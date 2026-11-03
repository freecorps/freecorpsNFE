import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { thirdPartyNotices } from "../../scripts/lib/bundle-notices.mjs";
import { shadersPlugin } from "./shaders-plugin.ts";
import { publicSitePlugin } from "./site-plugin.ts";
import { worktreePlugin } from "./worktree-plugin.ts";
import { zxingPlugin } from "./zxing-plugin.ts";

export default defineConfig({
  plugins: [
    react(),
    publicSitePlugin(),
    shadersPlugin(),
    worktreePlugin(),
    zxingPlugin(),
    thirdPartyNotices("third-party-notices.txt"),
  ],
  build: {
    sourcemap: false,
    // The console's small modules shared by two or more chunks (the `ui/` controls, formatters,
    // the company picker, the product components) travel in one chunk instead of a dozen of a
    // few hundred bytes each. A page's first visit fetched those in rounds: a browser opens six
    // connections per host on HTTP/1.1, and Empresas waited three rounds of chunks (and then
    // the router's 300 ms of minimum pending) before asking for its data. The entry grows about
    // 5 KB gzip. docs/v1.0/evidence/console-navegacao/README.md has the measurements.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "console-shared",
              test: /apps[\\/]console[\\/]src[\\/]/,
              minShareCount: 2,
              maxModuleSize: 8000,
            },
          ],
        },
      },
    },
  },
});
