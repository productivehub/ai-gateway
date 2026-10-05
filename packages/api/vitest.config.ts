import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bridgeSource = fileURLToPath(new URL("../../../ai-bridge/src/index.ts", import.meta.url));
export default defineConfig({
  // Workspace tests need no emitted dependency; extracted packages use installed bridge.
  resolve: { alias: existsSync(bridgeSource) ? { "@productivehub/ai-bridge": bridgeSource } : {} },
  test: { include: ["test/**/*.test.ts"] },
});
