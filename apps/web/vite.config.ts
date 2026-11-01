// SPDX-License-Identifier: AGPL-3.0-only

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Read the workspace packages from their TypeScript source.
    conditions: ["@nortfox/source", ...defaultClientConditions],
  },
  server: {
    proxy: {
      "/v1": "http://localhost:4100",
    },
  },
});
