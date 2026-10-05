import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const bridgeSource = source("../../../ai-bridge/src/index.ts");
export default defineConfig({
  // Tests run against sibling sources, so neither the api nor the bridge needs a build first.
  resolve: {
    alias: [
      { find: /^@productivehub\/ai-gateway-api$/, replacement: source("../api/src/index.ts") },
      { find: /^@productivehub\/ai-gateway-api\/listener$/, replacement: source("../api/src/listener.ts") },
      ...(existsSync(bridgeSource) ? [{ find: /^@productivehub\/ai-bridge$/, replacement: bridgeSource }] : []),
    ],
  },
  test: { include: ["test/**/*.test.ts"] },
});
