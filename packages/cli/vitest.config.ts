import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  // Tests run against sibling sources, so neither the api nor the bridge needs a build first.
  resolve: {
    alias: [
      { find: /^@productivehub\/ai-gateway-api$/, replacement: source("../api/src/index.ts") },
      { find: /^@productivehub\/ai-gateway-api\/listener$/, replacement: source("../api/src/listener.ts") },
      { find: /^@productivehub\/ai-bridge$/, replacement: source("../bridge/src/index.ts") },
    ],
  },
  test: { include: ["test/**/*.test.ts"] },
});
