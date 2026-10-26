import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Tests run against the bridge's sources, so it needs no build first.
export default defineConfig({
  resolve: { alias: { "@productivehub/ai-bridge": fileURLToPath(new URL("../bridge/src/index.ts", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"] },
});
